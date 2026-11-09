// SHIP-5 (SHIP-0 contract checks 5 cron part, 6, 6a, 12, 13, 13a, 14, 15, 15a, 15b, 16, 16a, 17, 17a,
// 17c, 17d, 22, 22a, 27, 27a, 28): the courier sync on real local D1 (workerd), with the real
// courier stand-in as a child process. ENV is set to `test` explicitly: the jobs wrangler config
// says `production`, which would let an adapter reach a real courier host (rev-i, SHIP-1 review).
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { importSecretBoxKey, sealSecret } from '@hb/db';
import { runCourierSync, type SyncOptions } from '../../src/couriers/sync.ts';
import { applyMigrations } from '../helpers/schema.ts';
import { localPlatform, type LocalPlatform } from '../helpers/platform.ts';
import { startStandin, type Standin } from './standin.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const SECRET = 'standin-webhook-secret';
const CREDS = { apiId: 'standin-id', apiToken: 'standin-token', webhookSecret: SECRET };

type E = { DB: D1Database };
type Row = Record<string, unknown>;
let p: LocalPlatform<E>;
let standin: Standin;
let next = 1;
const MIN = 60_000;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const refOf = (n: number) => `HB-${[0, 1, 2, 3, 4].map((i) => ALPHABET[Math.floor(n / 32 ** (4 - i)) % 32]).join('')}`;

const db = () => p.env.DB;
const one = async (q: string, ...b: unknown[]) => (await db().prepare(q).bind(...b).first<Row>())!;
const all = async (q: string, ...b: unknown[]) => (await db().prepare(q).bind(...b).all<Row>()).results;
const env = (over: Record<string, string | undefined> = {}) => ({ DB: db(), ENV: 'test', COURIER_KEYS_KEY: KEY, COURIER_STANDIN_URL: standin.url, ...over });

/** One sync run; the accounts' poll interval is reset so each run may poll. */
async function run(opts: SyncOptions = {}, over: Record<string, string | undefined> = {}) {
  await db().prepare('update courier_accounts set last_polled_at = null, poll_backoff_until = null, poll_lease_until = null').run();
  return runCourierSync(env(over), opts);
}
const at = (offsetMs: number): SyncOptions => ({ now: () => Date.now() + offsetMs });

async function account(courier: string, opts: { enabled?: boolean; creds?: Record<string, string> } = {}): Promise<number> {
  const sealed = await sealSecret(await importSecretBoxKey(KEY), JSON.stringify(opts.creds ?? CREDS), courier);
  const res = await db()
    .prepare(`insert into courier_accounts (courier, enabled, credentials_cipher, credentials_iv, key_version, config) values (?, ?, ?, ?, 1, '{"originWilaya":16}') returning id`)
    .bind(courier, opts.enabled === false ? 0 : 1, sealed.cipher, sealed.iv)
    .first<{ id: number }>();
  return res!.id;
}

async function order(status: string): Promise<{ id: number; ref: string }> {
  const id = next++;
  const ref = refOf(40_000 + id);
  await db().batch([
    db()
      .prepare(
        `insert into orders (id, ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, address, lang, status, subtotal_dzd, fee_dzd, total_dzd, fee_source)
         values (?, ?, ?, 1, 'Amine', '+213560417403', 16, 1601, 'Rue 1', 'fr', ?, 1000, 400, 1400, 'table')`,
      )
      .bind(id, ref, `k${id}`, status),
    db()
      .prepare(`insert into order_items (order_id, variant_id, product_id, name_fr, name_ar, sku, unit_price_dzd, qty, line_total_dzd, stock_taken) values (?, 100, 10, 'n', 'ن', 'S1', 1000, 1, 1000, 1)`)
      .bind(id),
  ]);
  return { id, ref };
}

interface ShipOpts {
  courier?: string;
  tracking?: string | null;
  appliedAt?: number | null;
  attemptedAt?: number | null;
  attemptEndedAt?: number | null;
  verifyNextAt?: number | null;
  acceptedAt?: number | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  createdAt?: number;
}

