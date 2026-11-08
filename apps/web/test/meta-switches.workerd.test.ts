// Independent switches and the stand-in being down, each needing its own Worker config (META-3).
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });
import { afterAll, describe, expect, test } from 'vitest';
import { postJson, startSeeded, TEST_SECRETS, type Started } from './support/harness.ts';
import { startMetaStandIn, type MetaStandIn } from './support/meta-stand-in.ts';

const PIXEL = '000000000000000';
const TOKEN = 'FAKE_TEST_TOKEN';
const body = (phone: string) => ({
  idempotencyKey: crypto.randomUUID(),
  lang: 'fr',
  items: [{ variantId: 11, qty: 1 }],
  name: 'Karim',
  phone,
  wilayaCode: 16,
  communeId: 1601,
  expectedTotalDzd: 15200,
  website: '',
  fillMs: 9000,
  meta: { consent: true },
});
const UA = { 'User-Agent': 'Mozilla/5.0 (switch test)' };
const settle = () => new Promise((r) => setTimeout(r, 400));

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

describe('switches', () => {
  test('Pixel set, token unset: no server event', async () => {
    const { h, s } = await boot((x) => ({ META_PIXEL_ID: PIXEL, META_GRAPH_BASE: x.url }));
    expect((await postJson(h.server, '/api/order', body('0772400001'), UA)).status).toBe(201);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });
  test('Pixel unset, token set: nothing', async () => {
    const { h, s } = await boot((x) => ({ META_ACCESS_TOKEN: TOKEN, META_GRAPH_BASE: x.url }));
    expect((await postJson(h.server, '/api/order', body('0772400002'), UA)).status).toBe(201);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });
  test('no base in ENV=test: server events off, order 201', async () => {
    const { h, s } = await boot(() => ({ META_PIXEL_ID: PIXEL, META_ACCESS_TOKEN: TOKEN }));
    expect((await postJson(h.server, '/api/order', body('0772400003'), UA)).status).toBe(201);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });
  test('non-loopback base in ENV=test: server events off, order 201', async () => {
    const { h, s } = await boot(() => ({ META_PIXEL_ID: PIXEL, META_ACCESS_TOKEN: TOKEN, META_GRAPH_BASE: 'http://203.0.113.9:9' }));
    expect((await postJson(h.server, '/api/order', body('0772400004'), UA)).status).toBe(201);
    await settle();
    expect(s.hits()).toHaveLength(0);
  });
});

describe('stand-in down', () => {
  test('connection refused: the order still succeeds', async () => {
    const { h, s } = await boot((x) => ({ META_PIXEL_ID: PIXEL, META_ACCESS_TOKEN: TOKEN, META_GRAPH_BASE: x.url }));
    await s.close();
    const res = await postJson(h.server, '/api/order', body('0772400005'), UA);
    expect(res.status).toBe(201);
    const { ref } = (await res.json()) as { ref: string };
    const row = await h.env.DB.prepare('select ref from orders where ref = ?').bind(ref).first();
    expect(row).not.toBeNull();
  });
});
