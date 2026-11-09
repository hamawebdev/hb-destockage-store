// SHIP-6 (SHIP-0 contract rule 14, checks 7, 7a, 10a, 16, 19): /delivery/exceptions on real D1, with
// the courier stand-in for the validate action.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { harness, tokenFor, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertOrder, postAs, refOf, seedGeoAndCatalog, type CatalogFixture } from '../orders/fixtures.ts';
import { startStandin, type Standin } from './standin.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ECO = 'ecotrack-ab-delivery';
let h: Harness;
let standin: Standin;
let cat: CatalogFixture;
let nextRef = 7000;
let yal: number;
let eco: number;
type Row = Record<string, unknown>;

const one = async (q: string, ...b: unknown[]) => (await h.db.prepare(q).bind(...b).first<Row>())!;
const all = async (q: string, ...b: unknown[]) => (await h.db.prepare(q).bind(...b).all<Row>()).results;

async function makeOrder(status: 'confirmed' | 'shipped' = 'confirmed'): Promise<{ id: number; ref: string }> {
  const ref = refOf(nextRef++);
  const id = await insertOrder(dbOf(h.db), cat, { ref, createdAt: 1_800_000_000_000 + nextRef, status });
  return { id, ref };
}

async function shipment(orderId: number, ref: string, state: string, opts: { courier?: string; account?: number; tracking?: string | null; appliedAt?: number | null } = {}): Promise<number> {
  const r = await h.db
    .prepare(
      `insert into shipments (order_id, courier, account_id, state, reference, tracking, cod_amount_dzd, fee_dzd, wilaya_code, commune_id, applied_at, attempted_at, attempt_ended_at, error_code, created_by)
       select id, ?, ?, ?, ref, ?, total_dzd, fee_dzd, wilaya_code, commune_id, ?, 1, 1, 'uncertain', 1 from orders where id = ? returning id`,
    )
    .bind(opts.courier ?? 'yalidine', opts.account ?? yal, state, opts.tracking ?? null, opts.appliedAt ?? null, orderId)
    .first<{ id: number }>();
  void ref;
  return r!.id;
}

async function exception(kind: string, subject: string, opts: { shipmentId?: number; orderId?: number; courier?: string; raw?: string } = {}): Promise<number> {
  const r = await h.db
    .prepare(`insert into delivery_exceptions (kind, subject, shipment_id, order_id, courier, raw_status, detail) values (?, ?, ?, ?, ?, ?, 'test') returning id`)
    .bind(kind, subject, opts.shipmentId ?? null, opts.orderId ?? null, opts.courier ?? 'yalidine', opts.raw ?? '')
    .first<{ id: number }>();
  return r!.id;
}

const resolve = (id: number, data: Record<string, string>, email: string = USERS.logistics) => postAs(h, email, `/delivery/exceptions/${id}/resolve`, data);
const exRow = (id: number) => one('select * from delivery_exceptions where id = ?', id);
const auditFor = (id: number) => all(`select * from audit_log where entity = 'delivery_exceptions' and entity_id = ?`, String(id));
const orderRow = (id: number) => one('select status, version, courier_tracking from orders where id = ?', id);
const shipmentRow = (id: number) => one('select * from shipments where id = ?', id);

beforeAll(async () => {
  h = await harness();
  standin = await startStandin();
  cat = await seedGeoAndCatalog(dbOf(h.db));
  h.env.COURIER_KEYS_KEY = KEY;
  h.env.COURIER_STANDIN_URL = standin.url;
  await postAs(h, USERS.owner, '/delivery/settings/yalidine/keys', { cred_apiId: 'standin-id', cred_apiToken: 'standin-token' });
  await postAs(h, USERS.owner, '/delivery/settings/yalidine/config', { originWilaya: '16' });
  await postAs(h, USERS.owner, '/delivery/settings/yalidine/enable');
  await postAs(h, USERS.owner, `/delivery/settings/${ECO}/keys`, { cred_apiToken: 'standin-token' });
  await postAs(h, USERS.owner, `/delivery/settings/${ECO}/enable`);
  yal = (await one(`select id from courier_accounts where courier = 'yalidine'`))['id'] as number;
  eco = (await one(`select id from courier_accounts where courier = ?`, ECO))['id'] as number;
  expect((await one(`select enabled from courier_accounts where id = ?`, eco))['enabled']).toBe(1);
});
afterAll(async () => {
  standin?.stop();
  await h?.close();
});
beforeEach(async () => {
  await standin.reset();
  await h.db.batch([h.db.prepare('delete from delivery_exceptions'), h.db.prepare('delete from shipment_events'), h.db.prepare('delete from courier_webhook_inbox'), h.db.prepare('delete from shipments')]);
});

