// AORD-5 (high risk) — shipping hand-off on a real D1 with CSRF: roles, bulk "mark shipped" with
// per-row results, printable slips (confirmed/shipped only, delivery fields only, one audit row with
// refs and no data), delivered/returned back to the screen. Plan: artifacts/AORD-5/plan.md.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, orderEvents, orders, variants } from '@hb/db';
import { harness, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertOrder, postAs, refOf, seedGeoAndCatalog, type CatalogFixture } from './fixtures.ts';

// Real D1 (Miniflare) on a shared, loaded host: explicit budgets so the gate does not time out at random.
// This file's bulk tests make many sequential D1 round trips: 30 s was not enough under load.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let h: Harness;
let cat: CatalogFixture;
let n = 5000;
const NOW = Date.now();

beforeAll(async () => {
  h = await harness();
  cat = await seedGeoAndCatalog(dbOf(h.db));
}, 300_000);
afterAll(async () => {
  await h?.close();
});

const db = () => dbOf(h.db);
async function newOrder(status: 'new' | 'confirmed' | 'shipped', over: { name?: string; flags?: string[]; address?: string } = {}) {
  const ref = refOf(n++);
  const id = await insertOrder(db(), cat, { ref, createdAt: NOW - 1_000_000 + n, status, phone: `+2136${String(30_000_000 + n).slice(-8)}`, name: over.name ?? 'Amina Benali', ...(over.flags ? { flags: over.flags } : {}) });
  if (over.address) await db().update(orders).set({ address: over.address }).where(eq(orders.id, id));
  return { ref, id };
}
const row = async (id: number) => (await db().select().from(orders).where(eq(orders.id, id)))[0]!;
const auditsFor = (id: number) => db().select().from(auditLog).where(and(eq(auditLog.entity, 'orders'), eq(auditLog.entityId, String(id))));
type SlipAuditAfter = { refs: string[]; refused: string[]; count: number; size: string };
const slipAudits = () => db().select().from(auditLog).where(eq(auditLog.action, 'order.slips'));
/** A form with repeated `ref` fields, as the browser sends ticked checkboxes. */
const shipForm = (refs: string[], extra: Record<string, string>) => {
  const p = new URLSearchParams();
  for (const r of refs) p.append('ref', r);
  for (const [k, v] of Object.entries(extra)) p.append(k, v);
  return p;
};
async function postMulti(email: string, path: string, p: URLSearchParams) {
  // postAs takes a flat record; repeated keys need the raw body, with the same CSRF token.
  const { tokenFor } = await import('../helpers.ts');
  p.set('_csrf', await tokenFor(h.db, email));
  return h.as(email, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' },
    body: p.toString(),
  });
}

describe('access', () => {
  test('owner and logistics: 200; confirmer and content: 403 on the screen, ship and slips', async () => {
    expect((await h.as(USERS.owner, '/orders/shipping')).status).toBe(200);
    expect((await h.as(USERS.logistics, '/orders/shipping')).status).toBe(200);
    const o = await newOrder('confirmed');
    for (const u of [USERS.confirmer, USERS.content]) {
      expect((await h.as(u, '/orders/shipping')).status).toBe(403);
      expect((await postMulti(u, '/orders/shipping/ship', shipForm([o.ref], { courierName: 'X', [`version_${o.ref}`]: '0' }))).status).toBe(403);
      expect((await postMulti(u, '/orders/shipping/slips', shipForm([o.ref], {}))).status).toBe(403);
    }
    expect((await row(o.id)).status).toBe('confirmed');
  });
});

describe('screen', () => {
  test('confirmed orders in "ready", shipped in "out"; no risk data for logistics', async () => {
    const c = await newOrder('confirmed', { flags: ['honeypot'] });
    const s = await newOrder('shipped');
    const html = await (await h.as(USERS.logistics, '/orders/shipping')).text();
    const ready = html.slice(html.indexOf('id="ship-ready"'), html.indexOf('id="ship-out"'));
    const out = html.slice(html.indexOf('id="ship-out"'));
    expect(ready).toContain(c.ref);
    expect(out).toContain(s.ref);
    expect(out).not.toContain(c.ref);
    for (const m of ['honeypot', 'Piège anti-robot', 'tentative']) expect(html).not.toContain(m);
    expect(html).toContain('formaction="/orders/shipping/slips"');
  });
});

