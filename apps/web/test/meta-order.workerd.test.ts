// The real route on real workerd and D1, against the local stand-in for Meta (META-3). The Worker
// runs with ENV=test and a loopback META_GRAPH_BASE, the only destination it will use outside
// production. Digests were computed separately with `printf '<number>' | sha256sum`.
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { postForm, postJson, startSeeded, TEST_SECRETS, type Started } from './support/harness.ts';
import { startMetaStandIn, type MetaStandIn } from './support/meta-stand-in.ts';

const PIXEL = '000000000000000';
const TOKEN = 'FAKE_TEST_TOKEN';
const FBP = 'fb.1.1596403881668.1116446470';
const UA = { 'User-Agent': 'Mozilla/5.0 (meta-order test)', 'CF-Connecting-IP': '203.0.113.7' };

let standIn: MetaStandIn;
let h: Started;
beforeAll(async () => {
  standIn = await startMetaStandIn();
  h = await startSeeded({ ...TEST_SECRETS, META_PIXEL_ID: PIXEL, META_ACCESS_TOKEN: TOKEN, META_GRAPH_BASE: standIn.url });
});
afterAll(async () => {
  await h?.server.close();
  await standIn?.close().catch(() => {});
});
beforeEach(() => standIn.reset());

let seq = 0;
const freshPhone = () => `0771${String(300000 + seq++).padStart(6, '0')}`;
const consent = { meta: { consent: true, fbp: FBP } };

const order = (over: Record<string, unknown> = {}) => ({
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
});

async function place(body: unknown, headers: Record<string, string> = UA) {
  const res = await postJson(h.server, '/api/order', body, headers);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  if (!cond()) throw new Error('condition not met in time');
};
/** Long enough for waitUntil to have run: used only where the expected count is zero. */
const settle = () => new Promise((r) => setTimeout(r, 400));
const one = <T>(sql: string, ...binds: unknown[]) => h.env.DB.prepare(sql).bind(...binds).first<T>();

describe('with consent', () => {
  test.each(['ar', 'fr'] as const)('%s: one correct event, server totals, token in the body only', async (lang) => {
    const { status, json } = await place(order({ lang, items: [{ variantId: 11, qty: 2 }], expectedTotalDzd: 29800, ...consent }));
    expect(status).toBe(201);
    const ref = json['ref'] as string;
    await until(() => standIn.events().length === 1);
    const [hit] = standIn.hits();
    expect(hit?.path).toBe(`/v25.0/${PIXEL}/events`);
    expect(hit?.hasToken).toBe(true);
    expect(hit?.tokenInUrl).toBe(false);
    const e = standIn.events()[0]!;
    const row = await one<{ total_dzd: number; created_at: number }>('select total_dzd, created_at from orders where ref = ?', ref);
    expect(e).toMatchObject({
      event_name: 'Purchase',
      event_id: ref,
      event_source_url: `https://localhost/${lang}/order/confirmation/`,
      action_source: 'website',
      custom_data: { currency: 'DZD', value: row!.total_dzd, content_type: 'product', contents: [{ id: '11', quantity: 2 }], order_id: ref },
    });
    expect(e.custom_data['value']).toBe(29800);
    expect(e.user_data).toMatchObject({ fbp: FBP, client_user_agent: UA['User-Agent'], client_ip_address: '203.0.113.7' });
    expect(e.event_time).toBeGreaterThan(1_600_000_000);
  });

  test.each([
    ['0…', '0770200001', '8301d801974f2b320931dd21cba2658d95553a3d09df3379356fe7ff51686c97'],
    ['+213…', '+213770200002', 'b23107c2bec262ad6d4f121fa2479db7a7eefcb89dff253115077124fde9bdc7'],
    ['Eastern Arabic digits', '٠٧٧٠٢٠٠٠٠٣', '61160e30ee0b65012145113a068e5e30c07ab5e8179ac1329327f3e2b6d6392d'],
  ])('ph through the route, entered as %s, equals the committed digest', async (_n, phone, digest) => {
    expect((await place(order({ phone, ...consent }))).status).toBe(201);
    await until(() => standIn.events().length === 1);
    expect(standIn.events()[0]?.user_data['ph']).toEqual([digest]);
  });

  test('a replay with the same key adds no event', async () => {
    const body = order(consent);
    const first = await place(body);
    await until(() => standIn.events().length === 1);
    const again = await place(body);
    expect(again.json['ref']).toBe(first.json['ref']);
    await settle();
    expect(standIn.events()).toHaveLength(1);
  });

  test('a genuine double submit with a new key adds no event', async () => {
    const phone = freshPhone();
    const first = await place(order({ phone, ...consent }));
    await until(() => standIn.events().length === 1);
    const again = await place(order({ phone, ...consent }));
    expect(again.json).toMatchObject({ ref: first.json['ref'], duplicate: true });
    await settle();
    expect(standIn.events()).toHaveLength(1);
  });

  test('a sunk decoy sends nothing', async () => {
    const r = await place(order({ website: 'http://spam.example', fillMs: 10, ...consent }));
    expect(r.status).toBe(201);
    await settle();
    expect(standIn.events()).toHaveLength(0);
  });

  test('no user agent: order accepted, no event', async () => {
    expect((await place(order(consent), { 'User-Agent': '' })).status).toBe(201);
    await settle();
    expect(standIn.events()).toHaveLength(0);
  });
});

