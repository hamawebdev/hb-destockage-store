// AORD-1 — orders list over a real D1 (wrangler getPlatformProxy) with the DB-1 migrations.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { formatPhoneDisplay } from '@hb/shared';
import { formatMoney } from '../../src/ui/format.tsx';
import { ordersListQuery } from '../../src/routes/orders/list-data.ts';
import { parseOrdersFilter } from '../../src/routes/orders/list-query.ts';
import { harness, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertOrder, insertOrdersBulk, refOf, seedGeoAndCatalog } from './fixtures.ts';

// Real D1 (Miniflare) on a shared, loaded host: explicit budgets so the gate does not time out at random.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let h: Harness;

const at = (y: number, mo: number, d: number, hh: number, mi = 0) => Date.UTC(y, mo - 1, d, hh, mi);

const N = {
  n1: refOf(1),
  n2: refOf(2),
  n3: refOf(3),
  n4: refOf(4),
  n5: refOf(5),
  n6: refOf(6),
  n7: refOf(7),
};
const BULK = 120;

beforeAll(async () => {
  h = await harness();
  const db = dbOf(h.db);
  const cat = await seedGeoAndCatalog(db);
  await insertOrder(db, cat, { ref: N.n1, createdAt: at(2026, 11, 4, 10), status: 'new' });
  // 23:30 UTC on 3 Nov = 00:30 on 4 Nov in Algiers.
  await insertOrder(db, cat, {
    ref: N.n2, createdAt: at(2026, 11, 3, 23, 30), status: 'called', callAttempts: 2, wilaya: 'oran',
    name: 'Karim Haddad', phone: '+213661234567', flags: ['fast_fill'],
  });
  await insertOrder(db, cat, {
    ref: N.n3, createdAt: at(2026, 11, 2, 12), status: 'unreachable', callAttempts: 3,
    name: 'أمينة بن علي', phone: '+213770000001', flags: ['duplicate', 'turnstile_missing'],
  });
  await insertOrder(db, cat, {
    ref: N.n4, createdAt: at(2026, 11, 1, 12), status: 'confirmed', phone: '+213770000004', name: 'Nadia',
    items: [['A', 2], ['B', 1]],
  });
  await insertOrder(db, cat, {
    ref: N.n5, createdAt: at(2026, 10, 31, 12), status: 'shipped', phone: '+213550000005', name: 'Yacine',
    blockedCustomer: true, flags: ['blocked_customer', 'future_flag'],
  });
  await insertOrder(db, cat, { ref: N.n6, createdAt: at(2026, 10, 30, 12), status: 'delivered', phone: '+213550000006' });
  await insertOrder(db, cat, { ref: N.n7, createdAt: at(2026, 10, 29, 12), status: 'cancelled', phone: '+213550000007' });
  // 120 returned orders, three per timestamp (ties exercise the id tie-breaker), ids ascending with i.
  await insertOrdersBulk(
    db,
    cat,
    Array.from({ length: BULK }, (_, i) => ({ ref: refOf(100 + i), createdAt: at(2026, 9, 1, 12) - Math.floor(i / 3) * 1000, status: 'returned' as const })),
    '+213550000099',
  );
}, 300_000);

afterAll(async () => {
  await h?.close();
});

async function page(email: string, query = ''): Promise<{ status: number; html: string }> {
  const res = await h.as(email, `/orders${query ? `?${query}` : ''}`);
  return { status: res.status, html: await res.text() };
}

/** Refs of the table rows, in order. */
function refs(html: string): string[] {
  return [...html.matchAll(/<tr data-key="\d+">([\s\S]*?)<\/tr>/g)].map((m) => /HB-[0-9A-Z]{5}/.exec(m[1]!)?.[0] ?? '?');
}

function rowOf(html: string, ref: string): string {
  const row = [...html.matchAll(/<tr data-key="\d+">([\s\S]*?)<\/tr>/g)].find((m) => m[1]!.includes(ref));
  if (!row) throw new Error(`row ${ref} not found`);
  return row[1]!;
}

function nextHref(html: string): string | null {
  const m = /<a [^>]*rel="next" href="([^"]+)"/.exec(html);
  return m ? m[1]!.replaceAll('&amp;', '&') : null;
}

describe('access', () => {
  test('content role gets 403 and no order data', async () => {
    const r = await page(USERS.content);
    expect(r.status).toBe(403);
    expect(r.html).not.toContain(N.n1);
  });
  test('no user → 401', async () => {
    const res = await h.as(null, '/orders');
    expect(res.status).toBe(401);
  });
  test.each([USERS.owner, USERS.confirmer, USERS.logistics])('%s gets 200', async (u) => {
    expect((await page(u)).status).toBe(200);
  });
});

