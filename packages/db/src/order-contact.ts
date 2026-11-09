// DB-6 (lead ruling): admin contact/address edit of an order, one version-guarded D1 batch.
//   - re-normalises the phone with @hb/shared normalizePhone;
//   - re-links the customer (find-or-create by phone, moving order_count) when the phone changes;
//   - re-quotes the fee through a FeeProvider when the wilaya or commune changes, and writes
//     fee_dzd, total_dzd (= subtotal + fee, as computeTotals) and fee_source;
//   - logs an order_events note (`contact_edit`, which fields changed: names only, no values);
//   - every statement is guarded by `orders.id = :id AND version = :v`, the version bump last.
import { and, eq, sql } from 'drizzle-orm';
import { buildQuote, normalizePhone, type AdminRole, type FeeProvider, type OrderStatus } from '@hb/shared';
import { normalizeName } from '@hb/shared/name';
import { communes, customers, orderEvents, orderItems, orders, variants } from './schema.ts';
import { classifyConstraintError, guardedInsertSelect, orderGuard, type OrderBatchItem } from './orders.ts';
import type { Db } from './index.ts';

export interface OrderContactPatch {
  readonly name?: string;
  /** Any accepted input form (0…, +213…, Eastern Arabic digits); stored as E.164. */
  readonly phone?: string;
  readonly address?: string | null;
  /** Wilaya and commune move together; the commune must belong to the wilaya. */
  readonly wilayaCode?: number;
  readonly communeId?: number;
}

export type UpdateOrderContactResult =
  | { readonly ok: true; readonly version: number; readonly feeDzd: number; readonly totalDzd: number; readonly feeSource: string }
  | {
      readonly ok: false;
      readonly code:
        | 'not_found'
        | 'version_conflict'
        | 'forbidden'
        | 'not_editable'
        | 'phone_invalid'
        | 'name_required'
        | 'name_invalid'
        | 'commune_invalid'
        | 'area_unavailable'
        | 'order_total_out_of_range'
        | 'nothing_to_change'
        /** A parcel slot is open on this order (open-slot triggers, migration 0012); nothing was written. */
        | 'shipment_in_progress';
    };

/**
 * Who may edit contact data, and until when (lead decision, AORD-0 §0.4): the owner until the
 * parcel leaves; the confirmer only before the order is confirmed.
 */
export const CONTACT_EDIT_STATUSES: Readonly<Partial<Record<AdminRole, readonly OrderStatus[]>>> = {
  owner: ['new', 'called', 'unreachable', 'confirmed'],
  confirmer: ['new', 'called', 'unreachable'],
};
/** Every status in which someone may edit (anything else: `not_editable`). */
export const CONTACT_EDITABLE_STATUSES: readonly OrderStatus[] = ['new', 'called', 'unreachable', 'confirmed'];

