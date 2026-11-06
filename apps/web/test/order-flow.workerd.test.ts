// End to end on a real local D1 (workerd + db's DB-4 createOrder): created, replay, concurrent
// same-key race, dedup, the last-unit race, server totals, the no-JS review → confirm → 303 path,
// Turnstile accepted-and-flagged. Plan WEB-0 §3, §4, §10.
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { OrderResponseSchema } from '@hb/shared';
import { createDb } from '@hb/db';
import { transitionOrder } from '@hb/db/orders';
import { postForm, postJson, startSeeded, type Started } from './support/harness.ts';

let h: Started;
beforeAll(async () => {
  h = await startSeeded();
});
afterAll(async () => {
  await h?.server.close();
});

let seq = 0;
const freshPhone = () => `0770${String(200000 + seq++).padStart(6, '0')}`;
const e164 = (national: string) => `+213${national.slice(1)}`;

function order(over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: crypto.randomUUID(),
    lang: 'ar',
    items: [{ variantId: 11, qty: 1 }],
    name: 'محمد أمين',
    phone: freshPhone(),
    wilayaCode: 16,
    communeId: 1601,
    expectedTotalDzd: 15200,
    website: '',
    fillMs: 9000,
    ...over,
  };
}

async function send(body: unknown) {
  const res = await postJson(h.server, '/api/order', body);
  const json = (await res.json()) as Record<string, unknown>;
  if (!v.safeParse(OrderResponseSchema, json).success) throw new Error(`not an OrderResponse: ${JSON.stringify(json)}`);
  return { status: res.status, json };
}

const one = <T>(sql: string, ...binds: unknown[]) => h.env.DB.prepare(sql).bind(...binds).first<T>();
const count = async (sql: string, ...binds: unknown[]) => (await one<{ n: number }>(sql, ...binds))!.n;