async function shipment(o: { id: number; ref: string }, accountId: number, state: string, s: ShipOpts = {}): Promise<number> {
  const now = Date.now();
  const r = await db()
    .prepare(
      `insert into shipments (order_id, courier, account_id, state, reference, tracking, cod_amount_dzd, fee_dzd, wilaya_code, commune_id, address, applied_at,
         attempted_at, attempt_ended_at, verify_next_at, accepted_at, error_code, error_detail, created_by, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, 1400, 400, 16, 1601, 'Rue 1', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) returning id`,
    )
    .bind(
      o.id,
      s.courier ?? 'yalidine',
      accountId,
      state,
      o.ref,
      s.tracking ?? null,
      s.appliedAt ?? null,
      s.attemptedAt ?? null,
      s.attemptEndedAt ?? null,
      s.verifyNextAt ?? null,
      s.acceptedAt ?? null,
      s.errorCode ?? null,
      s.errorDetail ?? null,
      s.createdAt ?? now,
      s.createdAt ?? now,
    )
    .first<{ id: number }>();
  return r!.id;
}

/** A parcel at the stand-in and the matching shipped order with an applied shipment. */
async function shippedParcel(accountId: number, courier = 'yalidine', status = 'Expédié') {
  const o = await order('shipped');
  const tracking = `${courier === 'yalidine' ? 'yal' : 'gue'}-T${next++}`;
  await standin.control(`${courier}/seed`, { parcels: [{ tracking, order_id: o.ref, last_status: status }] });
  const sid = await shipment(o, accountId, 'accepted', { courier, tracking, appliedAt: Date.now() - MIN, acceptedAt: Date.now() - MIN });
  return { ...o, tracking, sid };
}
const move = (tracking: string, status: string, courier = 'yalidine', atText?: string) =>
  standin.control(`${courier}/parcels/${tracking}/status`, { status, ...(atText ? { at: atText } : {}) });

const orderOf = (id: number) => one('select status, version, stock_restored_at from orders where id = ?', id);
const stock = async () => (await one('select stock from variants where id = 100'))['stock'] as number;
const statusEvents = async (id: number) => all(`select * from order_events where order_id = ? and type = 'status_change'`, id);
const exceptions = async (kind?: string) => all(`select * from delivery_exceptions ${kind ? 'where kind = ?' : ''} order by id`, ...(kind ? [kind] : []));
const shipmentRow = (id: number) => one('select * from shipments where id = ?', id);
const audits = (sid: number) => all(`select * from audit_log where entity = 'shipments' and entity_id = ?`, String(sid));

/** An Algeria-time stamp, as couriers send them. */
const algeria = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

function webhookBody(tracking: string, status: string, atMs = Date.now()) {
  return JSON.stringify({ type: 'parcel_status_updated', events: [{ event_id: `evt-${tracking}-${status}`, occurred_at: algeria(atMs), data: { tracking, status, reason: null } }] });
}
async function inboxRow(accountId: number, body: string, opts: { signature?: string; receivedAt?: number; courier?: string } = {}): Promise<number> {
  const sig = opts.signature ?? createHmac('sha256', SECRET).update(body).digest('hex');
  const r = await db()
    .prepare(`insert into courier_webhook_inbox (account_id, courier, body, headers, received_at) values (?, ?, ?, ?, ?) returning id`)
    .bind(accountId, opts.courier ?? 'yalidine', new TextEncoder().encode(body), JSON.stringify({ 'x-yalidine-signature': sig }), opts.receivedAt ?? Date.now())
    .first<{ id: number }>();
  return r!.id;
}

let yal: number;

beforeAll(async () => {
  p = await localPlatform<E>();
  await applyMigrations(db());
  await db().batch([
    db().prepare(`insert into admin_users (id, email, name, role) values (1, 'owner@dev.local', 'O', 'owner')`),
    db().prepare(`insert into wilayas (code, name_fr, name_ar) values (16, 'Alger', 'الجزائر')`),
    db().prepare(`insert into communes (id, wilaya_code, name_fr, name_ar) values (1601, 16, 'Alger Centre', 'الجزائر الوسطى')`),
    db().prepare(`insert into customers (id, phone_e164, name) values (1, '+213560417403', 'Amine')`),
    db().prepare(`insert into categories (id, slug_fr, slug_ar, name_fr, name_ar) values (1, 'c', 'c-ar', 'C', 'ك')`),
    db().prepare(`insert into products (id, category_id, slug_fr, slug_ar, name_fr, name_ar, status) values (10, 1, 'p', 'p-ar', 'P', 'ب', 'active')`),
    db().prepare(`insert into variants (id, product_id, sku, price_dzd, stock, is_default) values (100, 10, 'S1', 1000, 5, 1)`),
  ]);
  standin = await startStandin();
});
afterAll(async () => {
  standin?.stop();
  await p?.dispose();
});
beforeEach(async () => {
  await standin.reset();
  for (const c of ['yalidine', 'guepex']) await standin.control(`${c}/scenario`, { quota: false });
  await db().batch(
    ['delivery_exceptions', 'shipment_events', 'courier_webhook_inbox', 'shipments', 'courier_directory', 'courier_accounts'].map((t) => db().prepare(`delete from ${t}`)),
  );
  yal = await account('yalidine');
});

