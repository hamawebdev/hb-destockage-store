// AORD-4 (high risk) — customers on a real D1 with CSRF: fields per role (customers.sensitive),
// logistics raw-HTML leak test, search normalisation, keyset, block/unblock (reason, audit, 409),
// notes optimistic check. No export, no delete.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, customers, orders } from '@hb/db';
import { harness, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertOrder, postAs, refOf, seedGeoAndCatalog } from './fixtures.ts';

// Real D1 (Miniflare) on a shared, loaded host: explicit budgets so the gate does not time out at random.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let h: Harness;
const NOW = Date.now();
const NOTE = 'CUSTNOTE-a-surveiller-9031';
const FLAG = 'frequent_returns_x7';
const REF = refOf(71);
let mohamed = 0; // sensitive data on it
let plain = 0;
let percent = 0;

beforeAll(async () => {
  h = await harness();
  const db = dbOf(h.db);
  const cat = await seedGeoAndCatalog(db);
  await insertOrder(db, cat, { ref: REF, createdAt: NOW - 86_400_000, status: 'delivered', phone: '+213661000071', name: 'Mohamed Benali' });
  const [m] = await db.select({ id: customers.id }).from(customers).where(eq(customers.phoneE164, '+213661000071'));
  mohamed = m!.id;
  await db
    .update(customers)
    .set({ notes: NOTE, flags: [FLAG], orderCount: 9, deliveredCount: 4, returnedCount: 3, cancelledCount: 2, lastOrderAt: NOW - 86_400_000, createdAt: NOW - 1000 })
    .where(eq(customers.id, mohamed));
  [{ id: plain }] = (await db.insert(customers).values({ phoneE164: '+213770000072', name: 'أمينة بن علي', createdAt: NOW - 2000 }).returning({ id: customers.id })) as [{ id: number }];
  [{ id: percent }] = (await db.insert(customers).values({ phoneE164: '+213770000073', name: 'Taux 100% Sur_Place', createdAt: NOW - 3000 }).returning({ id: customers.id })) as [{ id: number }];
  // 60 more for paging, three per timestamp.
  const rows = Array.from({ length: 60 }, (_, i) => ({ phoneE164: `+21355${String(1_000_000 + i).slice(-7)}`, name: `Client ${i}`, createdAt: NOW - 100_000 - Math.floor(i / 3) * 1000 }));
  const ins = rows.map((r) => db.insert(customers).values(r));
  await db.batch(ins as [(typeof ins)[number], ...(typeof ins)[number][]]);
}, 300_000);

afterAll(async () => {
  await h?.close();
});

const db = () => dbOf(h.db);
const page = async (email: string, path: string) => {
  const res = await h.as(email, path);
  return { status: res.status, html: await res.text() };
};
const names = (html: string) => [...html.matchAll(/<a href="\/customers\/\d+"><bdi>([^<]+)<\/bdi><\/a>/g)].map((m) => m[1]);
const audits = (id: number, action: string) => db().select().from(auditLog).where(and(eq(auditLog.entityId, String(id)), eq(auditLog.action, action)));
const cust = async (id: number) => (await db().select().from(customers).where(eq(customers.id, id)))[0]!;

describe('access', () => {
  test('content: 403 everywhere; no user: 401', async () => {
    expect((await page(USERS.content, '/customers')).status).toBe(403);
    expect((await page(USERS.content, `/customers/${mohamed}`)).status).toBe(403);
    expect((await postAs(h, USERS.content, `/customers/${mohamed}/block`, { reason: 'abcdefg' })).status).toBe(403);
    expect((await h.as(null, '/customers')).status).toBe(401);
  });
  test('logistics may read, never write', async () => {
    expect((await page(USERS.logistics, '/customers')).status).toBe(200);
    expect((await page(USERS.logistics, `/customers/${mohamed}`)).status).toBe(200);
    for (const a of ['block', 'unblock', 'notes']) {
      expect((await postAs(h, USERS.logistics, `/customers/${plain}/${a}`, { reason: 'motif valable', notes: 'x' })).status, a).toBe(403);
    }
  });
  test('confirmer may not unblock (owner only)', async () => {
    expect((await postAs(h, USERS.confirmer, `/customers/${plain}/unblock`, { reason: 'motif valable' })).status).toBe(403);
  });
  test('unknown or malformed id → 404', async () => {
    expect((await page(USERS.owner, '/customers/999999')).status).toBe(404);
    expect((await page(USERS.owner, '/customers/abc')).status).toBe(404);
  });
});