describe('bulk "mark shipped"', () => {
  test('per-row results: fresh rows shipped, stale version and wrong status untouched', async () => {
    const a = await newOrder('confirmed');
    const b = await newOrder('confirmed');
    const c = await newOrder('confirmed');
    const d = await newOrder('new');
    const res = await postMulti(
      USERS.logistics,
      '/orders/shipping/ship',
      shipForm([a.ref, b.ref, c.ref, d.ref, 'not-a-ref'], {
        courierName: ' Yalidine ',
        [`version_${a.ref}`]: '0',
        [`version_${b.ref}`]: '5',
        [`version_${c.ref}`]: '0',
        [`version_${d.ref}`]: '0',
        [`tracking_${a.ref}`]: ' YAL-001 ',
      }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(new RegExp(`${a.ref}</bdi> : expédiée`));
    expect(html).toMatch(new RegExp(`${b.ref}</bdi> : modifiée entre-temps`));
    expect(html).toMatch(new RegExp(`${d.ref}</bdi> : n’est plus « confirmée »`));
    expect([(await row(a.id)).status, (await row(a.id)).courierName, (await row(a.id)).courierTracking]).toEqual(['shipped', 'Yalidine', 'YAL-001']);
    expect([(await row(c.id)).status, (await row(c.id)).courierTracking]).toEqual(['shipped', null]);
    expect((await row(b.id)).status).toBe('confirmed');
    expect((await row(d.id)).status).toBe('new');
    for (const id of [a.id, c.id]) {
      expect((await auditsFor(id)).map((x) => x.action)).toEqual(['order.transition']);
      expect((await db().select().from(orderEvents).where(eq(orderEvents.orderId, id))).map((e) => [e.fromStatus, e.toStatus])).toEqual([['confirmed', 'shipped']]);
    }
    expect(await auditsFor(b.id)).toHaveLength(0);
  });
  test('review UX-4 r2 N1: no courier → 422 that keeps the ticks and typed tracking numbers', async () => {
    const a = await newOrder('confirmed');
    const res = await postMulti(USERS.owner, '/orders/shipping/ship', shipForm([a.ref], { courierName: '', [`version_${a.ref}`]: '0', [`tracking_${a.ref}`]: 'TRK-77' }));
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toMatch(new RegExp(`name="ref" value="${a.ref}"[^>]*checked`));
    expect(html).toContain(`name="tracking_${a.ref}" value="TRK-77"`);
  });
  test('no courier, nothing ticked, or more than 50 → 422, nothing written', async () => {
    const a = await newOrder('confirmed');
    expect((await postMulti(USERS.owner, '/orders/shipping/ship', shipForm([a.ref], { courierName: '  ', [`version_${a.ref}`]: '0' }))).status).toBe(422);
    expect((await postMulti(USERS.owner, '/orders/shipping/ship', shipForm([], { courierName: 'ZR' }))).status).toBe(422);
    const many = Array.from({ length: 51 }, (_, i) => refOf(90_000 + i));
    const r = await postMulti(USERS.owner, '/orders/shipping/ship', shipForm(many, { courierName: 'ZR' }));
    expect(r.status).toBe(422);
    expect(await r.text()).toContain('Au plus 50 commandes');
    expect((await row(a.id)).status).toBe('confirmed');
  });
  test('two bulk ships of the same order at once: one shipped, one conflict, one audit row', async () => {
    const a = await newOrder('confirmed');
    const send = () => postMulti(USERS.logistics, '/orders/shipping/ship', shipForm([a.ref], { courierName: 'Noest', [`version_${a.ref}`]: '0' }));
    const [x, y] = await Promise.all([send(), send()]);
    const texts = [await x.text(), await y.text()].join('\n');
    expect(texts).toMatch(new RegExp(`${a.ref}</bdi> : expédiée`));
    expect(texts).toMatch(/modifiée entre-temps|n’est plus « confirmée »/);
    expect(await auditsFor(a.id)).toHaveLength(1);
  });
});

describe('slips', () => {
  test('confirmed and shipped printed, others refused; one audit row with refs only', async () => {
    const x = await newOrder('confirmed', { name: 'Karim Haddad', address: 'Cité 200 logements, bloc 4' });
    const y = await newOrder('shipped', { name: 'أمينة بن علي', address: 'حي النصر، عمارة 12' });
    const z = await newOrder('new');
    const res = await postMulti(USERS.logistics, '/orders/shipping/slips', shipForm([x.ref, y.ref, z.ref, 'HB-ZZZZZ'], { size: 'a5' }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('page--print');
    expect(html.match(/<article class="slip slip--a5">/g)).toHaveLength(2);
    expect(html).toContain(`<span class="slip__ref" dir="ltr">${x.ref}</span>`);
    expect(html).toContain('<bdi>Karim Haddad</bdi>');
    expect(html).toContain('<bdi>Cité 200 logements, bloc 4</bdi>');
    expect(html).toContain('<bdi>أمينة بن علي</bdi>');
    expect(html).toMatch(/<span class="slip__phone" dir="ltr">0\d{9}<\/span>/);
    expect(html).toContain('Montant à encaisser');
    expect(html).toContain('المبلغ المطلوب تحصيله');
    expect(html).toContain('0560417403');
    expect(html).toContain('Non imprimées');
    expect(html).toContain(`<bdi dir="ltr">${z.ref}</bdi>`);
    // This print's own row, found by its refs: never by counting the table, which another test's
    // late request could change.
    const mine = (await slipAudits()).filter((r) => (r.after as SlipAuditAfter).refs.includes(x.ref));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.after).toEqual({ refs: [x.ref, y.ref], count: 2, refused: [z.ref, 'HB-ZZZZZ'], size: 'a5' });
    const json = JSON.stringify(mine[0]);
    for (const pii of ['Karim', 'Haddad', 'أمينة', 'Cité', '+213', '0560']) expect(json).not.toContain(pii);
  });
  test('no sensitive data on a slip', async () => {
    const x = await newOrder('confirmed', { flags: ['honeypot', 'duplicate'] });
    await db().update(orders).set({ riskScore: 91, ipHash: 'IPHASH-slip-1', callAttempts: 3 }).where(eq(orders.id, x.id));
    const html = await (await postMulti(USERS.owner, '/orders/shipping/slips', shipForm([x.ref], {}))).text();
    for (const m of ['honeypot', 'duplicate', 'IPHASH-slip-1', '>91<', 'tentative', 'Doublon']) expect(html, m).not.toContain(m);
    expect(html).toContain('<article class="slip">');
  });
  test('a NULL (or blank) address prints a dash: no "null", no empty <bdi>', async () => {
    const x = await newOrder('confirmed');
    const y = await newOrder('confirmed');
    await db().update(orders).set({ address: null }).where(eq(orders.id, x.id));
    await db().update(orders).set({ address: '   ' }).where(eq(orders.id, y.id));
    const html = await (await postMulti(USERS.logistics, '/orders/shipping/slips', shipForm([x.ref, y.ref], {}))).text();
    const slips = html.split('<article class="slip">').slice(1);
    expect(slips).toHaveLength(2);
    for (const s of slips) {
      const block = s.slice(0, s.indexOf('<div class="slip__cols">')); // recipient, phone, address
      expect(block).toMatch(/Adresse<\/span> \/ <span lang="ar" dir="rtl">العنوان<\/span><\/span>—<\/div>/);
      expect(block).not.toContain('<bdi></bdi>');
      expect(block).not.toMatch(/<bdi>\s*<\/bdi>/);
    }
    expect(html).not.toContain('null');
    const screen = await (await h.as(USERS.logistics, '/orders/shipping')).text();
    expect(screen).not.toContain('>null<');
    expect(screen).not.toMatch(/<bdi>\s*<\/bdi>/);
  });
  test('nothing ticked → 422; no audit row', async () => {
    expect((await postMulti(USERS.owner, '/orders/shipping/slips', shipForm([], {}))).status).toBe(422);
    // Every print row names at least one ref (printed or refused); an empty request must leave none.
    const empty = (await slipAudits()).filter((r) => {
      const after = r.after as SlipAuditAfter;
      return after.refs.length === 0 && after.refused.length === 0;
    });
    expect(empty).toHaveLength(0);
  });
  test('no inline script/style on the print page', async () => {
    const x = await newOrder('confirmed');
    const html = await (await postMulti(USERS.owner, '/orders/shipping/slips', shipForm([x.ref], {}))).text();
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)|\sstyle=|\son[a-z]+=/);
  });
});

describe('delivered / returned from the screen', () => {
  test('back to /orders/shipping; a return restores stock once', async () => {
    await db().update(variants).set({ stock: 4 }).where(eq(variants.id, cat.variantA));
    const d = await newOrder('shipped');
    const r = await newOrder('shipped');
    const resD = await postAs(h, USERS.logistics, `/orders/${d.ref}/transition`, { version: '0', to: 'delivered', return: 'shipping' });
    expect(resD.status).toBe(303);
    expect(resD.headers.get('Location')).toBe('/orders/shipping?m=saved');
    expect((await postAs(h, USERS.logistics, `/orders/${r.ref}/transition`, { version: '0', to: 'returned', return: 'shipping' })).status).toBe(303);
    expect((await row(d.id)).status).toBe('delivered');
    expect((await row(r.id)).status).toBe('returned');
    expect((await db().select({ s: variants.stock }).from(variants).where(eq(variants.id, cat.variantA)))[0]!.s).toBe(5);
  });
});