describe('roles (check 19)', () => {
  test('confirmer sees, cannot resolve; content cannot see', async () => {
    const id = await exception('invalid_signature', 'c:yalidine');
    expect((await h.as(USERS.confirmer, '/delivery/exceptions')).status).toBe(200);
    expect((await resolve(id, { action: 'acknowledge' }, USERS.confirmer)).status).toBe(403);
    expect((await h.as(USERS.content, '/delivery/exceptions')).status).toBe(403);
    expect(await exRow(id)).toMatchObject({ state: 'open' });
  });
  test('the page lists open ones with their actions, in French and Arabic', async () => {
    const o = await makeOrder();
    const sid = await shipment(o.id, o.ref, 'uncertain');
    await exception('uncertain_send', `s:${sid}`, { shipmentId: sid, orderId: o.id });
    const fr = await (await h.as(USERS.logistics, '/delivery/exceptions')).text();
    expect(fr).toContain('Envoi incertain');
    expect(fr).toContain('Aucun colis');
    expect(fr).toContain(`/orders/${o.ref}#shipment`);
    const ar = await h.as(USERS.ownerAr, '/delivery/exceptions');
    expect(ar.status).toBe(200);
    expect(await ar.text()).toContain('إرسال غير مؤكَّد');
    const confirmer = await (await h.as(USERS.confirmer, '/delivery/exceptions')).text();
    expect(confirmer).not.toContain('/resolve');
  });
});

describe('unknown status (checks 16, 7a)', () => {
  test('treat as delivered: order moves with the person as actor, one audit row; again is refused', async () => {
    const o = await makeOrder('shipped');
    const sid = await shipment(o.id, o.ref, 'accepted', { tracking: 'yal-X1', appliedAt: 1 });
    const id = await exception('unknown_status', `s:${sid}`, { shipmentId: sid, orderId: o.id, raw: 'Bizarre' });
    expect((await resolve(id, { action: 'delivered' })).status).toBe(303);
    expect(await orderRow(o.id)).toMatchObject({ status: 'delivered', version: 1 });
    expect(await exRow(id)).toMatchObject({ state: 'resolved', resolution: 'delivered' });
    const ev = await all(`select * from order_events where order_id = ? and type = 'status_change'`, o.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_type: 'admin' });
    const again = await resolve(id, { action: 'returned' });
    expect(again.status).toBe(409);
    expect(await orderRow(o.id)).toMatchObject({ status: 'delivered', version: 1 });
    expect(await auditFor(id)).toHaveLength(1);
  });
  test('no change closes it without touching the order; an action not offered is refused', async () => {
    const o = await makeOrder('shipped');
    const id = await exception('unknown_status', `s:x${o.id}`, { orderId: o.id, raw: 'Bizarre' });
    expect((await resolve(id, { action: 'no_parcel' })).status).toBe(422);
    expect((await resolve(id, { action: 'no_change' })).status).toBe(303);
    expect(await orderRow(o.id)).toMatchObject({ status: 'shipped', version: 0 });
  });
});