describe('without consent', () => {
  test.each([
    ['no meta field', {}],
    ['meta a string', { meta: 'true' }],
    ['meta an array', { meta: [true] }],
    ['meta null', { meta: null }],
    ['consent a string', { meta: { consent: 'true' } }],
    ['consent false', { meta: { consent: false, fbp: FBP } }],
  ])('%s: order 201, no event', async (_n, extra) => {
    expect((await place(order(extra))).status).toBe(201);
    await settle();
    expect(standIn.events()).toHaveLength(0);
  });

  test('a malformed fbp is dropped, the event still goes', async () => {
    expect((await place(order({ meta: { consent: true, fbp: `${FBP}\n` } }))).status).toBe(201);
    await until(() => standIn.events().length === 1);
    expect(standIn.events()[0]?.user_data).not.toHaveProperty('fbp');
  });

  test('a Cookie header alone is not consent', async () => {
    expect((await place(order(), { ...UA, Cookie: `_fbp=${FBP}` })).status).toBe(201);
    await settle();
    expect(standIn.events()).toHaveLength(0);
  });
});

describe('no-JS path', () => {
  test('urlencoded, even carrying meta fields: no event', async () => {
    const res = await postForm(
      h.server,
      '/api/order',
      {
        step: 'confirm',
        lang: 'fr',
        idempotencyKey: crypto.randomUUID(),
        variantId: '11',
        qty: '1',
        name: 'Karim',
        phone: freshPhone(),
        wilayaCode: '16',
        communeId: '1601',
        expectedTotalDzd: '15200',
        website: '',
        meta: '{"consent":true}',
        'meta.consent': 'true',
      },
      UA,
    );
    expect([303, 422, 409, 200]).toContain(res.status);
    await settle();
    expect(standIn.events()).toHaveLength(0);
  });
});

describe('Meta failing', () => {
  const noted = async (ref: string) =>
    (await one<{ n: number }>("select count(*) as n from order_events e join orders o on o.id = e.order_id where o.ref = ? and e.type like '%enqueue%'", ref))!.n;

  test('hang: the response arrives while the stand-in still holds the request', async () => {
    standIn.setMode('hang');
    const { status, json } = await place(order(consent));
    expect(status).toBe(201);
    await until(() => standIn.held() >= 1);
    expect(await noted(json['ref'] as string)).toBe(0);
    // The timeout counts as retryable: wait for the one retry, so it does not land in the next test.
    await until(() => standIn.hits().length === 2);
  });

  test('500: exactly two attempts, same event_id, order stands', async () => {
    standIn.setMode('500');
    const { status, json } = await place(order(consent));
    expect(status).toBe(201);
    await until(() => standIn.hits().length === 2);
    await settle();
    const ids = standIn.events().map((e) => e.event_id);
    expect(ids).toEqual([json['ref'], json['ref']]);
    expect(await noted(json['ref'] as string)).toBe(0);
  });

  test('400: exactly one attempt', async () => {
    standIn.setMode('400');
    expect((await place(order(consent))).status).toBe(201);
    await until(() => standIn.hits().length === 1);
    await settle();
    expect(standIn.hits()).toHaveLength(1);
  });
});