describe('default view per role', () => {
  test('confirmer: new, called, unreachable only', async () => {
    expect(refs((await page(USERS.confirmer)).html)).toEqual([N.n1, N.n2, N.n3]);
  });
  test('logistics: confirmed and shipped only', async () => {
    expect(refs((await page(USERS.logistics)).html)).toEqual([N.n4, N.n5]);
  });
  test('owner: everything, newest first', async () => {
    const r = refs((await page(USERS.owner)).html);
    expect(r.slice(0, 7)).toEqual([N.n1, N.n2, N.n3, N.n4, N.n5, N.n6, N.n7]);
    expect(r).toHaveLength(50);
  });
  test('status=any overrides the role default', async () => {
    expect(refs((await page(USERS.confirmer, 'status=any')).html).slice(0, 7)).toEqual(Object.values(N));
  });
  test('review UX-1 r1 I1: the All tab keeps status=any through the filter form; a default view does not', async () => {
    const hidden = '<input type="hidden" name="status" value="any"/>';
    expect((await page(USERS.confirmer, 'status=any&wilaya=31')).html).toContain(hidden);
    expect((await page(USERS.confirmer)).html).not.toContain(hidden);
    const confirmer = refs((await page(USERS.confirmer, 'status=any&wilaya=16')).html);
    expect(confirmer).toContain(N.n4); // confirmed: outside the confirmer's default statuses
    expect(confirmer).toEqual(refs((await page(USERS.owner, 'status=any&wilaya=16')).html));
  });
  test('review UX-1 r1 I5: the language switch returns to this list with its filters, without the flash', async () => {
    const html = (await page(USERS.owner, 'status=confirmed&wilaya=16&m=saved')).html;
    expect(html).toContain('name="return_to" value="/orders?status=confirmed&amp;wilaya=16"');
  });
});

describe('search', () => {
  test('a search finds an order outside the role default (confirmer finds a shipped order by ref)', async () => {
    expect(refs((await page(USERS.confirmer, `q=${N.n5}`)).html)).toEqual([N.n5]);
  });
  test('ref without prefix, lower case', async () => {
    expect(refs((await page(USERS.owner, `q=${encodeURIComponent(N.n5.slice(3).toLowerCase())}`)).html)).toEqual([N.n5]);
  });
  test('phone typed with Eastern-Arabic digits', async () => {
    const q = encodeURIComponent('٠٦٦١٢٣٤٥٦٧');
    expect(refs((await page(USERS.owner, `q=${q}`)).html)).toEqual([N.n2]);
  });
  test('name substring, Arabic and case-insensitive Latin', async () => {
    expect(refs((await page(USERS.owner, `q=${encodeURIComponent('بن علي')}`)).html)).toEqual([N.n3]);
    expect(refs((await page(USERS.owner, 'q=karim')).html)).toEqual([N.n2]);
  });
  test('a 64-char Arabic name (128 bytes) does not hit the D1 LIKE limit', async () => {
    const r = await page(USERS.owner, `q=${encodeURIComponent('ب'.repeat(64))}`);
    expect(r.status).toBe(200);
    expect(refs(r.html)).toEqual([]);
  });
});

describe('filters', () => {
  test('wilaya', async () => {
    expect(refs((await page(USERS.owner, 'status=any&wilaya=31')).html)).toEqual([N.n2]);
  });
  test('date range uses Algiers calendar days', async () => {
    expect(refs((await page(USERS.owner, 'from=2026-11-04&to=2026-11-04')).html)).toEqual([N.n1, N.n2]);
    const r = await page(USERS.owner, 'from=2026-11-03&to=2026-11-03');
    expect(refs(r.html)).toEqual([]);
    expect(r.html).toContain('Aucune commande ne correspond');
  });
  test('flagged, duplicate, blocked customer', async () => {
    expect(refs((await page(USERS.owner, 'flagged=1')).html)).toEqual([N.n2, N.n3, N.n5]);
    expect(refs((await page(USERS.owner, 'duplicate=1')).html)).toEqual([N.n3]);
    expect(refs((await page(USERS.owner, 'blocked=1')).html)).toEqual([N.n5]);
  });
  test('combined filters', async () => {
    expect(refs((await page(USERS.owner, 'status=unreachable&status=called&flagged=1&wilaya=16')).html)).toEqual([N.n3]);
  });
  test('invalid values are reported, not fatal', async () => {
    const r = await page(USERS.owner, 'wilaya=99&from=2026-02-30');
    expect(r.status).toBe(200);
    expect(r.html).toContain('Certains filtres étaient invalides');
    expect(r.html).toContain('wilaya');
    expect(r.html).toContain('date de début');
  });
});