describe('uncertain send (checks 7, 7a, 10a)', () => {
  test('"parcel exists": tracking stored, order shipped, exception closed in the same batch', async () => {
    const o = await makeOrder();
    const sid = await shipment(o.id, o.ref, 'uncertain');
    const id = await exception('uncertain_send', `s:${sid}`, { shipmentId: sid, orderId: o.id });
    expect((await resolve(id, { action: 'parcel_exists', tracking: 'yal-PERSON1' })).status).toBe(303);
    expect(await shipmentRow(sid)).toMatchObject({ state: 'accepted', tracking: 'yal-PERSON1', applied_at: expect.any(Number) });
    expect(await orderRow(o.id)).toMatchObject({ status: 'shipped', courier_tracking: 'yal-PERSON1' });
    expect(await exRow(id)).toMatchObject({ state: 'resolved', resolution: 'parcel_exists' });
    expect(await auditFor(id)).toHaveLength(1);
  });
  test('a tracking already used, or malformed, is refused with a message (check 30)', async () => {
    const a = await makeOrder('shipped');
    await shipment(a.id, a.ref, 'accepted', { tracking: 'yal-USED01', appliedAt: 1 });
    const o = await makeOrder();
    const sid = await shipment(o.id, o.ref, 'uncertain');
    const id = await exception('uncertain_send', `s:${sid}`, { shipmentId: sid, orderId: o.id });
    const used = await resolve(id, { action: 'parcel_exists', tracking: 'yal-USED01' });
    expect(used.status).toBe(409);
    expect(await used.text()).toContain('déjà attaché');
    expect((await resolve(id, { action: 'parcel_exists', tracking: 'bad tracking!' })).status).toBe(422);
    expect(await shipmentRow(sid)).toMatchObject({ state: 'uncertain', tracking: null });
    expect(await exRow(id)).toMatchObject({ state: 'open' });
  });
  test('"no parcel": slot freed, order still confirmed and can now be cancelled (check 10a)', async () => {
    const o = await makeOrder();
    const sid = await shipment(o.id, o.ref, 'uncertain');
    const id = await exception('uncertain_send', `s:${sid}`, { shipmentId: sid, orderId: o.id });
    expect((await resolve(id, { action: 'no_parcel' })).status).toBe(303);
    expect(await shipmentRow(sid)).toMatchObject({ state: 'failed', error_code: 'no_parcel' });
    expect(await orderRow(o.id)).toMatchObject({ status: 'confirmed' });
    expect((await postAs(h, USERS.owner, `/orders/${o.ref}/transition`, { version: '0', to: 'cancelled', reason: 'duplicate' })).status).toBe(303);
    expect(await orderRow(o.id)).toMatchObject({ status: 'cancelled' });
  });
  test('two people at once with opposite answers: one outcome, one audit row (check 7a)', async () => {
    const o = await makeOrder();
    const sid = await shipment(o.id, o.ref, 'uncertain');
    const id = await exception('uncertain_send', `s:${sid}`, { shipmentId: sid, orderId: o.id });
    const [a, b] = await Promise.all([resolve(id, { action: 'no_parcel' }), resolve(id, { action: 'parcel_exists', tracking: 'yal-RACE01' }, USERS.owner)]);
    expect([a.status, b.status].sort()).toEqual([303, 409]);
    expect(await auditFor(id)).toHaveLength(1);
    const sh = await shipmentRow(sid);
    const ord = await orderRow(o.id);
    if (sh['state'] === 'failed') expect(ord).toMatchObject({ status: 'confirmed' });
    else expect(ord).toMatchObject({ status: 'shipped', courier_tracking: 'yal-RACE01' });
  });
  test('the cron got there first: the person is told, nothing written (check 17b, reverse)', async () => {
    const o = await makeOrder();
    const sid = await shipment(o.id, o.ref, 'uncertain');
    const id = await exception('uncertain_send', `s:${sid}`, { shipmentId: sid, orderId: o.id });
    await h.db.prepare(`update shipments set state = 'accepted', tracking = 'yal-CRON01', applied_at = 1 where id = ?`).bind(sid).run();
    const res = await resolve(id, { action: 'no_parcel' });
    expect(res.status).toBe(409);
    expect(await auditFor(id)).toHaveLength(0);
    expect(await shipmentRow(sid)).toMatchObject({ state: 'accepted' });
  });
  test('on a courier with a validation step, "parcel exists" leaves a draft to validate', async () => {
    const o = await makeOrder();
    const sid = await shipment(o.id, o.ref, 'uncertain', { courier: ECO, account: eco });
    const id = await exception('uncertain_send', `s:${sid}`, { shipmentId: sid, orderId: o.id, courier: ECO });
    expect((await resolve(id, { action: 'parcel_exists', tracking: 'ECO123' })).status).toBe(303);
    expect(await shipmentRow(sid)).toMatchObject({ state: 'draft', tracking: 'ECO123' });
    expect(await orderRow(o.id)).toMatchObject({ status: 'confirmed' });
  });
});