describe('JSON order, real D1', () => {
  test('201: order, items (snapshots), customer, created event, stock untouched for untracked; server totals', async () => {
    const body = order({ items: [{ variantId: 11, qty: 2 }], expectedTotalDzd: 29800, phone: '٠٧٧٠١٢٣٤٥٦' });
    const { status, json } = await send(body);
    expect(status).toBe(201);
    expect(json).toMatchObject({ ok: true, status: 'new', duplicate: false, subtotalDzd: 29200, feeDzd: 600, totalDzd: 29800 });
    const ref = json['ref'] as string;
    expect(json['confirmationUrl']).toBe(`/ar/order/confirmation/?ref=${ref}`);
    const o = await one<Record<string, unknown>>(`select * from orders where ref = ?`, ref);
    expect(o).toMatchObject({
      idempotency_key: body.idempotencyKey,
      phone_e164: '+213770123456',
      name: 'محمد أمين',
      wilaya_code: 16,
      commune_id: 1601,
      lang: 'ar',
      status: 'new',
      subtotal_dzd: 29200,
      fee_dzd: 600,
      total_dzd: 29800,
      fee_source: 'table',
      turnstile: 'missing',
      fill_ms: 9000,
      risk_score: 20,
    });
    expect(JSON.parse(o!['flags'] as string)).toEqual(['turnstile_missing']);
    const items = await h.env.DB.prepare(`select variant_id, name_fr, name_ar, sku, unit_price_dzd, qty, line_total_dzd from order_items where order_id = ?`).bind(o!['id']).all();
    expect(items.results).toEqual([{ variant_id: 11, name_fr: 'Pack cuisine', name_ar: 'حزمة المطبخ', sku: 'PK-CUI', unit_price_dzd: 14600, qty: 2, line_total_dzd: 29200 }]);
    expect(await count(`select count(*) n from order_events where order_id = ? and type = 'created'`, o!['id'])).toBe(1);
    expect(await one(`select stock from variants where id = 11`)).toEqual({ stock: null });
  });

  test('tracked stock is decremented by the order', async () => {
    await h.env.DB.prepare(`update variants set stock = 3 where id = 21`).run();
    const { status } = await send(order({ items: [{ variantId: 21, qty: 2 }], expectedTotalDzd: 31600 }));
    expect(status).toBe(201);
    expect(await one(`select stock from variants where id = 21`)).toEqual({ stock: 1 });
  });

  test('idempotent replay: same key → same ref, 201 (same as the first answer), one row, no second decrement', async () => {
    await h.env.DB.prepare(`update variants set stock = 5 where id = 21`).run();
    const body = order({ items: [{ variantId: 21, qty: 1 }], expectedTotalDzd: 16100 });
    const a = await send(body);
    const b = await send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json).toEqual(a.json);
    expect(await count(`select count(*) n from orders where idempotency_key = ?`, body.idempotencyKey)).toBe(1);
    expect(await one(`select stock from variants where id = 21`)).toEqual({ stock: 4 });
  });

  test('10 concurrent submits with one key → one order, every answer has the same ref', async () => {
    const body = order();
    const results = await Promise.all(Array.from({ length: 10 }, () => send(body)));
    expect(new Set(results.map((r) => r.json['ref'])).size).toBe(1);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await count(`select count(*) n from orders where idempotency_key = ?`, body.idempotencyKey)).toBe(1);
  });

  test('genuine double submit (same phone, variant, name, wilaya, commune; new key) → existing order, 201, flagged, no new row', async () => {
    const phone = freshPhone();
    const first = await send(order({ phone }));
    const second = await send(order({ phone, name: ' محمد   أمين', items: [{ variantId: 11, qty: 2 }], expectedTotalDzd: 29800 }));
    expect(second.status).toBe(201);
    expect(second.json).toMatchObject({ ref: first.json['ref'], duplicate: true, totalDzd: 15200 });
    expect(await count(`select count(*) n from orders where phone_e164 = ?`, e164(phone))).toBe(1);
    const o = await one<{ flags: string; id: number }>(`select id, flags from orders where ref = ?`, first.json['ref']);
    expect(JSON.parse(o!.flags)).toContain('duplicate');
    expect(await one(`select note from order_events where order_id = ? and outcome = 'duplicate_submit'`, o!.id)).toEqual({
      note: 'duplicate submit: items=11x2 wilaya=16 commune=1601',
    });
  });

  test('same phone + variant but another name → a NEW order flagged duplicate; the first order is never disclosed', async () => {
    const phone = freshPhone();
    const first = await send(order({ phone, items: [{ variantId: 11, qty: 2 }], expectedTotalDzd: 29800 }));
    const probe = await send(order({ phone, name: 'Curious Person', communeId: 1602 }));
    expect(probe.status).toBe(201);
    expect(probe.json['ref']).not.toBe(first.json['ref']);
    expect(probe.json).toMatchObject({ duplicate: false, subtotalDzd: 14600, totalDzd: 15200 });
    expect(JSON.stringify(probe.json)).not.toContain(first.json['ref'] as string);
    expect(await count(`select count(*) n from orders where phone_e164 = ?`, e164(phone))).toBe(2);
    expect(JSON.parse((await one<{ flags: string }>(`select flags from orders where ref = ?`, probe.json['ref']))!.flags)).toEqual(['turnstile_missing', 'duplicate']);
  });

  test('a real replay and a sunk decoy are indistinguishable (status, headers, body shape)', async () => {
    const real = order();
    await send(real);
    const replay = await postJson(h.server, '/api/order', real);
    const decoy = order({ website: 'http://x', fillMs: 200 });
    await postJson(h.server, '/api/order', decoy);
    const decoyAgain = await postJson(h.server, '/api/order', decoy);
    expect(replay.status).toBe(decoyAgain.status);
    const names = (r: { headers: Headers | { keys(): IterableIterator<string> } }) => [...r.headers.keys()].filter((k) => k !== 'date').sort();
    expect(names(replay)).toEqual(names(decoyAgain));
    for (const k of names(replay)) if (k !== 'content-length') expect(replay.headers.get(k), k).toBe(decoyAgain.headers.get(k));
    const a = (await replay.json()) as Record<string, unknown>;
    const b = (await decoyAgain.json()) as Record<string, unknown>;
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect({ ...a, ref: '', confirmationUrl: '' }).toEqual({ ...b, ref: '', confirmationUrl: '' });
  });

  test('dedup does not merge a different variant', async () => {
    await h.env.DB.prepare(`update variants set stock = 5 where id = 21`).run();
    const phone = freshPhone();
    expect((await send(order({ phone }))).status).toBe(201);
    expect((await send(order({ phone, items: [{ variantId: 21, qty: 1 }], expectedTotalDzd: 16100 }))).status).toBe(201);
  });

  test('last unit: two customers race for stock 1 → one 201, one 409 out_of_stock; stock 0, never −1', async () => {
    await h.env.DB.prepare(`update variants set stock = 1 where id = 21`).run();
    const [a, b] = await Promise.all([
      send(order({ items: [{ variantId: 21, qty: 1 }], expectedTotalDzd: 16100 })),
      send(order({ items: [{ variantId: 21, qty: 1 }], expectedTotalDzd: 16100 })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json).toMatchObject({ ok: false, code: 'out_of_stock', lines: [{ variantId: 21, maxQty: 0 }] });
    expect(await one(`select stock from variants where id = 21`)).toEqual({ stock: 0 });
  });

  test('Turnstile token without a configured secret → accepted, turnstile=error, flagged turnstile_invalid', async () => {
    const { status, json } = await send(order({ turnstileToken: 'XXXX.DUMMY.TOKEN' }));
    expect(status).toBe(201);
    const o = await one<{ turnstile: string; flags: string }>(`select turnstile, flags from orders where ref = ?`, json['ref']);
    expect(o!.turnstile).toBe('error');
    expect(JSON.parse(o!.flags)).toEqual(['turnstile_invalid']);
  });

  test('ip_hash stored salted when CF-Connecting-IP is present; never the IP', async () => {
    const res = await postJson(h.server, '/api/order', order(), { 'CF-Connecting-IP': '105.98.7.7' });
    const json = (await res.json()) as { ref: string };
    const o = await one<{ ip_hash: string }>(`select ip_hash from orders where ref = ?`, json.ref);
    expect(o!.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(o!.ip_hash).not.toContain('105');
  });

  test('honeypot + fast fill → decoy 201, nothing stored', async () => {
    const body = order({ website: 'http://x', fillMs: 200 });
    const { status, json } = await send(body);
    expect(status).toBe(201);
    expect(await count(`select count(*) n from orders where ref = ? or idempotency_key = ?`, json['ref'], body.idempotencyKey)).toBe(0);
  });
});

describe('stock taken by /api/order and restored on cancel (DB-4 r2 rule)', () => {
  let adminId = 0;
  async function cancel(ref: string) {
    if (adminId === 0) {
      await h.env.DB.prepare(`insert into admin_users (email, name, role) values ('owner@example.dz', 'Owner', 'owner') on conflict(email) do nothing`).run();
      adminId = (await one<{ id: number }>(`select id from admin_users where email = 'owner@example.dz'`))!.id;
    }
    // new → called (first call) → cancelled: the shared state machine's path for a refusal on the phone.
    for (const to of ['called', 'cancelled'] as const) {
      const o = (await one<{ id: number; version: number }>(`select id, version from orders where ref = ?`, ref))!;
      const r = await transitionOrder(createDb(h.env.DB), o.id, to, { userId: adminId, role: 'owner' }, to === 'cancelled' ? 'customer_refused' : null, o.version);
      expect(r.ok, `${to}: ${JSON.stringify(r)}`).toBe(true);
    }
  }

  test('tracked variant: the order records the units taken and a cancel gives exactly them back', async () => {
    await h.env.DB.prepare(`update variants set stock = 4 where id = 21`).run();
    const { status, json } = await send(order({ items: [{ variantId: 21, qty: 3 }], expectedTotalDzd: 3 * 15500 + 600 }));
    expect(status).toBe(201);
    expect(await one(`select stock from variants where id = 21`)).toEqual({ stock: 1 });
    expect(await one(`select stock_taken from order_items i join orders o on o.id = i.order_id where o.ref = ?`, json['ref'])).toEqual({ stock_taken: 3 });
    await cancel(json['ref'] as string);
    expect(await one(`select stock from variants where id = 21`)).toEqual({ stock: 4 });
  });

  test('untracked at order time: nothing taken, and a cancel adds nothing even if the variant is tracked since', async () => {
    await h.env.DB.prepare(`update variants set stock = null where id = 11`).run();
    const { json } = await send(order());
    expect(await one(`select stock_taken from order_items i join orders o on o.id = i.order_id where o.ref = ?`, json['ref'])).toEqual({ stock_taken: 0 });
    await h.env.DB.prepare(`update variants set stock = 2 where id = 11`).run();
    try {
      await cancel(json['ref'] as string);
      expect(await one(`select stock from variants where id = 11`)).toEqual({ stock: 2 });
    } finally {
      await h.env.DB.prepare(`update variants set stock = null where id = 11`).run();
    }
  });
});

describe('no-JS review → confirm → 303, real D1', () => {
  function hidden(html: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) out[m[1]!] = m[2]!;
    return out;
  }

  test('confirm creates the order and redirects to the confirmation page; confirm again → same ref', async () => {
    const phone = freshPhone();
    const review = await postForm(h.server, '/api/order', { lang: 'fr', variantId: '11', qty: '1', name: 'Amine', phone, wilayaCode: '16', website: '' });
    const f = hidden(await review.text());
    await new Promise((r) => setTimeout(r, 1600)); // a human reads the review page (MIN_REVIEW_MS 1.5 s)
    const fields = { ...f, name: 'Amine', phone, communeId: '1602' };
    const res = await postForm(h.server, '/api/order', fields);
    expect(res.status).toBe(303);
    const loc = res.headers.get('location')!;
    expect(loc).toMatch(/^\/fr\/order\/confirmation\/\?ref=HB-[0-9A-HJKMNP-TV-Z]{5}$/);
    const ref = new URL(loc, 'http://x').searchParams.get('ref');
    const o = await one<{ commune_id: number; fill_ms: number; flags: string; turnstile: string; idempotency_key: string }>(
      `select commune_id, fill_ms, flags, turnstile, idempotency_key from orders where ref = ?`,
      ref,
    );
    expect(o).toMatchObject({ commune_id: 1602, turnstile: 'missing', idempotency_key: f['idempotencyKey'] });
    expect(o!.fill_ms).toBeGreaterThanOrEqual(1500);
    expect(JSON.parse(o!.flags)).toEqual(['turnstile_missing']);
    // Refresh / double click on confirm: same order.
    const again = await postForm(h.server, '/api/order', fields);
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe(loc);
    // And the confirmation page shows the ref.
    expect(await (await h.server.fetch(loc)).text()).toContain(`<bdi data-hb="ref">${ref}</bdi>`);
  });

  test('confirm too fast after review → accepted and flagged fast_fill', async () => {
    const phone = freshPhone();
    const f = hidden(await (await postForm(h.server, '/api/order', { lang: 'ar', variantId: '11', qty: '1', name: 'أمين', phone, wilayaCode: '16' })).text());
    const res = await postForm(h.server, '/api/order', { ...f, name: 'أمين', phone, communeId: '1601' });
    expect(res.status).toBe(303);
    const ref = new URL(res.headers.get('location')!, 'http://x').searchParams.get('ref');
    expect(JSON.parse((await one<{ flags: string }>(`select flags from orders where ref = ?`, ref))!.flags)).toEqual(['fast_fill', 'turnstile_missing']);
  });
});