describe('status events by polling', () => {
  test('delivered: order moves once, system actor, audited; the same status again changes nothing (check 13)', async () => {
    const parcel = await shippedParcel(yal);
    await move(parcel.tracking, 'Livré');
    await run();
    expect(await orderOf(parcel.id)).toMatchObject({ status: 'delivered', version: 1 });
    const ev = await statusEvents(parcel.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ from_status: 'shipped', to_status: 'delivered', actor_type: 'system', actor_user_id: null });
    expect(await audits(parcel.sid)).toHaveLength(1);
    expect(await shipmentRow(parcel.sid)).toMatchObject({ courier_status: 'delivered', courier_status_raw: 'Livré' });
    await run();
    await run();
    expect(await orderOf(parcel.id)).toMatchObject({ status: 'delivered', version: 1 });
    expect(await statusEvents(parcel.id)).toHaveLength(1);
    expect(await all('select * from shipment_events where shipment_id = ?', parcel.sid)).toHaveLength(1);
    expect(await audits(parcel.sid)).toHaveLength(1);
  });

  test('the same status by webhook and by poll with two keys: second ignored, nothing moves twice (check 13)', async () => {
    const parcel = await shippedParcel(yal);
    await move(parcel.tracking, 'Livré');
    await inboxRow(yal, webhookBody(parcel.tracking, 'Livré', Date.now() - 3 * MIN));
    await run();
    const events = await all('select state from shipment_events where shipment_id = ? order by id', parcel.sid);
    expect(events.map((e) => e['state']).sort()).toEqual(['applied', 'ignored']);
    expect(await orderOf(parcel.id)).toMatchObject({ status: 'delivered', version: 1 });
    expect(await statusEvents(parcel.id)).toHaveLength(1);
  });

  test('returned restocks exactly once, also when redelivered or already returned by hand (check 14)', async () => {
    const parcel = await shippedParcel(yal);
    const s0 = await stock();
    await move(parcel.tracking, 'Retourné au vendeur');
    await run();
    expect(await orderOf(parcel.id)).toMatchObject({ status: 'returned' });
    expect(await stock()).toBe(s0 + 1);
    await inboxRow(yal, webhookBody(parcel.tracking, 'Retourné au vendeur', Date.now() + 1000));
    await run();
    expect(await stock()).toBe(s0 + 1);

    const byHand = await shippedParcel(yal);
    await db().prepare(`update orders set status = 'returned', version = version + 1, stock_restored_at = 1 where id = ?`).bind(byHand.id).run();
    await db().prepare('update variants set stock = stock + 1 where id = 100').run();
    const s1 = await stock();
    await move(byHand.tracking, 'Retourné au vendeur');
    await run();
    expect(await stock()).toBe(s1);
    expect(await shipmentRow(byHand.sid)).toMatchObject({ courier_status: 'returned' });
    expect(await exceptions()).toHaveLength(0);
  });

  test('a terminal shipment stays terminal; the other terminal is a conflict (checks 15, 15a)', async () => {
    const a = await shippedParcel(yal);
    await move(a.tracking, 'Livré');
    await run();
    await move(a.tracking, 'En transit');
    await run();
    expect(await shipmentRow(a.sid)).toMatchObject({ courier_status: 'delivered' });

    const b = await shippedParcel(yal);
    await move(b.tracking, 'Retour vers vendeur');
    await run();
    expect(await orderOf(b.id)).toMatchObject({ status: 'shipped' });
    expect(await shipmentRow(b.sid)).toMatchObject({ courier_status: 'returning' });
    const s0 = await stock();
    await move(b.tracking, 'Retourné au vendeur');
    await run();
    expect(await orderOf(b.id)).toMatchObject({ status: 'returned' });
    expect(await stock()).toBe(s0 + 1);
    await move(b.tracking, 'Livré');
    await run();
    expect(await orderOf(b.id)).toMatchObject({ status: 'returned' });
    expect(await stock()).toBe(s0 + 1);
    const conflicts = await exceptions('terminal_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ subject: `s:${b.sid}`, state: 'open' });
  });

  test('an older terminal event after a newer non-terminal one still moves the order (check 15b)', async () => {
    const parcel = await shippedParcel(yal);
    await inboxRow(yal, webhookBody(parcel.tracking, 'En transit', Date.now()));
    await inboxRow(yal, webhookBody(parcel.tracking, 'Livré', Date.now() - 60 * MIN));
    await standin.control('yalidine/scenario', { read: 'down' });
    await run();
    expect(await orderOf(parcel.id)).toMatchObject({ status: 'delivered' });
    expect(await shipmentRow(parcel.sid)).toMatchObject({ courier_status: 'delivered' });
  });

  test('unknown status: stored, no order move, one exception across repeats (check 16)', async () => {
    const parcel = await shippedParcel(yal);
    await move(parcel.tracking, 'Statut inventé');
    await run();
    await inboxRow(yal, webhookBody(parcel.tracking, 'Statut inventé', Date.now() - 2 * MIN));
    await run();
    expect(await orderOf(parcel.id)).toMatchObject({ status: 'shipped', version: 0 });
    const ex = await exceptions('unknown_status');
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ raw_status: 'Statut inventé', state: 'open' });
    expect(ex[0]!['count']).toBeGreaterThanOrEqual(2);
  });

  test('in_transit on a shipped order raises nothing; an event on a failed shipment raises one exception (check 17d)', async () => {
    const parcel = await shippedParcel(yal);
    await move(parcel.tracking, 'En transit');
    await run();
    expect(await exceptions()).toHaveLength(0);
    expect(await shipmentRow(parcel.sid)).toMatchObject({ courier_status: 'in_transit' });

    const o = await order('confirmed');
    const sid = await shipment(o, yal, 'failed', { tracking: 'yal-FAILED1' });
    await inboxRow(yal, webhookBody('yal-FAILED1', 'Livré'));
    await run();
    await run();
    expect(await exceptions('order_not_applicable')).toHaveLength(1);
    expect(await one('select state from shipment_events where shipment_id = ?', sid)).toMatchObject({ state: 'exception' });
    expect(await orderOf(o.id)).toMatchObject({ status: 'confirmed' });
  });

  test('a poll result for one account never touches a parcel of another courier (check 22a)', async () => {
    const gue = await account('guepex', { creds: { apiId: 'standin-id', apiToken: 'standin-token' } });
    const mine = await shippedParcel(gue, 'guepex');
    await move(mine.tracking, 'Livré', 'guepex');
    // The same tracking string under Yalidine: a webhook for it must not match the Guepex parcel.
    await inboxRow(yal, webhookBody(mine.tracking, 'Retourné au vendeur'), { receivedAt: Date.now() - 31 * MIN });
    await run();
    expect(await orderOf(mine.id)).toMatchObject({ status: 'delivered' });
    expect(await exceptions('unmatched_tracking')).toHaveLength(1);
  });

  test('fairness: every open parcel is polled within ceil(open / batch) + 1 runs (check 13d, 27)', async () => {
    const parcels = [];
    for (let i = 0; i < 7; i++) parcels.push(await shippedParcel(yal));
    for (let r = 0; r < Math.ceil(7 / 3) + 1; r++) await run({ limits: {} }, {});
    // pollBatchSize is the adapter's (100); with a small batch the order is by last_polled_at.
    const polled = await all('select last_polled_at from shipments where id in (' + parcels.map((x) => x.sid).join(',') + ')');
    expect(polled.every((r) => r['last_polled_at'] !== null)).toBe(true);
  });

  test('a poll failure backs the account off; others are processed (check 27)', async () => {
    const parcel = await shippedParcel(yal);
    await standin.control('yalidine/scenario', { read: '429' });
    await runCourierSync(env());
    const acc = await one('select poll_backoff_until from courier_accounts where id = ?', yal);
    expect(acc['poll_backoff_until']).toEqual(expect.any(Number));
    expect(await orderOf(parcel.id)).toMatchObject({ status: 'shipped' });
  });
});

