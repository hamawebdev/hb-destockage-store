// SHIP-3 (SHIP-0 contract checks 2, 2a, 3, 4, 5, 7, 8, 9, 9a, 10, 11, 13a, 19, 24, 25, 25a, 25b):
// sending parcels, on real D1 with the real courier stand-in as a child process.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { harness, tokenFor, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertOrder, postAs, refOf, seedGeoAndCatalog, type CatalogFixture } from '../orders/fixtures.ts';
import { startStandin, type Standin } from './standin.ts';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
let h: Harness;
let standin: Standin;
let cat: CatalogFixture;
let nextRef = 1000;

type Row = Record<string, unknown>;
const db = () => dbOf(h.db);
const CONFIRMED = { status: 'confirmed' as const };

async function makeOrder(over: Partial<Parameters<typeof insertOrder>[2]> = {}): Promise<{ id: number; ref: string }> {
  const ref = refOf(nextRef++);
  const id = await insertOrder(db(), cat, { ref, createdAt: 1_800_000_000_000 + nextRef, ...CONFIRMED, ...over });
  return { id, ref };
}

function postRefs(email: string, path: string, refs: string[], extra: Record<string, string> = {}) {
  return (async () => {
    const body = new URLSearchParams({ _csrf: await tokenFor(h.db, email) });
    for (const ref of refs) body.append('ref', ref);
    for (const ref of new Set(refs)) {
      if (extra[`version_${ref}`] === undefined) body.append(`version_${ref}`, '0');
      if (extra[`address_${ref}`] === undefined) body.append(`address_${ref}`, '12 rue des Oliviers');
      if (extra[`type_${ref}`] === undefined) body.append(`type_${ref}`, 'home');
    }
    if (extra['courier'] === undefined) body.append('courier', 'yalidine');
    for (const [k, v] of Object.entries(extra)) body.append(k, v);
    return h.as(email, path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' }, body: body.toString() });
  })();
}
const confirm = (refs: string[], extra: Record<string, string> = {}, email: string = USERS.logistics) => postRefs(email, '/delivery/send/confirm', refs, extra);
const rowsOf = async (orderId: number) => (await h.db.prepare('select * from shipments where order_id = ? order by id').bind(orderId).all<Row>()).results;
const orderRow = async (id: number) => (await h.db.prepare('select status, version, courier_tracking, courier_name, address, total_dzd, fee_dzd from orders where id = ?').bind(id).first<Row>())!;
const statusEvents = async (id: number) => (await h.db.prepare(`select * from order_events where order_id = ? and type = 'status_change'`).bind(id).all<Row>()).results;
const auditFor = async (shipmentId: unknown) => (await h.db.prepare(`select * from audit_log where entity = 'shipments' and entity_id = ?`).bind(String(shipmentId)).all<Row>()).results;
const creates = async (courier = 'yalidine') => (await standin.state(courier)).createCount;
/** Resolves once the stand-in has received the create call, so a test acts while it is in flight. */
async function createInFlight(courier = 'yalidine'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if ((await creates(courier)) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the create call never reached the stand-in');
}

async function setupCourier(courier = 'yalidine', creds: Record<string, string> = { cred_apiId: 'standin-id', cred_apiToken: 'standin-token' }) {
  await postAs(h, USERS.owner, `/delivery/settings/${courier}/keys`, creds);
  await postAs(h, USERS.owner, `/delivery/settings/${courier}/config`, { originWilaya: '16' });
  const res = await postAs(h, USERS.owner, `/delivery/settings/${courier}/enable`);
  expect(res.status).toBe(303);
}

/** Loads the courier's lists for an order's wilaya, as the sending page does. */
const loadLists = async (ref: string) => {
  const res = await postRefs(USERS.logistics, '/delivery/send', [ref], { [`type_${ref}`]: 'home' });
  expect(res.status).toBe(200);
};

beforeAll(async () => {
  h = await harness();
  standin = await startStandin();
  cat = await seedGeoAndCatalog(db());
  h.env.COURIER_KEYS_KEY = KEY;
  h.env.COURIER_STANDIN_URL = standin.url;
  await standin.control('yalidine/scenario', { quota: false });
  await setupCourier();
  const first = await makeOrder();
  await loadLists(first.ref);
});
afterAll(async () => {
  standin?.stop();
  await h?.close();
});
beforeEach(async () => {
  await standin.reset();
  await standin.control('yalidine/scenario', { quota: false });
  await h.db.batch([h.db.prepare('delete from delivery_exceptions'), h.db.prepare('delete from shipment_events'), h.db.prepare('delete from shipments')]);
});

describe('one parcel', () => {
  test('a parcel goes out: tracking, order shipped, one event, one audit row, COD from the order (check 24)', async () => {
    const { id, ref } = await makeOrder();
    const before = await orderRow(id);
    const res = await confirm([ref], { cod: '1', price: '1', totalDzd: '1' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Envoyée');
    expect(await creates()).toBe(1);
    const [row] = await rowsOf(id);
    expect(row).toMatchObject({ state: 'accepted', courier: 'yalidine', cod_amount_dzd: before['total_dzd'], fee_dzd: before['fee_dzd'] });
    expect(row!['tracking']).toEqual(expect.any(String));
    expect(row!['applied_at']).toEqual(expect.any(Number));
    expect(await orderRow(id)).toMatchObject({ status: 'shipped', version: 1, courier_tracking: row!['tracking'], courier_name: 'Yalidine', address: '12 rue des Oliviers', total_dzd: before['total_dzd'], fee_dzd: before['fee_dzd'] });
    expect(await statusEvents(id)).toHaveLength(1);
    const audits = await auditFor(row!['id']);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_type: 'admin' });
    const last = (await standin.state('yalidine'))['lastCreate'] as unknown;
    if (last) expect(JSON.stringify(last)).toContain(String(before['total_dzd']));
  });

  test('the sending page itself writes nothing and calls nothing for a cached order (check 2a)', async () => {
    const { id, ref } = await makeOrder();
    const before = (await standin.state('yalidine')).readCount;
    const res = await postRefs(USERS.logistics, '/delivery/send', [ref]);
    expect(res.status).toBe(200);
    expect(await rowsOf(id)).toHaveLength(0);
    expect(await creates()).toBe(0);
    expect((await standin.state('yalidine')).readCount).toBe(before);
  });

  test('two sends at once: one parcel (check 2), loser told it is being sent', async () => {
    const { id, ref } = await makeOrder();
    await standin.control('yalidine/scenario', { slowMs: 700 });
    const [a, b] = await Promise.all([confirm([ref]), confirm([ref])]);
    const bodies = [await a.text(), await b.text()];
    expect(await creates()).toBe(1);
    expect(await rowsOf(id)).toHaveLength(1);
    expect(bodies.filter((t) => t.includes('Déjà en cours d’envoi'))).toHaveLength(1);
    expect(bodies.filter((t) => t.includes('Envoyée'))).toHaveLength(1);
    expect((await orderRow(id))['status']).toBe('shipped');
    expect(await statusEvents(id)).toHaveLength(1);
  });

  test('sent again after accept, or at a stale version, or not confirmed: nothing happens (checks 3, 4)', async () => {
    const { id, ref } = await makeOrder();
    await confirm([ref]);
    const again = await confirm([ref]);
    expect(await again.text()).toContain('Commande non confirmée');
    expect(await creates()).toBe(1);
    const stale = await makeOrder();
    expect(await (await confirm([stale.ref], { [`version_${stale.ref}`]: '7' })).text()).toContain('La commande a changé');
    expect(await rowsOf(stale.id)).toHaveLength(0);
    const fresh = await makeOrder({ status: 'called' });
    expect(await (await confirm([fresh.ref])).text()).toContain('Commande non confirmée');
    expect(await creates()).toBe(1);
    expect(await rowsOf(id)).toHaveLength(1);
  });

  test('courier rejects: slot freed, order unchanged, a person can resend', async () => {
    const { id, ref } = await makeOrder();
    await standin.control('yalidine/scenario', { create: 'reject' });
    const res = await confirm([ref]);
    expect(await res.text()).toContain('Refusée par le transporteur');
    expect((await rowsOf(id))[0]).toMatchObject({ state: 'failed' });
    expect((await orderRow(id))['status']).toBe('confirmed');
    await standin.control('yalidine/scenario', { create: 'ok' });
    await confirm([ref]);
    expect((await orderRow(id))['status']).toBe('shipped');
    expect(await rowsOf(id)).toHaveLength(2);
  });

  test('create-then-hang: uncertain within the limit, order confirmed, nothing resent (check 5)', async () => {
    const { id, ref } = await makeOrder();
    await standin.control('yalidine/scenario', { create: 'create-then-hang' });
    const t0 = Date.now();
    const res = await confirm([ref]);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(await res.text()).toContain('Résultat incertain');
    expect((await rowsOf(id))[0]).toMatchObject({ state: 'uncertain', error_code: 'uncertain' });
    expect((await orderRow(id))['status']).toBe('confirmed');
    await confirm([ref]);
    expect(await creates()).toBe(1);
  });

  test('the slot blocks a real cancel during the call (check 10), and the order still ships', async () => {
    const { id, ref } = await makeOrder();
    await standin.control('yalidine/scenario', { slowMs: 3000 });
    const sending = confirm([ref]);
    await createInFlight();
    const cancel = await postAs(h, USERS.owner, `/orders/${ref}/transition`, { version: '0', to: 'cancelled', reason: 'duplicate' });
    // The 409 page is adminui's routes/orders case (SHIP-0 rule 19); here: refused, nothing written.
    expect(cancel.status).not.toBe(303);
    expect((await orderRow(id))['status']).toBe('confirmed');
    await sending;
    expect((await orderRow(id))['status']).toBe('shipped');
    expect(await creates()).toBe(1);
  });

  test('version bumped during the call: tracking stored, order shipped after a retry (check 9)', async () => {
    const { id, ref } = await makeOrder();
    await standin.control('yalidine/scenario', { slowMs: 3000 });
    const sending = confirm([ref]);
    await createInFlight();
    expect((await postAs(h, USERS.owner, `/orders/${ref}/note`, { version: '0', text: 'appel client' })).status).toBe(303);
    expect((await orderRow(id))['version']).toBe(1);
    await sending;
    expect(await orderRow(id)).toMatchObject({ status: 'shipped' });
    expect((await rowsOf(id))[0]).toMatchObject({ state: 'accepted' });
    expect((await rowsOf(id))[0]!['applied_at']).toEqual(expect.any(Number));
  });

  test('fee changed during a live slot is refused (check 9a)', async () => {
    const { id, ref } = await makeOrder();
    await standin.control('yalidine/scenario', { create: 'create-then-hang' });
    await confirm([ref]);
    await expect(h.db.prepare('update orders set fee_dzd = fee_dzd + 100, total_dzd = total_dzd + 100 where id = ?').bind(id).run()).rejects.toThrow(/shipment_in_progress/);
  });

  test('D1 failing on the accept batch: not lost, the row ends uncertain, no second create (check 8)', async () => {
    const { id, ref } = await makeOrder();
    const real = h.env.DB;
    let failNext = true;
    h.env.DB = new Proxy(real, {
      get(target, prop) {
        if (prop === 'batch') {
          return (stmts: D1PreparedStatement[]) => {
            if (failNext && stmts.length > 3) {
              failNext = false;
              return Promise.reject(new Error('D1_ERROR: injected'));
            }
            return target.batch(stmts);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    try {
      const res = await confirm([ref]);
      expect(await res.text()).toContain('Résultat incertain');
    } finally {
      h.env.DB = real;
    }
    const [row] = await rowsOf(id);
    expect(row).toMatchObject({ state: 'uncertain', error_detail: 'accept_write_failed' });
    expect(row!['tracking']).toEqual(expect.any(String));
    expect(await creates()).toBe(1);
    expect((await orderRow(id))['status']).toBe('confirmed');
  });
});

describe('bulk (check 11)', () => {
  test('a mix: per-order results, one bad order does not stop the others', async () => {
    const good = [await makeOrder(), await makeOrder(), await makeOrder()];
    const rejectedOrder = await makeOrder({ wilaya: 'oran' });
    await loadLists(rejectedOrder.ref);
    const notConfirmed = await makeOrder({ status: 'new' });
    const stale = await makeOrder();
    await standin.control('yalidine/scenario', { undeliverableCommunes: ['Bir El Djir'] });
    const refs = [...good.map((o) => o.ref), rejectedOrder.ref, notConfirmed.ref, stale.ref, good[0]!.ref];
    const res = await confirm(refs, { [`version_${stale.ref}`]: '3' });
    const html = await res.text();
    expect(res.status).toBe(200);
    for (const o of good) expect((await orderRow(o.id))['status']).toBe('shipped');
    expect((await orderRow(rejectedOrder.id))['status']).toBe('confirmed');
    expect((await rowsOf(rejectedOrder.id))[0]).toMatchObject({ state: 'failed' });
    expect(html).toContain('Commande non confirmée');
    expect(html).toContain('La commande a changé');
    expect(await creates()).toBe(4); // the duplicated ref was sent once
    expect(await rowsOf(good[0]!.id)).toHaveLength(1);
  });

  test('worst case, every call hanging: under 25 s, the rest are not attempted and free to retry', async () => {
    const list = await Promise.all(Array.from({ length: 12 }, () => makeOrder()));
    await standin.control('yalidine/scenario', { create: 'hang-no-create' });
    const t0 = Date.now();
    const res = await confirm(list.map((o) => o.ref));
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(25_000);
    const html = await res.text();
    expect(html).toContain('Résultat incertain');
    expect(html).toContain('temps écoulé');
    const notAttempted = (await Promise.all(list.map((o) => rowsOf(o.id)))).filter((rows) => rows.length === 0);
    expect(notAttempted.length).toBeGreaterThan(0);
    await standin.control('yalidine/scenario', { create: 'ok' });
  }, 60_000);

  test('a 429 mid-batch stops new calls; the rest are not attempted', async () => {
    const list = await Promise.all(Array.from({ length: 9 }, () => makeOrder()));
    await standin.control('yalidine/scenario', { create: '429' });
    const res = await confirm(list.map((o) => o.ref));
    const html = await res.text();
    expect(html).toContain('le transporteur a demandé d’arrêter');
    expect(await creates()).toBeLessThanOrEqual(3);
  });

  test('more than 50 refs are refused, and each input is validated (check 24)', async () => {
    const res = await confirm(Array.from({ length: 51 }, (_v, i) => refOf(5000 + i)));
    expect(res.status).toBe(422);
    const { ref, id } = await makeOrder();
    expect((await confirm([ref], { [`address_${ref}`]: 'x'.repeat(301) })).status).toBe(422);
    expect((await confirm([ref], { courier: 'nope' })).status).toBe(422);
    expect((await confirm([ref], { courier: 'guepex' })).status).toBe(422);
    expect(await rowsOf(id)).toHaveLength(0);
    expect(await creates()).toBe(0);
  });
});

describe('wilayas 59 to 69 (check 24)', () => {
  const geo = JSON.parse(readFileSync(new URL('../../../../data/geo/communes.json', import.meta.url).pathname.replaceAll('%20', ' '), 'utf8')) as { id: number; wilaya_code: number; name_fr: string; name_ar: string }[];
  test.each([59, 62, 69])('an order in wilaya %i ships through its parent', async (code) => {
    const commune = geo.find((c) => c.wilaya_code === code)!;
    await h.db.batch([
      h.db.prepare('insert or ignore into wilayas (code, name_fr, name_ar) values (?, ?, ?)').bind(code, `W${code}`, `و${code}`),
      h.db.prepare('insert or ignore into communes (id, wilaya_code, name_fr, name_ar) values (?, ?, ?, ?)').bind(commune.id, code, commune.name_fr, commune.name_ar),
    ]);
    const { id, ref } = await makeOrder();
    await h.db.prepare('update orders set wilaya_code = ?, commune_id = ? where id = ?').bind(code, commune.id, id).run();
    await loadLists(ref);
    const res = await confirm([ref]);
    expect(await res.text()).toContain('Envoyée');
    expect((await orderRow(id))['status']).toBe('shipped');
    const parcels = (await standin.state('yalidine'))['parcels'] as Record<string, { to_wilaya_name: string }> | { to_wilaya_name: string }[];
    expect(JSON.stringify(parcels)).not.toContain(`W${code}`);
  });
});

describe('roles and the panel (check 19)', () => {
  test('sending needs delivery.send', async () => {
    const { ref, id } = await makeOrder();
    for (const email of [USERS.confirmer, USERS.content]) {
      expect((await postRefs(email, '/delivery/send', [ref])).status).toBe(403);
      expect((await confirm([ref], {}, email)).status).toBe(403);
    }
    expect(await rowsOf(id)).toHaveLength(0);
  });
  test('the waybill: roles, unknown id, no-store, courier hanging (check 25b)', async () => {
    const { id, ref } = await makeOrder();
    await confirm([ref]);
    const sid = (await rowsOf(id))[0]!['id'];
    expect((await h.as(USERS.content, `/delivery/shipments/${sid}/waybill`)).status).toBe(403);
    expect((await h.as(USERS.owner, '/delivery/shipments/999999/waybill')).status).toBe(404);
    const ok = await h.as(USERS.confirmer, `/delivery/shipments/${sid}/waybill`);
    expect([200, 302]).toContain(ok.status);
    expect(ok.headers.get('cache-control') ?? '').toContain('no-store');
    await standin.control('yalidine/scenario', { read: 'down', down: true });
    const t0 = Date.now();
    const down = await h.as(USERS.owner, `/delivery/shipments/${sid}/waybill`);
    expect(Date.now() - t0).toBeLessThan(9000);
    expect([302, 503]).toContain(down.status);
  });
  test('the panel reads D1 only and shows the anchor', async () => {
    const { fetchShipmentPanel, ShipmentPanel } = await import('../../src/routes/delivery/panel.tsx');
    const { id, ref } = await makeOrder();
    expect(await fetchShipmentPanel(db(), id)).toBeNull();
    await confirm([ref]);
    const reads = (await standin.state('yalidine')).readCount;
    const data = await fetchShipmentPanel(db(), id);
    expect(data!.shipment.state).toBe('accepted');
    expect((await standin.state('yalidine')).readCount).toBe(reads);
    const html = String(ShipmentPanel({ lang: 'fr', user: { role: 'logistics' }, data, now: 1 }));
    expect(html).toContain('id="shipment"');
  });
});

describe('courier down (check 25)', () => {
  test.each([['down', { down: true }], ['hanging', { slowMs: 30_000 }]] as const)('stand-in %s: other pages stay fast', async (_n, scenario) => {
    await standin.control('yalidine/scenario', scenario);
    for (const p of ['/orders', '/delivery/settings']) {
      await h.as(USERS.owner, p); // warm: the first render compiles the route
      const t0 = Date.now();
      expect((await h.as(USERS.owner, p)).status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(2000);
    }
    await standin.control('yalidine/scenario', { down: false, slowMs: 0 });
  });
  test('sending page with 50 orders across many uncached wilayas, stand-in hanging: under 8 s (check 25a)', async () => {
    await h.db.prepare(`delete from courier_directory where kind <> 'wilayas'`).run();
    await standin.control('yalidine/scenario', { slowMs: 30_000 });
    const codes = Array.from({ length: 24 }, (_v, i) => 30 + i);
    await h.db.batch(codes.map((code) => h.db.prepare('insert or ignore into wilayas (code, name_fr, name_ar) values (?, ?, ?)').bind(code, `W${code}`, `و${code}`)));
    await h.db.batch(codes.map((code) => h.db.prepare('insert or ignore into communes (id, wilaya_code, name_fr, name_ar) values (?, ?, ?, ?)').bind(90_000 + code, code, `C${code}`, `ب${code}`)));
    // One at a time: 50 concurrent inserts overrun the local D1 proxy on a loaded machine.
    const list: { id: number; ref: string }[] = [];
    for (let i = 0; i < 50; i++) {
      const o = await makeOrder();
      const code = codes[i % codes.length]!;
      await h.db.prepare('update orders set wilaya_code = ?, commune_id = ? where id = ?').bind(code, 90_000 + code, o.id).run();
      list.push(o);
    }
    const t0 = Date.now();
    const res = await postRefs(USERS.logistics, '/delivery/send', list.map((o) => o.ref));
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(await res.text()).toContain('Liste du transporteur non chargée');
    await standin.control('yalidine/scenario', { slowMs: 0 });
  }, 300_000); // setup inserts 50 orders one by one; only the request itself is held to 8 s
});
