// SHIP-3: sending confirmed orders to a courier (SHIP-0 contract rules 1 to 6). The slot is reserved
// in D1 before any courier call; the only way to call the courier is to win `reserved → sending`.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { CourierAdapter, CourierCommune, CourierCredentials, CourierLists, CourierStopDesk, CourierWilaya, CreateResult, ParcelInput, PrepareCode, PreparedParcel } from '@hb/couriers';
import {
  casShipment,
  claimSending,
  claimValidate,
  clip,
  communes,
  DIRECTORY_MAX_AGE_MS,
  orderItems,
  orders,
  raiseException,
  readDirectory,
  recordAccepted,
  refreshDirectory,
  reserveShipment,
  shipmentCas,
  shipments,
  wilayas,
  type CourierAccount,
  type DeliveryType,
  type DirectoryRow,
  type DirectoryTask,
  type Db,
  type Shipment,
} from '@hb/db';
import { audit } from '../../audit/audit.ts';
import type { AppEnv } from '../../env.ts';
import { courierContext } from './keys.ts';

export const SEND_LIMITS = {
  MAX_ORDERS: 50,
  CALL_TIMEOUT_MS: 7000,
  /** No new courier call (create or validate) after this; a call started just before ends by 19 s. */
  CUTOFF_MS: 12_000,
  CONCURRENCY: 3,
  /** Between call starts in one request, on top of `sendPerMinute`. */
  MIN_GAP_MS: 250,
  VERIFY_DELAY_MS: 60_000,
  REFRESH_BUDGET_MS: 6000,
  REFRESH_CALL_MS: 3000,
  ADDRESS_MAX: 300,
} as const;

type Ctx = Context<AppEnv>;

export interface SendOrder {
  id: number;
  ref: string;
  version: number;
  status: string;
  name: string;
  phoneE164: string;
  address: string | null;
  wilayaCode: number;
  wilayaFr: string;
  wilayaAr: string;
  communeFr: string;
  communeAr: string;
  totalDzd: number;
  feeDzd: number;
  productLabel: string;
}

export async function fetchSendOrders(db: Db, refs: readonly string[]): Promise<SendOrder[]> {
  if (refs.length === 0) return [];
  const rows = await db
    .select({
      id: orders.id,
      ref: orders.ref,
      version: orders.version,
      status: orders.status,
      name: orders.name,
      phoneE164: orders.phoneE164,
      address: orders.address,
      wilayaCode: orders.wilayaCode,
      wilayaFr: wilayas.nameFr,
      wilayaAr: wilayas.nameAr,
      communeFr: communes.nameFr,
      communeAr: communes.nameAr,
      totalDzd: orders.totalDzd,
      feeDzd: orders.feeDzd,
    })
    .from(orders)
    .innerJoin(wilayas, eq(wilayas.code, orders.wilayaCode))
    .innerJoin(communes, eq(communes.id, orders.communeId))
    .where(inArray(orders.ref, [...refs]));
  const lines = rows.length
    ? await db
        .select({ orderId: orderItems.orderId, nameFr: orderItems.nameFr, qty: orderItems.qty })
        .from(orderItems)
        .where(inArray(orderItems.orderId, rows.map((r) => r.id)))
        .orderBy(asc(orderItems.id))
    : [];
  return rows.map((r) => ({
    ...r,
    productLabel: lines
      .filter((l) => l.orderId === r.id)
      .map((l) => `${l.nameFr} x${l.qty}`)
      .join(', ')
      .slice(0, 200),
  }));
}

// ---------------------------------------------------------------------------------------------
// Courier lists

export function listsOf(rows: readonly DirectoryRow[], wilayaCode: number): CourierLists {
  const pick = <T,>(kind: DirectoryRow['kind'], code: number) => (rows.find((r) => r.kind === kind && r.wilayaCode === code)?.payload ?? []) as T[];
  return {
    wilayas: pick<CourierWilaya>('wilayas', 0),
    communes: pick<CourierCommune>('communes', wilayaCode),
    stopDesks: pick<CourierStopDesk>('stop_desks', wilayaCode),
  };
}