describe('webhooks from the inbox', () => {
  test('a valid signature applies; a bad one is rejected with one exception counting repeats (checks 22, 13b)', async () => {
    const parcel = await shippedParcel(yal);
    await standin.control('yalidine/scenario', { read: 'down' });
    const good = await inboxRow(yal, webhookBody(parcel.tracking, 'Livré'));
    const bad1 = await inboxRow(yal, webhookBody(parcel.tracking, 'Retourné au vendeur'), { signature: '0'.repeat(64) });
    const bad2 = await inboxRow(yal, webhookBody(parcel.tracking, 'Retourné au vendeur'), { signature: 'nothex' });
    await run();
    expect(await orderOf(parcel.id)).toMatchObject({ status: 'delivered' });
    expect(await one('select state from courier_webhook_inbox where id = ?', good)).toMatchObject({ state: 'done' });
    for (const id of [bad1, bad2]) expect(await one('select state from courier_webhook_inbox where id = ?', id)).toMatchObject({ state: 'rejected' });
    const ex = await exceptions('invalid_signature');
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ subject: 'c:yalidine', count: 2 });
  });

  test('no signing secret stored: rejected, and polling still delivers (check 22a)', async () => {
    await db().prepare('delete from courier_accounts').run();
    yal = await account('yalidine', { creds: { apiId: 'standin-id', apiToken: 'standin-token' } });
    const parcel = await shippedParcel(yal);
    await move(parcel.tracking, 'Livré');
    await inboxRow(yal, webhookBody(parcel.tracking, 'Livré'));
    await run();
    expect(await orderOf(parcel.id)).toMatchObject({ status: 'delivered' });
    expect((await exceptions('invalid_signature'))[0]).toMatchObject({ detail: 'missing_secret' });
  });

  test('a webhook that beats our tracking write is held, then applies once the tracking exists (check 16a)', async () => {
    const o = await order('shipped');
    const id = await inboxRow(yal, webhookBody('yal-LATE01', 'Livré'));
    await run();
    expect(await one('select state from courier_webhook_inbox where id = ?', id)).toMatchObject({ state: 'held' });
    const sid = await shipment(o, yal, 'accepted', { tracking: 'yal-LATE01', appliedAt: Date.now(), acceptedAt: Date.now() });
    await standin.control('yalidine/scenario', { read: 'down' });
    await run();
    expect(await one('select state from courier_webhook_inbox where id = ?', id)).toMatchObject({ state: 'done' });
    expect(await orderOf(o.id)).toMatchObject({ status: 'delivered' });
    expect(await exceptions()).toHaveLength(0);
    void sid;
  });

  test('unmatched past 30 minutes: one exception per tracking; a foreign parcel raises nothing again (check 16a)', async () => {
    await inboxRow(yal, webhookBody('yal-NOPE01', 'Livré'), { receivedAt: Date.now() - 31 * MIN });
    await inboxRow(yal, webhookBody('yal-NOPE02', 'Livré'), { receivedAt: Date.now() - 31 * MIN });
    await run();
    const ex = await exceptions('unmatched_tracking');
    expect(ex.map((e) => e['subject']).sort()).toEqual(['t:yalidine|yal-NOPE01', 't:yalidine|yal-NOPE02']);
    await db().prepare(`update delivery_exceptions set state = 'resolved', resolution = 'foreign' where subject = 't:yalidine|yal-NOPE01'`).run();
    await inboxRow(yal, webhookBody('yal-NOPE01', 'Retourné au vendeur'), { receivedAt: Date.now() - 31 * MIN });
    await run();
    expect((await exceptions('unmatched_tracking')).filter((e) => e['state'] === 'open')).toHaveLength(1);
  });

  test('a row failing 5 times becomes poison with one exception; other rows still drain (check 17c)', async () => {
    const parcel = await shippedParcel(yal);
    await standin.control('yalidine/scenario', { read: 'down' });
    const bad = await db()
      .prepare(`insert into courier_webhook_inbox (account_id, courier, body, headers, received_at) values (?, 'yalidine', ?, 'not json', ?) returning id`)
      .bind(yal, new TextEncoder().encode('{}'), Date.now())
      .first<{ id: number }>()
      .catch(() => null);
    // headers must be JSON (CHECK), so poison comes from a row whose courier no longer matches its account.
    const poison = bad?.id ?? (await inboxRow(yal, webhookBody(parcel.tracking, 'Livré'), { courier: 'guepex' }));
    await inboxRow(yal, webhookBody(parcel.tracking, 'Livré'));
    for (let i = 0; i < 5; i++) {
      await db().prepare('update courier_webhook_inbox set next_attempt_at = null').run();
      await run();
    }
    expect(await one('select state, attempts from courier_webhook_inbox where id = ?', poison)).toMatchObject({ state: 'poison', attempts: 5 });
    expect(await exceptions('inbox_poison')).toHaveLength(1);
    expect(await orderOf(parcel.id)).toMatchObject({ status: 'delivered' });
  });

  test('disabled account: rows wait without attempts; re-enabled, the order moves once (checks 13e, 27a)', async () => {
    const parcel = await shippedParcel(yal);
    await db().prepare('update courier_accounts set enabled = 0').run();
    const id = await inboxRow(yal, webhookBody(parcel.tracking, 'Livré'));
    await move(parcel.tracking, 'Livré');
    await run();
    await run();
    expect(await one('select state, attempts from courier_webhook_inbox where id = ?', id)).toMatchObject({ state: 'pending', attempts: 0 });
    expect(await orderOf(parcel.id)).toMatchObject({ status: 'shipped' });
    expect((await standin.state('yalidine')).readCount).toBe(0);
    await db().prepare('update courier_accounts set enabled = 1').run();
    await run();
    expect(await orderOf(parcel.id)).toMatchObject({ status: 'delivered', version: 1 });
    expect(await statusEvents(parcel.id)).toHaveLength(1);
  });

  test('done and rejected rows are purged after 14 days; pending ones are kept (check 17c)', async () => {
    const old = Date.now() - 15 * 86_400_000;
    await db().batch([
      db().prepare(`insert into courier_webhook_inbox (account_id, courier, body, state, received_at, processed_at) values (?, 'yalidine', x'00', 'done', ?, ?)`).bind(yal, old, old),
      db().prepare(`insert into courier_webhook_inbox (account_id, courier, body, state, received_at, processed_at) values (?, 'yalidine', x'00', 'rejected', ?, ?)`).bind(yal, old, old),
      db().prepare(`insert into courier_webhook_inbox (account_id, courier, body, state, received_at) values (?, 'yalidine', x'00', 'poison', ?)`).bind(yal, old),
    ]);
    await run();
    expect((await all('select state from courier_webhook_inbox')).map((r) => r['state'])).toEqual(['poison']);
  });
});

