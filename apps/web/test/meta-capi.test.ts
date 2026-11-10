// The Meta sender and its place in afterWrite, with an injected fetch: no network (META-3).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OrderCreatedMessage } from '@hb/shared';
import { readMetaConfig, sendMetaPurchase, sendPurchase, type MetaConfig, type MetaOrderContext } from '../src/meta/capi.ts';
import { afterWrite } from '../src/routes/order.ts';
import type { PlaceOutcome } from '../src/order/place.ts';
import { blockMetaFetch } from './support/no-meta-fetch.ts';

blockMetaFetch();

const TOKEN = 'FAKE_TEST_TOKEN';
const ENV = { ENV: 'production', META_PIXEL_ID: '000000000000000', META_ACCESS_TOKEN: TOKEN };
const cfg = readMetaConfig(ENV, 'comptoirdeluxe.com') as Extract<MetaConfig, { on: true }>;

const meta: MetaOrderContext = {
  signals: { fbp: 'fb.1.1596403881668.1116446470' },
  lang: 'ar',
  phoneE164: '+213770123456',
  items: [{ variantId: 11, qty: 1 }],
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 test',
};
const order = { ref: 'HB-7K2Q9', createdAtMs: 1_790_000_000_000, totalDzd: 15200 };

const response = (status: number) => new Response('{}', { status });

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const bodyOf = (call: unknown[]): Record<string, unknown> => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;

describe('sendMetaPurchase', () => {
  test('one POST to Meta with the token in the body, not the URL', async () => {
    const f = vi.fn(async () => response(200));
    await sendMetaPurchase(ENV, 'comptoirdeluxe.com', order, meta, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
    const call = f.mock.calls[0] as unknown[];
    expect(String(call[0])).toBe(cfg.eventsUrl);
    expect(String(call[0])).not.toContain(TOKEN);
    const body = bodyOf(call);
    expect(body['access_token']).toBe(TOKEN);
    expect((body['data'] as { event_id: string }[])[0]?.event_id).toBe('HB-7K2Q9');
  });
  test('no user agent: nothing sent', async () => {
    const f = vi.fn(async () => response(200));
    await sendMetaPurchase(ENV, 'x.dz', order, { ...meta, userAgent: null }, f as unknown as typeof fetch);
    expect(f).not.toHaveBeenCalled();
  });
  test('config off: nothing sent', async () => {
    const f = vi.fn(async () => response(200));
    await sendMetaPurchase({ ENV: 'production' }, 'x.dz', order, meta, f as unknown as typeof fetch);
    expect(f).not.toHaveBeenCalled();
  });
  test('never rejects, even when fetch throws synchronously', async () => {
    const f = vi.fn(() => {
      throw new Error('boom');
    });
    await expect(sendMetaPurchase(ENV, 'x.dz', order, meta, f as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});

describe('sendPurchase retries', () => {
  const event = { event_id: 'HB-7K2Q9' } as never;
  test.each([
    ['200', 200, 1],
    ['400', 400, 1],
    ['500', 500, 2],
  ])('%s: %i attempts expected', async (_n, status, attempts) => {
    const f = vi.fn(async () => response(status as number));
    await sendPurchase(cfg, event, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(attempts as number);
  });
  test('network error and timeout are retried once', async () => {
    const f = vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    await sendPurchase(cfg, event, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(2);
  });
  test('the same body on the retry', async () => {
    const f = vi.fn(async () => response(503));
    await sendPurchase(cfg, event, f as unknown as typeof fetch);
    expect(bodyOf(f.mock.calls[0] as unknown[])).toEqual(bodyOf(f.mock.calls[1] as unknown[]));
  });
  test.each([
    ['ok', async () => response(200)],
    ['500', async () => response(500)],
    ['400', async () => response(400)],
    ['throw', async () => { throw new Error(`failed with ${TOKEN}`); }],
  ])('the token and customer data never reach a log line (%s)', async (_n, impl) => {
    await sendPurchase(cfg, { event_id: 'HB-7K2Q9', user_data: { client_ip_address: '203.0.113.7' } } as never, vi.fn(impl) as unknown as typeof fetch);
    expect(logs.length).toBeGreaterThan(0);
    const all = logs.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('203.0.113.7');
  });
});

describe('afterWrite', () => {
  const message: OrderCreatedMessage = { type: 'order.created', v: 1, orderId: 5, ref: 'HB-7K2Q9', totalDzd: 15200, wilayaCode: 16, lang: 'ar', flags: [], createdAt: 1_790_000_000_000 };
  const body = { ok: true, ref: 'HB-7K2Q9', status: 'new', duplicate: false, subtotalDzd: 14600, feeDzd: 600, totalDzd: 15200, confirmationUrl: '/ar/order/confirmation/?ref=HB-7K2Q9' } as const;
  const created = { kind: 'created', status: 201, body, orderId: 5, message } as PlaceOutcome;

  function context(env: Record<string, unknown>) {
    const pending: Promise<unknown>[] = [];
    const send = vi.fn(async () => ({}));
    return {
      send,
      pending,
      c: {
        env: { ORDERS: { send }, ...env } as never,
        executionCtx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as never,
      },
    };
  }
  const store = { noteEnqueueFailed: vi.fn(async () => {}) };

  const hangingFetch = (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_ok, fail) => init?.signal?.addEventListener('abort', () => fail(init.signal?.reason)));

  test.each([
    ['500', async () => response(500)],
    ['400', async () => response(400)],
    ['network', async () => { throw new TypeError('down'); }],
    ['hang', hangingFetch],
  ] as [string, typeof fetch][])('order.created still goes out once when Meta fails (%s)', async (_n, impl) => {
    const x = context(ENV);
    vi.stubGlobal('fetch', vi.fn(impl));
    afterWrite(x.c, store, created, 'comptoirdeluxe.com', meta);
    await Promise.all(x.pending);
    expect(x.send).toHaveBeenCalledTimes(1);
  }, 10_000);

  test('afterWrite returns while the call to Meta is still pending', () => {
    const x = context(ENV);
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    afterWrite(x.c, store, created, 'comptoirdeluxe.com', meta); // synchronous: a fetch that never answers cannot hold it up
    expect(x.pending).toHaveLength(2);
  });

  test.each([
    ['replay', { kind: 'replay', status: 201, body }],
    ['duplicate', { kind: 'duplicate', status: 201, body: { ...body, duplicate: true } }],
    ['sink', { kind: 'sink', status: 201, body }],
    ['failure', { kind: 'failure', failure: { code: 'out_of_stock' } }],
  ] as [string, PlaceOutcome][])('%s: nothing scheduled, no Meta call', async (_n, outcome) => {
    const x = context(ENV);
    const f = vi.fn(async () => response(200));
    vi.stubGlobal('fetch', f);
    afterWrite(x.c, store, outcome, 'comptoirdeluxe.com', meta);
    await Promise.all(x.pending);
    expect(x.pending).toHaveLength(0);
    expect(f).not.toHaveBeenCalled();
  });

  test('no signals: the order is notified and Meta is not called', async () => {
    const x = context(ENV);
    const f = vi.fn(async () => response(200));
    vi.stubGlobal('fetch', f);
    afterWrite(x.c, store, created, 'comptoirdeluxe.com');
    await Promise.all(x.pending);
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(f).not.toHaveBeenCalled();
  });
});
