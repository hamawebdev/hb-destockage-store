// The real route on real workerd and D1, against the local stand-in for Meta (META-3). The Worker
// runs with ENV=test and a loopback CAPI_STANDIN_URL, the only destination it will use outside
// production. Meta credentials are D1 rows, as the admin writes them (MSET-3). Digests were computed separately with `printf '<number>' | sha256sum`.
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { postForm, postJson, startSeeded, TEST_SECRETS, type Started } from './support/harness.ts';
import { startMetaStandIn, type MetaStandIn } from './support/meta-stand-in.ts';
import { FAKE_PIXEL, FAKE_TOKEN, setMetaRows, TEST_SETTINGS_KEY } from './support/meta-settings.ts';

const PIXEL = FAKE_PIXEL;
const TOKEN = FAKE_TOKEN;
const FBP = 'fb.1.1596403881668.1116446470';
const UA = { 'User-Agent': 'Mozilla/5.0 (meta-order test)', 'CF-Connecting-IP': '203.0.113.7' };

let standIn: MetaStandIn;
let h: Started;
beforeAll(async () => {
  standIn = await startMetaStandIn();
  h = await startSeeded({ ...TEST_SECRETS, SETTINGS_ENCRYPTION_KEY: TEST_SETTINGS_KEY, CAPI_STANDIN_URL: standIn.url });
  await setMetaRows(h.env.DB, { pixelId: PIXEL, token: TOKEN });
});
afterAll(async () => {
  await h?.server.close();
  await standIn?.close().catch(() => {});
});
beforeEach(() => standIn.reset());

let seq = 0;
const freshPhone = () => `0771${String(300000 + seq++).padStart(6, '0')}`;
const consent = { meta: { consent: true, pixel: PIXEL, fbp: FBP } };

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
const one = <T>(sql: string, ...binds: unknown[]) => h.env.DB.prepare(sql).bind(...binds).first<T>();
const orderExists = async (ref: string) => (await one<{ n: number }>('select count(*) as n from orders where ref = ?', ref))!.n === 1;
/** Failed-enqueue notes for an order: 0 means the order.created notification went out. */
const enqueueNotes = async (ref: string) =>
  (await one<{ n: number }>("select count(*) as n from order_events e join orders o on o.id = e.order_id where o.ref = ? and e.note like '%could not be enqueued%'", ref))!.n;

/**
 * Sentinel for "no event": one consenting order, then every earlier send has had its waitUntil run,
 * so a stray event would already be in the list. Returns the ids received, the sentinel's last.
 */
async function sentinelIds(): Promise<string[]> {
  const { json } = await place(order(consent));
  const ref = json['ref'] as string;
  await until(() => standIn.events().some((e) => e.event_id === ref));
  const ids = standIn.events().map((e) => e.event_id);
  expect(ids.at(-1)).toBe(ref);
  return ids.slice(0, -1);
}

const logsWith = (needle: string, atLeast = 1) => () => h.server.getLogs().filter((l) => JSON.stringify(l).includes(needle)).length >= atLeast;

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
    expect(await sentinelIds()).toEqual([first.json['ref']]);
  });

  test('a genuine double submit with a new key adds no event', async () => {
    const phone = freshPhone();
    const first = await place(order({ phone, ...consent }));
    await until(() => standIn.events().length === 1);
    const again = await place(order({ phone, ...consent }));
    expect(again.json).toMatchObject({ ref: first.json['ref'], duplicate: true });
    expect(await sentinelIds()).toEqual([first.json['ref']]);
  });

  test('a sunk decoy sends nothing', async () => {
    const r = await place(order({ website: 'http://spam.example', fillMs: 10, ...consent }));
    expect(r.status).toBe(201);
    expect(await sentinelIds()).toEqual([]);
  });

  test('no user agent: order accepted, no event', async () => {
    expect((await place(order(consent), { 'User-Agent': '' })).status).toBe(201);
    expect(await sentinelIds()).toEqual([]);
  });
});