/** Fetches what is missing or old, inside one total budget. Never fails the page. */
export async function refreshLists(c: Ctx, adapter: CourierAdapter, credentials: CourierCredentials, wilayaCodes: readonly number[], cached: readonly DirectoryRow[]): Promise<void> {
  const now = Date.now();
  const fresh = (kind: DirectoryRow['kind'], code: number) => cached.some((r) => r.kind === kind && r.wilayaCode === code && now - r.fetchedAt < DIRECTORY_MAX_AGE_MS);
  const ctx = (timeoutMs: number) => courierContext(c.env, timeoutMs);
  const tasks: DirectoryTask[] = [];
  if (!fresh('wilayas', 0)) tasks.push({ kind: 'wilayas', wilayaCode: 0, fetch: (t) => adapter.listWilayas(credentials, ctx(t)) });
  for (const code of new Set(wilayaCodes)) {
    if (!fresh('communes', code)) tasks.push({ kind: 'communes', wilayaCode: code, fetch: (t) => adapter.listCommunes(code, credentials, ctx(t)) });
    if (adapter.capabilities.stopDesk && !fresh('stop_desks', code)) tasks.push({ kind: 'stop_desks', wilayaCode: code, fetch: (t) => adapter.listStopDesks(code, credentials, ctx(t)) });
  }
  if (tasks.length > 0) await refreshDirectory(c.var.db, adapter.id, tasks, { budgetMs: SEND_LIMITS.REFRESH_BUDGET_MS, perCallMs: SEND_LIMITS.REFRESH_CALL_MS });
}

// ---------------------------------------------------------------------------------------------
// One parcel

export interface SendFields {
  ref: string;
  version: number;
  address: string | null;
  deliveryType: DeliveryType;
  stopDeskId: string | null;
  /** A person's pick from the courier's commune list. */
  communeName: string | null;
}

export function parcelInput(order: SendOrder, fields: Pick<SendFields, 'address' | 'deliveryType' | 'stopDeskId' | 'communeName'>, account: Pick<CourierAccount, 'config'>): ParcelInput {
  const origin = account.config['originWilaya'];
  return {
    reference: order.ref,
    recipientName: order.name,
    phone: order.phoneE164,
    wilayaCode: order.wilayaCode,
    commune: { nameFr: order.communeFr, nameAr: order.communeAr, ...(fields.communeName ? { courierName: fields.communeName } : {}) },
    deliveryType: fields.deliveryType,
    ...(fields.address ? { address: fields.address } : {}),
    ...(fields.stopDeskId ? { stopDeskId: fields.stopDeskId } : {}),
    // Always the order's own total, read on the server just now.
    codTotalDzd: order.totalDzd,
    productLabel: order.productLabel,
    ...(typeof origin === 'number' ? { originWilayaCode: origin } : {}),
  };
}

export type SendOutcome =
  | { ref: string; outcome: 'sent'; tracking: string; shipmentId: number }
  | { ref: string; outcome: 'awaiting_validation'; tracking: string; shipmentId: number; reason: 'pending' | 'uncertain' | 'locked' | 'rejected'; detail?: string }
  | { ref: string; outcome: 'rejected'; code: string; detail: string }
  | { ref: string; outcome: 'uncertain'; shipmentId: number }
  | { ref: string; outcome: 'refused'; code: 'not_found' | 'not_confirmed' | 'stale' | 'taken' | PrepareCode; detail?: string }
  | { ref: string; outcome: 'not_attempted'; reason: 'time' | 'stopped' };