export async function updateOrderContact(
  db: Db,
  orderId: number,
  patch: OrderContactPatch,
  feeProvider: FeeProvider,
  actor: { readonly userId: number; readonly role: AdminRole },
  expectedVersion: number,
  opts: { readonly now?: number; readonly extra?: readonly OrderBatchItem[] } = {},
): Promise<UpdateOrderContactResult> {
  const now = opts.now ?? Date.now();
  const allowed = CONTACT_EDIT_STATUSES[actor.role];
  if (!allowed) return { ok: false, code: 'forbidden' };

  const cur = (
    await db
      .select({
        id: orders.id,
        status: orders.status,
        version: orders.version,
        customerId: orders.customerId,
        name: orders.name,
        phoneE164: orders.phoneE164,
        address: orders.address,
        wilayaCode: orders.wilayaCode,
        communeId: orders.communeId,
        subtotalDzd: orders.subtotalDzd,
        feeDzd: orders.feeDzd,
        totalDzd: orders.totalDzd,
        feeSource: orders.feeSource,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
  )[0];
  if (!cur) return { ok: false, code: 'not_found' };
  if (cur.version !== expectedVersion) return { ok: false, code: 'version_conflict' };
  if (!CONTACT_EDITABLE_STATUSES.includes(cur.status)) return { ok: false, code: 'not_editable' };
  if (!allowed.includes(cur.status)) return { ok: false, code: 'forbidden' };

  // Phone
  let phoneE164 = cur.phoneE164;
  if (patch.phone !== undefined) {
    const p = normalizePhone(patch.phone);
    if (!p.ok) return { ok: false, code: 'phone_invalid' };
    phoneE164 = p.e164;
  }
  const phoneChanged = phoneE164 !== cur.phoneE164;
  let name = cur.name;
  if (patch.name !== undefined) {
    // The one order-name rule (@hb/shared normalizeName, SHARED-7): the same as the storefront's
    // NameSchema, so an edited order dedups and displays exactly like a new one (DB-6 r2).
    const n = normalizeName(patch.name);
    if (!n.ok) return { ok: false, code: n.code };
    name = n.value;
  }
  // A blank address is no address.
  const address = patch.address === undefined ? undefined : patch.address === null || patch.address.trim() === '' ? null : patch.address.trim();

  // Area + re-quote
  const wilayaCode = patch.wilayaCode ?? cur.wilayaCode;
  const communeId = patch.communeId ?? cur.communeId;
  const areaChanged = wilayaCode !== cur.wilayaCode || communeId !== cur.communeId;
  let feeDzd = cur.feeDzd;
  let totalDzd = cur.totalDzd;
  let feeSource: string = cur.feeSource;
  if (areaChanged) {
    const commune = (await db.select({ w: communes.wilayaCode }).from(communes).where(eq(communes.id, communeId)))[0];
    if (!commune || commune.w !== wilayaCode) return { ok: false, code: 'commune_invalid' };
    const lines = await db
      .select({ variantId: orderItems.variantId, qty: orderItems.qty, unitPriceDzd: orderItems.unitPriceDzd, weightG: variants.weightG })
      .from(orderItems)
      .innerJoin(variants, eq(variants.id, orderItems.variantId))
      .where(eq(orderItems.orderId, orderId));
    const fee = await feeProvider.quote({ wilayaCode, communeId, items: lines });
    if (!fee.available) return { ok: false, code: 'area_unavailable' };
    // @hb/shared buildQuote (SHARED-3 contract for any re-pricing): computeTotals plus the
    // MAX_ORDER_TOTAL_DZD ceiling. stock: null, since this order's stock was taken at creation.
    const q = buildQuote(lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPriceDzd: l.unitPriceDzd, stock: null })), fee);
    if (!q.ok) {
      if (q.code === 'order_total_out_of_range') return { ok: false, code: 'order_total_out_of_range' };
      // Any other code (e.g. out_of_stock for a line above MAX_QTY_PER_LINE) cannot happen without
      // line editing; never report it as "area unavailable" (DB-6 r1 nit).
      throw new Error(`updateOrderContact: buildQuote refused the stored lines (${q.code})`);
    }
    if (!q.available) return { ok: false, code: 'area_unavailable' };
    if (q.subtotalDzd !== cur.subtotalDzd) throw new Error(`updateOrderContact: stored subtotal ${cur.subtotalDzd} ≠ items ${q.subtotalDzd}`);
    feeDzd = q.feeDzd;
    totalDzd = q.totalDzd;
    feeSource = q.feeSource;
  }

  const changed = [
    patch.name !== undefined && name !== cur.name ? 'name' : null,
    phoneChanged ? 'phone' : null,
    address !== undefined && address !== cur.address ? 'address' : null,
    areaChanged ? 'area' : null,
    areaChanged && (feeDzd !== cur.feeDzd || feeSource !== cur.feeSource) ? 'fee' : null,
  ].filter((x): x is string => x !== null);
  if (changed.length === 0) return { ok: false, code: 'nothing_to_change' };

  const v = expectedVersion;
  const guard = orderGuard(orderId, v);
  const items: OrderBatchItem[] = [];
  if (phoneChanged) {
    // Find-or-create the new phone's customer and move this order's count to it.
    items.push(
      guardedInsertSelect(db, customers, { phone_e164: phoneE164, name, order_count: 1, created_at: now, updated_at: now }, sql`WHERE ${guard}`).onConflictDoUpdate({
        target: customers.phoneE164,
        set: { orderCount: sql`${customers.orderCount} + 1`, updatedAt: now },
      }),
      db
        .update(customers)
        .set({ orderCount: sql`max(${customers.orderCount} - 1, 0)`, updatedAt: now })
        .where(and(eq(customers.id, cur.customerId), guard)),
    );
  }
  items.push(
    guardedInsertSelect(
      db,
      orderEvents,
      { order_id: sql`id`, type: 'note', outcome: 'contact_edit', note: `changed: ${changed.join(', ')}`, actor_type: 'admin', actor_user_id: actor.userId, at: now },
      sql`FROM orders WHERE id = ${orderId} AND version = ${v}`,
    ),
  );
  items.push(...(opts.extra ?? []));
  items.push(
    db
      .update(orders)
      .set({
        name,
        phoneE164,
        customerId: phoneChanged ? sql`(SELECT id FROM customers WHERE phone_e164 = ${phoneE164})` : cur.customerId,
        ...(address !== undefined ? { address } : {}),
        wilayaCode,
        communeId,
        feeDzd,
        totalDzd,
        feeSource,
        version: sql`${orders.version} + 1`,
        updatedAt: now,
      })
      .where(and(eq(orders.id, orderId), eq(orders.version, v))),
  );

  let results: { meta?: { changes?: number } }[];
  try {
    results = (await db.batch(items as [OrderBatchItem, ...OrderBatchItem[]])) as unknown as { meta?: { changes?: number } }[];
  } catch (err) {
    if (classifyConstraintError(err) === 'shipment_in_progress') return { ok: false, code: 'shipment_in_progress' };
    throw err;
  }
  if ((results.at(-1)?.meta?.changes ?? 0) !== 1) {
    const still = (await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)))[0];
    return { ok: false, code: still ? 'version_conflict' : 'not_found' };
  }
  return { ok: true, version: v + 1, feeDzd, totalDzd, feeSource };
}
