// Independent switches, credentials read from D1 at order time, and the stand-in being down
// (META-3, MSET-3; ledger M-1, M-6). The real route on workerd and D1; the stand-in is the fetch spy.
// Every case asserts the order itself: 201 and its row, whatever happens to the Meta send.
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { postJson, startSeeded, TEST_SECRETS, type Started } from './support/harness.ts';
import { startMetaStandIn, type MetaStandIn } from './support/meta-stand-in.ts';
import { FAKE_PIXEL, FAKE_TOKEN, OTHER_SETTINGS_KEY, setMetaRows, tamperedToken, TEST_SETTINGS_KEY, type MetaRows } from './support/meta-settings.ts';

let seq = 0;
const body = (meta: unknown = { consent: true, pixel: FAKE_PIXEL }) => ({
  idempotencyKey: crypto.randomUUID(),
  lang: 'fr',
  items: [{ variantId: 11, qty: 1 }],
  name: 'Karim',
  phone: `0772${String(400000 + seq++).padStart(6, '0')}`,
  wilayaCode: 16,
  communeId: 1601,
  expectedTotalDzd: 15200,
  website: '',
  fillMs: 9000,
  meta,
});
const UA = { 'User-Agent': 'Mozilla/5.0 (switch test)' };
const settle = () => new Promise((r) => setTimeout(r, 500));

const open: { h: Started; s: MetaStandIn }[] = [];
afterAll(async () => {
  for (const { h, s } of open) {
    await h.server.close();
    await s.close().catch(() => {});
  }
});
async function boot(extra: (s: MetaStandIn) => Record<string, string>) {
  const s = await startMetaStandIn();
  const h = await startSeeded({ ...TEST_SECRETS, ...extra(s) });
  open.push({ h, s });
  return { h, s };
}

/** Places one order and asserts it succeeded and exists; returns its ref. */
async function placeOk(h: Started, meta?: unknown): Promise<string> {
  const res = await postJson(h.server, '/api/order', body(meta), UA);
  expect(res.status).toBe(201);
  const { ref } = (await res.json()) as { ref: string };
  expect(await h.env.DB.prepare('select ref from orders where ref = ?').bind(ref).first()).not.toBeNull();
  return ref;
}

describe('credentials from D1 (one Worker: key and stand-in configured, rows change per case)', () => {
  let h: Started;
  let s: MetaStandIn;
  beforeAll(async () => {
    ({ h, s } = await boot((x) => ({ SETTINGS_ENCRYPTION_KEY: TEST_SETTINGS_KEY, CAPI_STANDIN_URL: x.url })));
  });
  beforeEach(() => s.reset());
  const rows = (r: MetaRows) => setMetaRows(h.env.DB, r);

  test('Pixel ID, token and test code in D1: exactly one event, with the stored test code', async () => {
    await rows({ pixelId: FAKE_PIXEL, token: FAKE_TOKEN, testEventCode: 'TEST4242' });
    const ref = await placeOk(h);
    await settle();
    expect(s.hits()).toHaveLength(1);
    const hit = s.hits()[0]!;
    expect(hit.path).toBe(`/v25.0/${FAKE_PIXEL}/events`);
    expect(hit.testEventCode).toBe('TEST4242');
    expect(hit.events.map((e) => e.event_id)).toEqual([ref]);
    expect(hit.hasToken).toBe(true);
    expect(hit.tokenInUrl).toBe(false);
  });

  test('no test code stored: no test_event_code', async () => {
    await rows({ pixelId: FAKE_PIXEL, token: FAKE_TOKEN });
    await placeOk(h);
    await settle();
    expect(s.hits()).toHaveLength(1);
    expect(s.hits()[0]!.testEventCode).toBeUndefined();
  });

  test.each<[string, MetaRows]>([
    ['Pixel ID only (no token)', { pixelId: FAKE_PIXEL }],
    ['token only (no Pixel ID)', { token: FAKE_TOKEN, testEventCode: 'TEST4242' }],
    ['nothing stored', {}],
    ['all-zero Pixel ID stored', { pixelId: '000000000000000', token: FAKE_TOKEN }],
  ])('%s: no server event', async (_label, r) => {
    await rows(r);
    await placeOk(h);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });

  test.each<[string, unknown]>([
    ['without the page Pixel ID', { consent: true }],
    ['with another Pixel ID', { consent: true, pixel: '1234567890123456' }],
    ['with a malformed Pixel ID', { consent: true, pixel: `${FAKE_PIXEL}\n` }],
    ['with the Pixel ID as a number', { consent: true, pixel: 100000000000001 }],
  ])('consent signal %s: no server event', async (_label, meta) => {
    await rows({ pixelId: FAKE_PIXEL, token: FAKE_TOKEN });
    await placeOk(h, meta);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });

  test('a token sealed with another key: fails closed, no event', async () => {
    await rows({ pixelId: FAKE_PIXEL, token: FAKE_TOKEN, key: OTHER_SETTINGS_KEY });
    await placeOk(h);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });

  test.each([
    ['version byte', 0],
    ['IV', 5],
    ['ciphertext', 20],
    ['tag', -3],
  ])('tampered stored token (%s): fails closed, no event', async (_label, index) => {
    await rows({ pixelId: FAKE_PIXEL, tokenEncRaw: await tamperedToken(FAKE_TOKEN, index) });
    await placeOk(h);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });

  test.each(['not base64 %%%', 'AQ==', ''])('garbage stored token %j: no event', async (raw) => {
    await rows({ pixelId: FAKE_PIXEL, tokenEncRaw: raw });
    await placeOk(h);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });

  test('removing the Pixel ID stops server events at once (token still stored)', async () => {
    await rows({ pixelId: FAKE_PIXEL, token: FAKE_TOKEN });
    await placeOk(h);
    await settle();
    expect(s.hits()).toHaveLength(1);
    s.reset();
    await rows({ token: FAKE_TOKEN });
    await placeOk(h);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });

  test('an order without the consent signal: no event', async () => {
    await rows({ pixelId: FAKE_PIXEL, token: FAKE_TOKEN });
    await placeOk(h, null);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });
});