describe('uncertain sends and drafts', () => {
  test('found later: the order ships, no second create (check 5, cron part)', async () => {
    const o = await order('confirmed');
    await standin.control('yalidine/seed', { parcels: [{ tracking: 'yal-FOUND1', order_id: o.ref }] });
    const t = Date.now() - 2 * MIN;
    const sid = await shipment(o, yal, 'uncertain', { attemptedAt: t, attemptEndedAt: t, verifyNextAt: t + MIN, errorCode: 'uncertain', errorDetail: 'timeout' });
    await run();
    expect(await shipmentRow(sid)).toMatchObject({ state: 'accepted', tracking: 'yal-FOUND1' });
    expect(await orderOf(o.id)).toMatchObject({ status: 'shipped' });
    expect((await standin.state('yalidine')).createCount).toBe(0);
    expect(await audits(sid)).toHaveLength(1);
  });

  test('not found: failed only once resend-safe (check 6)', async () => {
    const o = await order('confirmed');
    const t = Date.now() - 2 * MIN;
    const sid = await shipment(o, yal, 'uncertain', { attemptedAt: t, attemptEndedAt: t, verifyNextAt: t, errorCode: 'uncertain', errorDetail: 'timeout' });
    await run();
    expect(await shipmentRow(sid)).toMatchObject({ state: 'uncertain' });
    await db().prepare('update shipments set verify_next_at = 0 where id = ?').bind(sid).run();
    await run(at(10 * MIN));
    expect(await shipmentRow(sid)).toMatchObject({ state: 'failed', error_code: 'verified_absent' });
    expect(await orderOf(o.id)).toMatchObject({ status: 'confirmed' });
  });

  test('a cause saying the parcel exists never turns not_found into a resend (rev-h note)', async () => {
    const o = await order('confirmed');
    const t = Date.now() - 20 * MIN;
    const sid = await shipment(o, yal, 'uncertain', { attemptedAt: t, attemptEndedAt: t, verifyNextAt: 0, errorCode: 'uncertain', errorDetail: 'duplicate_external_id' });
    await run();
    expect(await shipmentRow(sid)).toMatchObject({ state: 'uncertain' });
  });

  test('courier down past 30 minutes: one exception; a later find closes it and ships (check 6a)', async () => {
    const o = await order('confirmed');
    const t = Date.now() - 2 * MIN;
    const sid = await shipment(o, yal, 'uncertain', { attemptedAt: t, attemptEndedAt: t, verifyNextAt: 0, errorCode: 'uncertain', errorDetail: 'timeout' });
    await standin.control('yalidine/scenario', { down: true });
    await run();
    expect(await exceptions('uncertain_send')).toHaveLength(0);
    for (const offset of [31 * MIN, 33 * MIN]) {
      await db().prepare('update shipments set verify_next_at = 0 where id = ?').bind(sid).run();
      await run(at(offset));
    }
    const ex = await exceptions('uncertain_send');
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ state: 'open', count: 1 });
    await standin.control('yalidine/scenario', { down: false });
    await standin.control('yalidine/seed', { parcels: [{ tracking: 'yal-LATER1', order_id: o.ref }] });
    await db().prepare('update shipments set verify_next_at = 0 where id = ?').bind(sid).run();
    await run(at(35 * MIN));
    expect(await orderOf(o.id)).toMatchObject({ status: 'shipped' });
    expect((await exceptions('uncertain_send'))[0]).toMatchObject({ state: 'resolved', resolution: 'parcel_found' });
  });

  test('two parcels with our reference: a person decides, the slot stays (check 13c)', async () => {
    const o = await order('confirmed');
    await standin.control('yalidine/seed', { parcels: [{ tracking: 'yal-TWIN01', order_id: o.ref }, { tracking: 'yal-TWIN02', order_id: o.ref }] });
    const sid = await shipment(o, yal, 'uncertain', { attemptedAt: 1, attemptEndedAt: 1, verifyNextAt: 0, errorCode: 'uncertain', errorDetail: 'timeout' });
    await run();
    expect(await shipmentRow(sid)).toMatchObject({ state: 'uncertain', verify_next_at: null });
    expect((await exceptions('uncertain_send'))[0]).toMatchObject({ detail: 'multiple' });
  });

  test('disabled account or no lookup: a person decides at once (rule 5)', async () => {
    await db().prepare('update courier_accounts set enabled = 0').run();
    const o = await order('confirmed');
    const sid = await shipment(o, yal, 'uncertain', { attemptedAt: 1, attemptEndedAt: 1, verifyNextAt: 0, errorCode: 'uncertain', errorDetail: 'timeout' });
    await run();
    expect(await shipmentRow(sid)).toMatchObject({ state: 'uncertain', verify_next_at: null });
    expect((await exceptions('uncertain_send'))[0]).toMatchObject({ detail: 'account_off' });
  });

  test('stale rows are swept with compare-and-swap (checks 7, 12)', async () => {
    const a = await order('confirmed');
    const b = await order('confirmed');
    const old = Date.now() - 6 * MIN;
    const reserved = await shipment(a, yal, 'reserved', { createdAt: old });
    const sending = await shipment(b, yal, 'sending', { attemptedAt: old, createdAt: old });
    await standin.control('yalidine/scenario', { read: 'down' });
    await run();
    expect(await shipmentRow(reserved)).toMatchObject({ state: 'failed', error_code: 'not_attempted' });
    const s = await shipmentRow(sending);
    expect(s).toMatchObject({ state: 'uncertain', error_detail: 'stale_sending' });
    expect(s['attempt_ended_at']).toEqual(expect.any(Number));
    expect(s['verify_next_at']).toEqual(expect.any(Number));
  });

  test('accepted but not applied: the next run ships it, once (check 17a)', async () => {
    const o = await order('confirmed');
    const sid = await shipment(o, yal, 'accepted', { tracking: 'yal-UNAP01', acceptedAt: Date.now() - 2 * MIN });
    await standin.control('yalidine/scenario', { read: 'down' });
    await run();
    await run();
    expect(await orderOf(o.id)).toMatchObject({ status: 'shipped', version: 1 });
    expect(await shipmentRow(sid)).toMatchObject({ applied_at: expect.any(Number) });
    expect(await statusEvents(o.id)).toHaveLength(1);
    expect(await exceptions()).toHaveLength(0);
  });

  test('a draft promoted by a poll in transit; pending does not promote (check 13a)', async () => {
    const o = await order('confirmed');
    await standin.control('yalidine/seed', { parcels: [{ tracking: 'yal-DRAFT1', order_id: o.ref }] });
    const sid = await shipment(o, yal, 'draft', { tracking: 'yal-DRAFT1', attemptEndedAt: Date.now() });
    await db().prepare('update shipments set validate_attempted_at = 1 where id = ?').bind(sid).run();
    await run();
    expect(await shipmentRow(sid)).toMatchObject({ state: 'draft' });
    await move('yal-DRAFT1', 'En transit');
    await run();
    expect(await shipmentRow(sid)).toMatchObject({ state: 'accepted', courier_status: 'in_transit' });
    expect(await orderOf(o.id)).toMatchObject({ status: 'shipped' });
  });

  test('an old draft goes to a person once (rule 14)', async () => {
    const o = await order('confirmed');
    await shipment(o, yal, 'draft', { tracking: 'yal-OLD001', attemptEndedAt: Date.now() - 6 * MIN });
    await standin.control('yalidine/scenario', { read: 'down' });
    await run();
    await run();
    const ex = await exceptions('draft_unvalidated');
    expect(ex).toHaveLength(1);
    expect(ex[0]!['count']).toBe(1);
  });
});