export interface SendRun {
  adapter: CourierAdapter;
  account: CourierAccount;
  credentials: CourierCredentials;
  /** Fields per order, in form order. */
  items: readonly SendFields[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function shipAudit(c: Ctx, shipmentId: number, after: Record<string, unknown>, when: ReturnType<typeof sql>) {
  return audit(c, { action: 'shipment.send', entity: 'shipments', entityId: shipmentId, before: null, after }, { when });
}

async function acceptParcel(c: Ctx, run: SendRun, row: Pick<Shipment, 'id' | 'orderId' | 'address' | 'codAmountDzd'>, expected: 'sending' | 'draft', tracking: string, labelUrl: string | undefined): Promise<'shipped' | 'pending' | 'duplicate' | 'lost'> {
  const now = Date.now();
  const res = await recordAccepted(c.var.db, {
    shipmentId: row.id,
    orderId: row.orderId,
    expected,
    tracking,
    ...(labelUrl !== undefined ? { labelUrl } : {}),
    courierName: run.adapter.displayName,
    address: row.address,
    actor: { userId: c.var.user.id, role: c.var.user.role },
    now,
    audit: (when) => shipAudit(c, row.id, { courier: run.adapter.id, tracking, codAmountDzd: row.codAmountDzd, status: 'shipped' }, when),
  });
  switch (res.kind) {
    case 'shipped':
      return 'shipped';
    case 'stored':
    case 'not_applicable':
      return 'pending';
    case 'lost':
      return 'lost';
    case 'duplicate_tracking':
      return 'duplicate';
  }
}

async function markDuplicateTracking(c: Ctx, run: SendRun, row: Pick<Shipment, 'id' | 'orderId'>, expected: 'sending' | 'draft', tracking: string): Promise<void> {
  const now = Date.now();
  await casShipment(c.var.db, row.id, expected, { state: 'uncertain', errorCode: 'duplicate_tracking', errorDetail: clip(tracking), attemptEndedAt: now, verifyNextAt: null, updatedAt: now });
  await raiseException(c.var.db, { kind: 'uncertain_send', subject: `s:${row.id}`, shipmentId: row.id, orderId: row.orderId, courier: run.adapter.id, detail: 'duplicate_tracking', now });
}

/** Claims and runs one validation of a draft. Never creates a parcel. */
export async function validateDraft(c: Ctx, run: SendRun, row: Pick<Shipment, 'id' | 'orderId' | 'address' | 'codAmountDzd' | 'reference'>, ref: string, tracking: string, opts: { retryAfterMs?: number } = {}): Promise<SendOutcome> {
  const claimed = await claimValidate(c.var.db, row.id, Date.now(), opts);
  if (!claimed) return { ref, outcome: 'awaiting_validation', tracking, shipmentId: row.id, reason: 'pending' };
  const askCollection = run.account.config['askCollection'] === true;
  const res = await run.adapter.validateParcel(tracking, { askCollection }, run.credentials, courierContext(c.env, SEND_LIMITS.CALL_TIMEOUT_MS));
  if (res.kind === 'validated') {
    const done = await acceptParcel(c, run, row, 'draft', tracking, undefined);
    if (done === 'shipped') return { ref, outcome: 'sent', tracking, shipmentId: row.id };
    return { ref, outcome: 'awaiting_validation', tracking, shipmentId: row.id, reason: 'pending' };
  }
  const code = res.kind === 'uncertain' ? 'validate_uncertain' : res.code === 'locked' ? 'locked' : res.code;
  const detail = res.kind === 'uncertain' ? res.cause : res.detail;
  await c.var.db.batch([
    shipAudit(c, row.id, { courier: run.adapter.id, tracking, validate: code }, sql`EXISTS (SELECT 1 FROM ${shipments} WHERE ${shipments.id} = ${row.id} AND ${shipments.state} = 'draft')`),
    c.var.db
      .update(shipments)
      .set({ errorCode: code, errorDetail: clip(detail), updatedAt: Date.now() })
      .where(and(eq(shipments.id, row.id), eq(shipments.state, 'draft'))),
  ]);
  if (res.kind === 'uncertain') return { ref, outcome: 'awaiting_validation', tracking, shipmentId: row.id, reason: 'uncertain' };
  if (res.code === 'locked') return { ref, outcome: 'awaiting_validation', tracking, shipmentId: row.id, reason: 'locked' };
  return { ref, outcome: 'awaiting_validation', tracking, shipmentId: row.id, reason: 'rejected', detail: res.detail };
}

interface Pace {
  readonly startedAt: number;
  nextCallAt: number;
  calls: number;
  stopped: boolean;
}

/** Waits for this call's turn; false if the request must not start another call. */
async function takeTurn(run: SendRun, pace: Pace): Promise<'go' | 'time' | 'stopped'> {
  if (pace.stopped) return 'stopped';
  if (pace.calls >= run.adapter.capabilities.sendPerMinute) return 'time';
  const at = Math.max(Date.now(), pace.nextCallAt);
  pace.nextCallAt = at + SEND_LIMITS.MIN_GAP_MS;
  if (at - pace.startedAt > SEND_LIMITS.CUTOFF_MS) return 'time';
  pace.calls++;
  const wait = at - Date.now();
  if (wait > 0) await sleep(wait);
  return pace.stopped ? 'stopped' : 'go';
}

async function sendOne(c: Ctx, run: SendRun, item: SendFields, order: SendOrder | undefined, lists: CourierLists, pace: Pace): Promise<SendOutcome> {
  const { ref } = item;
  if (!order) return { ref, outcome: 'refused', code: 'not_found' };
  if (order.status !== 'confirmed') return { ref, outcome: 'refused', code: 'not_confirmed' };
  if (order.version !== item.version) return { ref, outcome: 'refused', code: 'stale' };

  const prepared = run.adapter.prepare(parcelInput(order, item, run.account), lists);
  if (!prepared.ok) return { ref, outcome: 'refused', code: prepared.code, detail: prepared.detail };

  const turn = await takeTurn(run, pace);
  if (turn !== 'go') return { ref, outcome: 'not_attempted', reason: turn };

  const db = c.var.db;
  const now = Date.now();
  const stopDesk = item.stopDeskId ? lists.stopDesks.find((d) => d.id === item.stopDeskId) : undefined;
  const reserved = await reserveShipment(db, {
    orderId: order.id,
    version: item.version,
    courier: run.adapter.id,
    accountId: run.account.id,
    deliveryType: item.deliveryType,
    stopDeskId: item.stopDeskId,
    stopDeskName: stopDesk?.name ?? null,
    address: item.address,
    createdBy: c.var.user.id,
    now,
  });
  if (!reserved.ok) return { ref, outcome: 'refused', code: reserved.code };
  const shipmentId = reserved.shipmentId;
  if (!(await claimSending(db, shipmentId, Date.now()))) return { ref, outcome: 'refused', code: 'taken' };

  const row = { id: shipmentId, orderId: order.id, address: item.address, codAmountDzd: order.totalDzd, reference: order.ref };
  try {
    return await callCourier(c, run, item, prepared.parcel, row, pace);
  } catch {
    // From here the parcel may exist, so this can never be reported as safe to retry.
    await markUncertain(c, run, row, 'send_failed');
    return { ref, outcome: 'uncertain', shipmentId };
  }
}

async function callCourier(c: Ctx, run: SendRun, item: SendFields, parcel: PreparedParcel, row: Pick<Shipment, 'id' | 'orderId' | 'address' | 'codAmountDzd' | 'reference'>, pace: Pace): Promise<SendOutcome> {
  const { ref } = item;
  const db = c.var.db;
  const shipmentId = row.id;
  let created: CreateResult;
  try {
    created = await run.adapter.createParcel(parcel, run.credentials, courierContext(c.env, SEND_LIMITS.CALL_TIMEOUT_MS));
  } catch {
    created = { kind: 'uncertain', cause: 'adapter_threw' };
  }

  if (created.kind === 'rejected') {
    const at = Date.now();
    if (created.code === 'rate_limited' || created.code === 'auth') pace.stopped = true;
    const when = sql`EXISTS (SELECT 1 FROM ${shipments} WHERE ${shipments.id} = ${shipmentId} AND ${shipments.state} = 'sending')`;
    await db.batch([
      shipAudit(c, shipmentId, { courier: run.adapter.id, rejected: created.code }, when),
      shipmentCas(db, shipmentId, 'sending', { state: 'failed', errorCode: created.code, errorDetail: clip(created.detail), attemptEndedAt: at, updatedAt: at }),
    ]);
    return { ref, outcome: 'rejected', code: created.code, detail: created.detail };
  }

  if (created.kind === 'uncertain') {
    await markUncertain(c, run, row, created.cause);
    return { ref, outcome: 'uncertain', shipmentId };
  }

  const { tracking, labelUrl } = created;
  if (created.draft) {
    const at = Date.now();
    await db.batch([
      shipmentCas(db, shipmentId, 'sending', { state: 'draft', tracking, labelUrl: labelUrl ?? null, attemptEndedAt: at, updatedAt: at }),
      shipAudit(c, shipmentId, { courier: run.adapter.id, tracking, status: 'draft' }, sql`EXISTS (SELECT 1 FROM ${shipments} WHERE ${shipments.id} = ${shipmentId} AND ${shipments.state} = 'draft')`),
    ]);
    if (Date.now() - pace.startedAt > SEND_LIMITS.CUTOFF_MS) return { ref, outcome: 'awaiting_validation', tracking, shipmentId, reason: 'pending' };
    return validateDraft(c, run, row, ref, tracking);
  }

  try {
    const done = await acceptParcel(c, run, row, 'sending', tracking, labelUrl);
    if (done === 'shipped') return { ref, outcome: 'sent', tracking, shipmentId };
    if (done === 'duplicate') {
      await markDuplicateTracking(c, run, row, 'sending', tracking);
      return { ref, outcome: 'uncertain', shipmentId };
    }
    return { ref, outcome: 'uncertain', shipmentId };
  } catch {
    await markUncertain(c, run, row, 'accept_write_failed', tracking);
    return { ref, outcome: 'uncertain', shipmentId };
  }
}

/** The parcel may exist. Never resent automatically; the cron or a person settles it. */
async function markUncertain(c: Ctx, run: SendRun, row: Pick<Shipment, 'id' | 'orderId'>, cause: string, tracking?: string): Promise<void> {
  const now = Date.now();
  const verifies = run.adapter.capabilities.verifyByReference;
  const patch = {
    state: 'uncertain' as const,
    errorCode: 'uncertain',
    errorDetail: clip(cause),
    attemptEndedAt: now,
    verifyNextAt: verifies ? now + SEND_LIMITS.VERIFY_DELAY_MS : null,
    updatedAt: now,
    ...(tracking ? { tracking } : {}),
  };
  const when = sql`EXISTS (SELECT 1 FROM ${shipments} WHERE ${shipments.id} = ${row.id} AND ${shipments.state} = 'sending')`;
  try {
    await c.var.db.batch([shipAudit(c, row.id, { courier: run.adapter.id, uncertain: cause }, when), shipmentCas(c.var.db, row.id, 'sending', patch)]);
    if (!verifies) await raiseException(c.var.db, { kind: 'uncertain_send', subject: `s:${row.id}`, shipmentId: row.id, orderId: row.orderId, courier: run.adapter.id, detail: cause, now });
  } catch {
    // D1 is failing too: the row stays `sending` and the sweep moves it to `uncertain`.
  }
}

/** Sends every order. Each result is independent; the response time is bounded by SEND_LIMITS. */
export async function runSend(c: Ctx, run: SendRun): Promise<SendOutcome[]> {
  const orderRows = await fetchSendOrders(c.var.db, run.items.map((i) => i.ref));
  const byRef = new Map(orderRows.map((o) => [o.ref, o]));
  const directory = await readDirectory(c.var.db, run.adapter.id, orderRows.map((o) => o.wilayaCode));
  const pace: Pace = { startedAt: Date.now(), nextCallAt: 0, calls: 0, stopped: false };
  const out: SendOutcome[] = new Array(run.items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      const item = run.items[i];
      if (!item) return;
      const order = byRef.get(item.ref);
      try {
        out[i] = await sendOne(c, run, item, order, listsOf(directory, order?.wilayaCode ?? -1), pace);
      } catch {
        // Only reached before the courier was called (a D1 failure reading or reserving): nothing was sent.
        out[i] = { ref: item.ref, outcome: 'not_attempted', reason: 'stopped' };
      }
    }
  };
  await Promise.all(Array.from({ length: SEND_LIMITS.CONCURRENCY }, worker));
  return out;
}