describe('logistics: name, phone, created date — nothing else (raw HTML)', () => {
  const MARKERS = [NOTE, FLAG, 'Bloqué', 'Historique', 'Livrées', 'Retournées', 'Dernière commande', REF, 'name="blocked"', 'name="flagged"', 'name="returns"', 'name="notes"', 'name="reason"', 'Notes internes', '>9<'];
  test('list and detail', async () => {
    await db().update(customers).set({ blocked: true }).where(eq(customers.id, mohamed));
    for (const path of ['/customers', `/customers?q=0661000071`, `/customers/${mohamed}`, '/customers?blocked=1&flagged=1&returns=1']) {
      const { html } = await page(USERS.logistics, path);
      expect(html, path).toContain('Mohamed Benali');
      for (const m of MARKERS) expect(html, `${path}: ${m}`).not.toContain(m);
    }
    const { html } = await page(USERS.logistics, '/customers?blocked=1');
    expect(html).toContain('filtres d’alerte (réservés à la confirmation)');
    await db().update(customers).set({ blocked: false }).where(eq(customers.id, mohamed));
  });
  test('customer flags show FR/AR labels; an unknown code stays visible as itself', async () => {
    await db().update(customers).set({ flags: ['frequent_returns', 'honeypot', FLAG] }).where(eq(customers.id, plain));
    const fr = (await page(USERS.confirmer, `/customers/${plain}`)).html;
    expect(fr).toContain('Retours fréquents');
    expect(fr).toContain('Piège anti-robot rempli');
    expect(fr).toContain(FLAG);
    expect(fr).not.toContain('>frequent_returns<');
    const ar = (await page(USERS.ownerAr, `/customers/${plain}`)).html;
    expect(ar).toContain('مرتجعات متكررة');
    expect((await page(USERS.confirmer, '/customers')).html).toContain('Retours fréquents');
    await db().update(customers).set({ flags: [] }).where(eq(customers.id, plain));
  });
  test('the same markers are shown to a confirmer', async () => {
    await db().update(customers).set({ blocked: true }).where(eq(customers.id, mohamed));
    const { html } = await page(USERS.confirmer, `/customers/${mohamed}`);
    for (const m of [NOTE, FLAG, 'Historique', 'Livrées', REF, 'name="notes"']) expect(html, m).toContain(m);
    expect((await page(USERS.confirmer, '/customers')).html).toContain('Bloqué');
    await db().update(customers).set({ blocked: false }).where(eq(customers.id, mohamed));
  });
});

describe('search', () => {
  test.each(['Mohamed', 'mohamed  ', 'MOHAMED benali', '  mohamed   benali '])('name %j finds Mohamed Benali (case, spaces)', async (q) => {
    expect(names((await page(USERS.owner, `/customers?q=${encodeURIComponent(q)}`)).html)).toEqual(['Mohamed Benali']);
  });
  test('Arabic name, Eastern-Arabic phone (exact), invalid phone falls back to name', async () => {
    expect(names((await page(USERS.owner, `/customers?q=${encodeURIComponent('بن علي')}`)).html)).toEqual(['أمينة بن علي']);
    expect(names((await page(USERS.owner, `/customers?q=${encodeURIComponent('٠٧٧٠٠٠٠٠٧٢')}`)).html)).toEqual(['أمينة بن علي']);
    expect(names((await page(USERS.owner, '/customers?q=0501234567')).html)).toEqual([]);
  });
  test('% and _ are literal (no LIKE)', async () => {
    expect(names((await page(USERS.owner, `/customers?q=${encodeURIComponent('%')}`)).html)).toEqual(['Taux 100% Sur_Place']);
    expect(names((await page(USERS.owner, `/customers?q=${encodeURIComponent('r_p')}`)).html)).toEqual(['Taux 100% Sur_Place']);
  });
  test('risk filters (sensitive roles)', async () => {
    expect(names((await page(USERS.owner, '/customers?flagged=1')).html)).toEqual(['Mohamed Benali']);
    expect(names((await page(USERS.owner, '/customers?returns=1')).html)).toEqual(['Mohamed Benali']);
  });
});

describe('keyset pagination', () => {
  test('63 customers → 50 + 13, no duplicates, newest first', async () => {
    const first = await page(USERS.owner, '/customers');
    const a = names(first.html);
    expect(a).toHaveLength(50);
    expect(a.slice(0, 3)).toEqual(['Mohamed Benali', 'أمينة بن علي', 'Taux 100% Sur_Place']);
    const next = /<a [^>]*rel="next" href="([^"]+)"/.exec(first.html)![1]!.replaceAll('&amp;', '&');
    const b = names((await page(USERS.owner, next)).html);
    expect(b).toHaveLength(13);
    expect(new Set([...a, ...b]).size).toBe(63);
  });
});