describe('switches that need their own Worker config', () => {
  test('no SETTINGS_ENCRYPTION_KEY: no server event, order 201', async () => {
    const { h, s } = await boot((x) => ({ CAPI_STANDIN_URL: x.url }));
    await setMetaRows(h.env.DB, { pixelId: FAKE_PIXEL, token: FAKE_TOKEN });
    await placeOk(h);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });
  test('malformed SETTINGS_ENCRYPTION_KEY (16 bytes): no server event, order 201', async () => {
    const { h, s } = await boot((x) => ({ SETTINGS_ENCRYPTION_KEY: btoa('0123456789abcdef'), CAPI_STANDIN_URL: x.url }));
    await setMetaRows(h.env.DB, { pixelId: FAKE_PIXEL, token: FAKE_TOKEN });
    await placeOk(h);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });
  test('no stand-in URL in ENV=test: server events off, order 201', async () => {
    const { h, s } = await boot(() => ({ SETTINGS_ENCRYPTION_KEY: TEST_SETTINGS_KEY }));
    await setMetaRows(h.env.DB, { pixelId: FAKE_PIXEL, token: FAKE_TOKEN });
    await placeOk(h);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });
  test('non-loopback stand-in URL in ENV=test: server events off, order 201', async () => {
    const { h, s } = await boot(() => ({ SETTINGS_ENCRYPTION_KEY: TEST_SETTINGS_KEY, CAPI_STANDIN_URL: 'http://203.0.113.9:9' }));
    await setMetaRows(h.env.DB, { pixelId: FAKE_PIXEL, token: FAKE_TOKEN });
    await placeOk(h);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });
  test('the old environment variables are ignored: set in the Worker, no D1 rows, no event', async () => {
    const { h, s } = await boot((x) => ({
      SETTINGS_ENCRYPTION_KEY: TEST_SETTINGS_KEY,
      CAPI_STANDIN_URL: x.url,
      META_PIXEL_ID: FAKE_PIXEL,
      META_ACCESS_TOKEN: FAKE_TOKEN,
      META_TEST_EVENT_CODE: 'TEST4242',
      META_GRAPH_BASE: x.url,
    }));
    await placeOk(h);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });
});

describe('stand-in down', () => {
  test('connection refused: the order still succeeds and its notification goes out', async () => {
    const { h, s } = await boot((x) => ({ SETTINGS_ENCRYPTION_KEY: TEST_SETTINGS_KEY, CAPI_STANDIN_URL: x.url }));
    await setMetaRows(h.env.DB, { pixelId: FAKE_PIXEL, token: FAKE_TOKEN });
    await s.close();
    const ref = await placeOk(h);
    const notes = await h.env.DB.prepare("select count(*) as n from order_events e join orders o on o.id = e.order_id where o.ref = ? and e.note like '%could not be enqueued%'").bind(ref).first<{ n: number }>();
    expect(notes?.n).toBe(0);
  });
});