describe('drafts', () => {
  test('validate again ships it and closes the exception', async () => {
    const o = await makeOrder();
    await standin.control(`${ECO}/seed`, { parcels: [{ tracking: 'ECODRAFT1', reference: o.ref }] });
    const sid = await shipment(o.id, o.ref, 'draft', { courier: ECO, account: eco, tracking: 'ECODRAFT1' });
    const id = await exception('draft_unvalidated', `s:${sid}`, { shipmentId: sid, orderId: o.id, courier: ECO });
    expect((await resolve(id, { action: 'validate' })).status).toBe(303);
    expect(await orderRow(o.id)).toMatchObject({ status: 'shipped' });
    expect(await exRow(id)).toMatchObject({ state: 'resolved', resolution: 'validate' });
    expect((await standin.state(ECO))['validateCount']).toBe(1);
  });
  test('"no parcel" on a draft: failed, tracking kept, slot freed', async () => {
    const o = await makeOrder();
    const sid = await shipment(o.id, o.ref, 'draft', { courier: ECO, account: eco, tracking: 'ECODRAFT2' });
    const id = await exception('draft_unvalidated', `s:${sid}`, { shipmentId: sid, orderId: o.id, courier: ECO });
    expect((await resolve(id, { action: 'no_parcel' })).status).toBe(303);
    expect(await shipmentRow(sid)).toMatchObject({ state: 'failed', tracking: 'ECODRAFT2' });
  });
});

describe('the other kinds', () => {
  test('"handled" needs a note', async () => {
    const o = await makeOrder('shipped');
    const id = await exception('terminal_conflict', `s:t${o.id}`, { orderId: o.id, raw: 'Livré' });
    expect((await resolve(id, { action: 'handled' })).status).toBe(422);
    expect((await resolve(id, { action: 'handled', note: 'Appelé le client, colis livré' })).status).toBe(303);
    expect(await exRow(id)).toMatchObject({ state: 'resolved', resolution_note: 'Appelé le client, colis livré' });
  });
  test('foreign parcel, acknowledge, and retry of a poison inbox row', async () => {
    const f = await exception('unmatched_tracking', 't:yalidine|yal-OTHER');
    expect((await resolve(f, { action: 'foreign' })).status).toBe(303);
    expect(await exRow(f)).toMatchObject({ resolution: 'foreign' });
    const inbox = (await one(`insert into courier_webhook_inbox (account_id, courier, body, state, attempts) values (?, 'yalidine', x'00', 'poison', 5) returning id`, yal))['id'] as number;
    const p = await exception('inbox_poison', `i:${inbox}`);
    expect((await resolve(p, { action: 'retry' })).status).toBe(303);
    expect(await one('select state, attempts from courier_webhook_inbox where id = ?', inbox)).toMatchObject({ state: 'pending', attempts: 0 });
    const s = await exception('invalid_signature', 'c:yalidine');
    expect((await resolve(s, { action: 'acknowledge' })).status).toBe(303);
    const resolved = await (await h.as(USERS.owner, '/delivery/exceptions?state=resolved')).text();
    expect(resolved).toContain('foreign');
  });
  test('unknown id is 404 and writes nothing', async () => {
    expect((await resolve(999_999, { action: 'acknowledge' })).status).toBe(404);
    void tokenFor;
  });
});