describe('isolation and the guard', () => {
  test('one account hanging: in the same run another account applies, a stale row is swept, a pending event applies (check 17c)', async () => {
    const gue = await account('guepex', { creds: { apiId: 'standin-id', apiToken: 'standin-token' } });
    const fast = await shippedParcel(yal);
    await move(fast.tracking, 'Livré');
    await standin.control('guepex/scenario', { slowMs: 30_000 });
    const slow = await shippedParcel(gue, 'guepex');
    const stale = await shipment(await order('confirmed'), yal, 'reserved', { createdAt: Date.now() - 6 * MIN });
    const pendingParcel = await shippedParcel(yal);
    await inboxRow(yal, webhookBody(pendingParcel.tracking, 'Livré'));
    const t0 = Date.now();
    const report = await run({ limits: { ACCOUNT_MS: 3000, CALL_MS: 10_000 } });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(report.accountsTimedOut).toContain('guepex');
    expect(await orderOf(fast.id)).toMatchObject({ status: 'delivered' });
    expect(await shipmentRow(stale)).toMatchObject({ state: 'failed' });
    expect(await orderOf(pendingParcel.id)).toMatchObject({ status: 'delivered' });
    expect(await orderOf(slow.id)).toMatchObject({ status: 'shipped' });
    await standin.control('guepex/scenario', { slowMs: 0 });
  });

  test('no stand-in URL outside production: no request leaves (check 28)', async () => {
    const parcel = await shippedParcel(yal);
    await move(parcel.tracking, 'Livré');
    const before = (await standin.state('yalidine')).readCount;
    await run({}, { COURIER_STANDIN_URL: undefined });
    expect((await standin.state('yalidine')).readCount).toBe(before);
    expect(await orderOf(parcel.id)).toMatchObject({ status: 'shipped' });
  });

  test('COURIER_KEYS_KEY unset or wrong: no courier call, the D1 steps still run (checks 20, 26)', async () => {
    const parcel = await shippedParcel(yal);
    await move(parcel.tracking, 'Livré');
    const stale = await shipment(await order('confirmed'), yal, 'reserved', { createdAt: Date.now() - 6 * MIN });
    for (const key of [undefined, btoa('short'), btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))]) await run({}, { COURIER_KEYS_KEY: key });
    expect((await standin.state('yalidine')).readCount).toBe(0);
    expect(await shipmentRow(stale)).toMatchObject({ state: 'failed' });
  });

  test('logs carry no credentials, tokens or customer data (check 18)', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    try {
      const parcel = await shippedParcel(yal);
      await inboxRow(yal, webhookBody(parcel.tracking, 'Livré'), { signature: '0'.repeat(64) });
      await standin.control('yalidine/scenario', { read: '503' });
      await run();
    } finally {
      spy.mockRestore();
    }
    const text = lines.join('\n');
    expect(text).toContain('courier_sync.done');
    for (const secret of ['standin-token', 'standin-id', SECRET, 'Amine', '+213560417403', 'Rue 1']) expect(text).not.toContain(secret);
  });
});
