// AORD-6 — contact/address edit: who may edit when, the form schema, the fee preview and the
// audit diff. The write is DB-6 `updateOrderContact` (packages/db/src/order-contact.ts): one
// version-guarded batch that re-normalises the phone, re-links the customer, re-quotes the fee
// through the same FeeProvider as /api/quote, and writes fee/total/fee_source.
// Rules: artifacts/AORD-0/plan.md §0.4 (confirmer before `confirmed`, owner until `shipped`).

import * as v from 'valibot';
import { asc, eq } from 'drizzle-orm';
import { communes, createAdminTableFeeProvider, orderItems, variants, type Db } from '@hb/db';
import { normalizePhone, type AdminRole, type FeeProvider, type OrderStatus } from '@hb/shared';
import { vInt, vOptionalText, vText } from '../../lib/forms.ts';
import type { RuntimeEnv } from '../../env.ts';

/** Statuses in which each role may edit contact data (stricter than DB-6's own check: both apply). */
const EDITABLE: Readonly<Record<AdminRole, readonly OrderStatus[]>> = {
  owner: ['new', 'called', 'unreachable', 'confirmed'],
  confirmer: ['new', 'called', 'unreachable'],
  logistics: [],
  content: [],
};

export function canEditContact(role: AdminRole, status: OrderStatus): boolean {
  return EDITABLE[role].includes(status);
}

/** The admin's FeeProvider: the one /api/quote uses. Placeholder (invented seed) fees only in development. */
export function feeProviderFor(db: Db, env: RuntimeEnv): FeeProvider {
  return createAdminTableFeeProvider(db, { allowPlaceholderFees: env === 'development' });
}

export const ContactForm = v.object({
  version: vInt(0, Number.MAX_SAFE_INTEGER),
  name: vText(120),
  phone: vText(32),
  wilaya: vInt(1, 69),
  commune: vInt(1, Number.MAX_SAFE_INTEGER),
  address: vOptionalText(300),
  /** Total shown on the review step; the save is refused (re-review) if the server's differs. */
  previewTotal: v.optional(v.string(), ''),
  step: v.optional(v.picklist(['review', 'save', 'edit']), 'review'),
});
export type ContactInput = v.InferOutput<typeof ContactForm>;

export interface ContactCurrent {
  name: string;
  phoneE164: string;
  address: string | null;
  wilayaCode: number;
  communeId: number;
  subtotalDzd: number;
  feeDzd: number;
  totalDzd: number;
  feeSource: string;
}

export type ContactErrKey =
  | 'contact.err.phone'
  | 'contact.err.commune'
  | 'contact.err.unavailable'
  | 'contact.err.nothing'
  | 'contact.err.priceChanged'
  | 'contact.err.notEditable';

export type ContactPreview =
  | {
      ok: true;
      phoneE164: string;
      areaChanged: boolean;
      feeDzd: number;
      totalDzd: number;
      feeSource: string;
      /** Field names that change (for the review table and the audit row). */
      changed: readonly ('name' | 'phone' | 'address' | 'area' | 'fee')[];
    }
  | { ok: false; errors: Partial<Record<'phone' | 'commune' | 'wilaya' | '_form', ContactErrKey>> };

/** Communes of one wilaya, for the select (ordered by name in the UI language). */
export function communesOf(db: Db, wilaya: number, lang: 'fr' | 'ar') {
  return db
    .select({ id: communes.id, nameFr: communes.nameFr, nameAr: communes.nameAr })
    .from(communes)
    .where(eq(communes.wilayaCode, wilaya))
    .orderBy(asc(lang === 'ar' ? communes.nameAr : communes.nameFr));
}

/**
 * What the save would do, computed the way DB-6 computes it (no write): phone normalised, commune
 * in wilaya, new fee from the FeeProvider when the area changes, total = stored subtotal + fee.
 */
export async function previewContact(
  db: Db,
  orderId: number,
  cur: ContactCurrent,
  input: ContactInput,
  fees: FeeProvider,
): Promise<ContactPreview> {
  const phone = normalizePhone(input.phone);
  if (!phone.ok) return { ok: false, errors: { phone: 'contact.err.phone' } };

  const areaChanged = input.wilaya !== cur.wilayaCode || input.commune !== cur.communeId;
  let feeDzd = cur.feeDzd;
  let feeSource = cur.feeSource;
  if (areaChanged) {
    const [c] = await db.select({ w: communes.wilayaCode }).from(communes).where(eq(communes.id, input.commune));
    if (!c || c.w !== input.wilaya) return { ok: false, errors: { commune: 'contact.err.commune' } };
    const items = await db
      .select({ variantId: orderItems.variantId, qty: orderItems.qty, unitPriceDzd: orderItems.unitPriceDzd, weightG: variants.weightG })
      .from(orderItems)
      .innerJoin(variants, eq(variants.id, orderItems.variantId))
      .where(eq(orderItems.orderId, orderId));
    const q = await fees.quote({ wilayaCode: input.wilaya, communeId: input.commune, items });
    if (!q.available) return { ok: false, errors: { wilaya: 'contact.err.unavailable' } };
    feeDzd = q.feeDzd;
    feeSource = q.source;
  }
  const changed = [
    input.name !== cur.name ? 'name' : null,
    phone.e164 !== cur.phoneE164 ? 'phone' : null,
    input.address !== cur.address ? 'address' : null,
    areaChanged ? 'area' : null,
    areaChanged && (feeDzd !== cur.feeDzd || feeSource !== cur.feeSource) ? 'fee' : null,
  ].filter((x): x is 'name' | 'phone' | 'address' | 'area' | 'fee' => x !== null);
  if (changed.length === 0) return { ok: false, errors: { _form: 'contact.err.nothing' } };
  return { ok: true, phoneE164: phone.e164, areaChanged, feeDzd, totalDzd: cur.subtotalDzd + feeDzd, feeSource, changed };
}

/** Audit before/after: only the fields that change, old and new values (Law 25-11 operations log). */
export function contactAudit(cur: ContactCurrent, input: ContactInput, p: Extract<ContactPreview, { ok: true }>) {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (p.changed.includes('name')) [before['name'], after['name']] = [cur.name, input.name];
  if (p.changed.includes('phone')) [before['phoneE164'], after['phoneE164']] = [cur.phoneE164, p.phoneE164];
  if (p.changed.includes('address')) [before['address'], after['address']] = [cur.address, input.address];
  if (p.areaChanged) {
    Object.assign(before, { wilayaCode: cur.wilayaCode, communeId: cur.communeId, feeDzd: cur.feeDzd, totalDzd: cur.totalDzd, feeSource: cur.feeSource });
    Object.assign(after, { wilayaCode: input.wilaya, communeId: input.commune, feeDzd: p.feeDzd, totalDzd: p.totalDzd, feeSource: p.feeSource });
  }
  return { before, after };
}