describe('block / unblock', () => {
  test('a reason is required (min 5 characters) → 422, nothing written', async () => {
    const res = await postAs(h, USERS.confirmer, `/customers/${plain}/block`, { reason: 'abc' });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('au moins 5 caractères');
    expect((await cust(plain)).blocked).toBe(false);
    expect(await audits(plain, 'customer.block')).toHaveLength(0);
  });
  test('confirmer blocks: 303, blocked, one audit row with the reason; the page says who and when', async () => {
    const res = await postAs(h, USERS.confirmer, `/customers/${plain}/block`, { reason: 'Refuse tous les colis' });
    expect(res.status).toBe(303);
    expect((await cust(plain)).blocked).toBe(true);
    const a = await audits(plain, 'customer.block');
    expect(a).toHaveLength(1);
    expect(a[0]!.after).toEqual({ blocked: true, reason: 'Refuse tous les colis' });
    const { html } = await page(USERS.owner, `/customers/${plain}`);
    expect(html).toContain('Bloqué par <bdi>Confirmer</bdi>, le');
    expect(html).toContain('Motif : <bdi>Refuse tous les colis</bdi>');
    expect(html).toContain('action="/customers/' + plain + '/unblock"');
  });
  test('blocking again → 409, no second audit row', async () => {
    const res = await postAs(h, USERS.owner, `/customers/${plain}/block`, { reason: 'encore une fois' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('déjà bloqué');
    expect(await audits(plain, 'customer.block')).toHaveLength(1);
  });
  test('blocking leaves the customer’s existing orders untouched', async () => {
    const [o] = await db().select({ status: orders.status, version: orders.version }).from(orders).where(eq(orders.ref, REF));
    const blockRes = await postAs(h, USERS.owner, `/customers/${mohamed}/block`, { reason: 'test effet commandes' });
    expect(blockRes.status).toBe(303);
    const [after] = await db().select({ status: orders.status, version: orders.version }).from(orders).where(eq(orders.ref, REF));
    expect(after).toEqual(o);
  });
  test('owner unblocks with a reason: 303, one audit row; unblocking again → 409', async () => {
    expect((await postAs(h, USERS.owner, `/customers/${plain}/unblock`, { reason: 'Erreur de saisie' })).status).toBe(303);
    expect((await cust(plain)).blocked).toBe(false);
    expect((await audits(plain, 'customer.unblock'))[0]!.after).toEqual({ blocked: false, reason: 'Erreur de saisie' });
    expect((await postAs(h, USERS.owner, `/customers/${plain}/unblock`, { reason: 'Erreur de saisie' })).status).toBe(409);
    expect(await audits(plain, 'customer.unblock')).toHaveLength(1);
  });
  test('two users block at once: one 303, one 409, one audit row', async () => {
    const [x, y] = await Promise.all([
      postAs(h, USERS.owner, `/customers/${percent}/block`, { reason: 'motif owner' }),
      postAs(h, USERS.confirmer, `/customers/${percent}/block`, { reason: 'motif confirmer' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([303, 409]);
    expect(await audits(percent, 'customer.block')).toHaveLength(1);
  });
});

describe('notes', () => {
  test('save: 303, audit before/after; same text → 422; stale "seen" → 409, nothing written', async () => {
    const id = plain;
    expect((await postAs(h, USERS.confirmer, `/customers/${id}/notes`, { seen: '', notes: 'Préfère être appelée le soir' })).status).toBe(303);
    expect((await cust(id)).notes).toBe('Préfère être appelée le soir');
    expect((await audits(id, 'customer.notes'))[0]!.after).toEqual({ notes: 'Préfère être appelée le soir' });
    expect((await postAs(h, USERS.confirmer, `/customers/${id}/notes`, { seen: 'Préfère être appelée le soir', notes: 'Préfère être appelée le soir' })).status).toBe(422);
    const stale = await postAs(h, USERS.owner, `/customers/${id}/notes`, { seen: '', notes: 'Autre texte' });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain('modifiées par quelqu’un d’autre');
    expect((await cust(id)).notes).toBe('Préfère être appelée le soir');
    expect(await audits(id, 'customer.notes')).toHaveLength(1);
  });
});

describe('rendering', () => {
  test('list and order history stack below 600 px (admin-core .tbl-stack)', async () => {
    expect((await page(USERS.owner, '/customers')).html).toContain('class="table tbl-stack"');
    expect((await page(USERS.owner, `/customers/${mohamed}`)).html).toContain('class="table tbl-stack"');
  });
  test('Arabic: rtl, Arabic labels, phone LTR-isolated; unique ids; no inline script/style', async () => {
    const { html } = await page(USERS.ownerAr, `/customers/${mohamed}`);
    expect(html).toMatch(/<html[^>]*dir="rtl"/);
    expect(html).toMatch(/السبب: <bdi>[^<]+<\/bdi>/);
    expect(html).toContain('ملاحظات داخلية');
    expect(html).toContain('<bdi dir="ltr">06 61 00 00 71</bdi>');
    for (const path of ['/customers', `/customers/${mohamed}`]) {
      const p = await page(USERS.owner, path);
      const ids = [...p.html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size, path).toBe(ids.length);
      expect(p.html).not.toMatch(/<script(?![^>]*\bsrc=)|\sstyle=|\son[a-z]+=/);
    }
  });
});