describe('without consent', () => {
  test.each([
    ['no meta field', {}],
    ['meta a string', { meta: 'true' }],
    ['meta an array', { meta: [true] }],
    ['meta null', { meta: null }],
    ['consent a string', { meta: { consent: 'true' } }],
    ['consent false', { meta: { consent: false, pixel: PIXEL, fbp: FBP } }],
    ['consent without the page Pixel ID', { meta: { consent: true, fbp: FBP } }],
  ])('%s: order 201, no event', async (_n, extra) => {
    expect((await place(order(extra))).status).toBe(201);
    expect(await sentinelIds()).toEqual([]);
  });

  test('a malformed fbp is dropped, the event still goes', async () => {
    expect((await place(order({ meta: { consent: true, pixel: PIXEL, fbp: `${FBP}\n` } }))).status).toBe(201);
    await until(() => standIn.events().length === 1);
    expect(standIn.events()[0]?.user_data).not.toHaveProperty('fbp');
  });

  test('a Cookie header alone is not consent', async () => {
    expect((await place(order(), { ...UA, Cookie: `_fbp=${FBP}` })).status).toBe(201);
    expect(await sentinelIds()).toEqual([]);
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
    expect(res.status).toBe(303);
    const ref = new URL(res.headers.get('location') ?? '', 'http://x').searchParams.get('ref');
    expect(await orderExists(ref ?? '')).toBe(true);
    expect(await sentinelIds()).toEqual([]);
  });
});

describe('Meta failing', () => {
  const noToken = () => expect(JSON.stringify(h.server.getLogs())).not.toContain(TOKEN);

  test('ok: the Worker log has the send, not the token', async () => {
    h.server.clearLogs();
    expect((await place(order(consent))).status).toBe(201);
    await until(logsWith('meta_capi'));
    noToken();
  });

  test('500: exactly two attempts, same event_id, order stands, notification sent, no token in the logs', async () => {
    h.server.clearLogs();
    standIn.setMode('500');
    const { status, json } = await place(order(consent));
    const ref = json['ref'] as string;
    expect(status).toBe(201);
    expect(await orderExists(ref)).toBe(true);
    await until(() => standIn.hits().length === 2);
    await until(logsWith('meta_capi', 2));
    expect(standIn.events().map((e) => e.event_id)).toEqual([ref, ref]);
    expect(await enqueueNotes(ref)).toBe(0);
    noToken();
  });

  test('400: exactly one attempt, order stands, notification sent, no token in the logs', async () => {
    h.server.clearLogs();
    standIn.setMode('400');
    const { status, json } = await place(order(consent));
    const ref = json['ref'] as string;
    expect(status).toBe(201);
    expect(await orderExists(ref)).toBe(true);
    await until(() => standIn.hits().length === 1);
    await until(logsWith('meta_capi'));
    standIn.setMode('ok'); // the sentinel order below must be answered normally
    expect(await sentinelIds()).toEqual([ref]);
    expect(standIn.hits()).toHaveLength(2); // the 400 was not retried; the second hit is the sentinel
    expect(await enqueueNotes(ref)).toBe(0);
    noToken();
  });

  // Last in the file on purpose: the Worker's retry can land after this test has finished.
  test('hang: the response arrives before the Worker gives up on Meta; order stands; no token in the logs', async () => {
    h.server.clearLogs();
    standIn.setMode('hang');
    const { status, json } = await place(order(consent));
    // Two timeouts of 1.5 s separate the first attempt from giving up: a response that waited for
    // Meta could not arrive before the second attempt has reached the stand-in.
    expect(standIn.hits().length).toBeLessThan(2);
    const ref = json['ref'] as string;
    expect(status).toBe(201);
    expect(await orderExists(ref)).toBe(true);
    await until(logsWith('meta_capi'));
    expect(await enqueueNotes(ref)).toBe(0);
    noToken();
  });
});