describe('keyset pagination', () => {
  test('120 rows → 50 + 50 + 20, no duplicates, no gaps, filters kept', async () => {
    const seen: string[] = [];
    let href: string | null = '/orders?status=returned';
    const sizes: number[] = [];
    while (href) {
      const res = await h.as(USERS.owner, href);
      const html = await res.text();
      const r = refs(html);
      sizes.push(r.length);
      seen.push(...r);
      href = nextHref(html);
      if (href) expect(href).toContain('status=returned');
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(BULK);
    // created_at desc, then id desc: groups of three share a timestamp and come out reversed.
    const expected = Array.from({ length: BULK / 3 }, (_, g) => [2, 1, 0].map((k) => refOf(100 + g * 3 + k))).flat();
    expect(seen).toEqual(expected);
  });
});

describe('rendering', () => {
  test('ref and phone isolated in <bdi dir="ltr">, fee and total shown', async () => {
    const html = (await page(USERS.owner, 'status=any')).html;
    const row = rowOf(html, N.n4);
    expect(row).toContain(`<bdi dir="ltr">${N.n4}</bdi>`);
    expect(row).toContain(`<a class="row-link" href="/orders/${N.n4}">`);
    expect(row).toContain(`<bdi dir="ltr">${formatPhoneDisplay('+213770000004')}</bdi>`);
    expect(row).toContain(formatMoney('fr', 600));
    expect(row).toContain(formatMoney('fr', 14_600 * 2 + 16_500 + 600));
    expect(row).toContain('Pack cuisine — Rouge × 2 + 1 autre');
  });
  test('status, attempt count, flags (known labelled, unknown raw), blocked customer', async () => {
    const html = (await page(USERS.owner, 'status=any')).html;
    expect(rowOf(html, N.n2)).toContain('tentative 2');
    expect(rowOf(html, N.n2)).toContain('Remplie trop vite');
    const n5 = rowOf(html, N.n5);
    expect(n5).toContain('Expédiée');
    expect(n5).toContain('future_flag');
    expect(n5).toContain('badge--danger');
  });
  test('Arabic UI: rtl document, Arabic labels and place names', async () => {
    const html = (await page(USERS.ownerAr, 'status=any')).html;
    expect(html).toMatch(/<html[^>]*dir="rtl"/);
    const row = rowOf(html, N.n1);
    expect(row).toContain('جديد');
    expect(row).toContain('الجزائر');
    expect(row).toContain(`<bdi dir="ltr">${N.n1}</bdi>`);
  });
  test('no inline script, style attribute or handler', async () => {
    const html = (await page(USERS.owner)).html;
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/);
  });
  test('stacks into label/value cards below 600 px (admin-core .tbl-stack), every cell labelled', async () => {
    const html = (await page(USERS.owner, 'status=any')).html;
    expect(html).toContain('class="table tbl-stack table--rows tbl-orders"');
    expect(rowOf(html, N.n1)).toContain('data-label="Réf."');
    expect(rowOf(html, N.n1)).toContain('data-label="Total"');
  });
  test('the filter form is a GET form (no CSRF token needed, nothing mutates)', async () => {
    const html = (await page(USERS.owner)).html;
    expect(html).toMatch(/<form action="\/orders" method="get"/);
  });
});

describe('query plans on D1 (indexes from DB-1)', () => {
  async function plan(query: string): Promise<string> {
    const { filter } = parseOrdersFilter(new URLSearchParams(query), 'owner');
    const { sql, params } = ordersListQuery(dbOf(h.db), filter, true).toSQL();
    const r = await h.db.prepare(`explain query plan ${sql}`).bind(...params).all<{ detail: string }>();
    return r.results.map((x) => x.detail).join('\n');
  }
  test.each([
    ['status=new', 'orders_status_created_idx'],
    ['q=0560417403', 'orders_phone_created_idx'],
    [`q=${refOf(1)}`, 'orders_ref_uq'],
    ['status=any&flagged=1', 'orders_flagged_created_idx'],
    ['status=any', 'orders_created_idx'],
  ])('%s uses %s', async (q, idx) => {
    expect(await plan(q)).toContain(idx);
  });
});
