// Unit tests: review token, IP keys/hash, sink ref, Turnstile verification. Plan WEB-0 §2.3, §3, §4.4.
import { describe, expect, test, vi } from 'vitest';
import { isOrderRef } from '@hb/shared';
import { ipHash, ipRateKey, reviewFillMs, signReviewToken, sinkRef } from '../src/order/crypto.ts';
import { SITEVERIFY_URL, verifyTurnstile } from '../src/order/turnstile.ts';

const KEY = '6f1c2a4e-8b3d-4c5e-9f6a-7b8c9d0e1f2a';
const T0 = 1_793_800_000_000;

describe('review token', () => {
  test('round trip gives the server-measured review → confirm time', async () => {
    const tok = await signReviewToken('secret', T0, KEY, 'ar');
    expect(tok).toMatch(/^\d+\.[A-Za-z0-9_-]{22}$/);
    expect(await reviewFillMs('secret', tok, KEY, 'ar', T0 + 4200)).toBe(4200);
  });

  test.each([
    ['other signing key', async (t: string) => reviewFillMs('other', t, KEY, 'ar', T0 + 1)],
    ['other idempotency key', async (t: string) => reviewFillMs('secret', t, crypto.randomUUID(), 'ar', T0 + 1)],
    ['other lang', async (t: string) => reviewFillMs('secret', t, KEY, 'fr', T0 + 1)],
    ['issued in the future', async (t: string) => reviewFillMs('secret', t, KEY, 'ar', T0 - 1)],
    ['older than 24 h', async (t: string) => reviewFillMs('secret', t, KEY, 'ar', T0 + 86_400_001)],
    ['tampered timestamp', async (t: string) => reviewFillMs('secret', `1${t}`, KEY, 'ar', T0 + 1)],
    ['no signing key configured', async (t: string) => reviewFillMs(undefined, t, KEY, 'ar', T0 + 1)],
    ['not a string', async () => reviewFillMs('secret', 42, KEY, 'ar', T0 + 1)],
    ['garbage', async () => reviewFillMs('secret', 'x.y', KEY, 'ar', T0 + 1)],
  ])('%s → undefined (flag fill_time_missing, never reject)', async (_l, run) => {
    const tok = await signReviewToken('secret', T0, KEY, 'ar');
    expect(await run(tok)).toBeUndefined();
  });
});

describe('IP helpers', () => {
  test.each([
    ['105.98.1.2', '105.98.1.2'],
    ['2001:0db8:00aa:00bb:0001:0002:0003:0004', '2001:db8:aa:bb::/64'],
    ['2001:db8:aa:bb::1', '2001:db8:aa:bb::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['2001:DB8:AA:BB:1:2:3:4', '2001:db8:aa:bb::/64'],
  ])('rate key of %s = %s', (ip, key) => {
    expect(ipRateKey(ip)).toBe(key);
  });

  test('ip hash: salted, stable, hex, never the IP; null without key or IP', async () => {
    const h = await ipHash('salt', '105.98.1.2');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(await ipHash('salt', '105.98.1.2')).toBe(h);
    expect(await ipHash('other', '105.98.1.2')).not.toBe(h);
    expect(h).not.toContain('105');
    expect(await ipHash(undefined, '105.98.1.2')).toBeNull();
    expect(await ipHash('salt', null)).toBeNull();
  });
});

test('sink ref: a valid-looking ref, stable per key', async () => {
  const a = await sinkRef(KEY);
  expect(isOrderRef(a)).toBe(true);
  expect(await sinkRef(KEY)).toBe(a);
  expect(await sinkRef(crypto.randomUUID())).not.toBe(a);
});

describe('verifyTurnstile', () => {
  const base = { secret: 'sk', ip: '105.98.1.2', idempotencyKey: KEY, hosts: ['shop.example'] };
  const reply = (body: unknown, status = 200) => vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(JSON.stringify(body), { status }));

  test('missing token → missing, no network', async () => {
    const f = reply({});
    expect(await verifyTurnstile({ ...base, token: undefined, fetcher: f })).toBe('missing');
    expect(await verifyTurnstile({ ...base, token: '  ', fetcher: f })).toBe('missing');
    expect(f).not.toHaveBeenCalled();
  });

  test('no secret configured → error (our fault), no network', async () => {
    const f = reply({});
    expect(await verifyTurnstile({ ...base, secret: undefined, token: 't', fetcher: f })).toBe('error');
    expect(f).not.toHaveBeenCalled();
  });

  test('ok: posts secret, response, remoteip and idempotency_key to siteverify', async () => {
    const f = reply({ success: true, hostname: 'shop.example', action: 'order' });
    expect(await verifyTurnstile({ ...base, token: 'tok', fetcher: f })).toBe('ok');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(SITEVERIFY_URL);
    const fd = init?.body as FormData;
    expect(Object.fromEntries(fd.entries())).toEqual({ secret: 'sk', response: 'tok', idempotency_key: KEY, remoteip: '105.98.1.2' });
  });

  test.each([
    ['success false', { success: false, 'error-codes': ['invalid-input-response'] }],
    ['wrong hostname', { success: true, hostname: 'evil.example', action: 'order' }],
    ['wrong action', { success: true, hostname: 'shop.example', action: 'login' }],
    ['no hostname', { success: true, action: 'order' }],
  ])('%s → invalid', async (_l, body) => {
    expect(await verifyTurnstile({ ...base, token: 'tok', fetcher: reply(body) })).toBe('invalid');
  });

  test('HTTP error, network error, bad JSON, timeout → error', async () => {
    expect(await verifyTurnstile({ ...base, token: 't', fetcher: reply({}, 500) })).toBe('error');
    expect(await verifyTurnstile({ ...base, token: 't', fetcher: vi.fn(() => Promise.reject(new TypeError('net'))) })).toBe('error');
    expect(await verifyTurnstile({ ...base, token: 't', fetcher: vi.fn(async () => new Response('<html>')) })).toBe('error');
    const slow = vi.fn(
      (_u: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('timeout', 'TimeoutError')))),
    );
    expect(await verifyTurnstile({ ...base, token: 't', fetcher: slow, timeoutMs: 20 })).toBe('error');
  });
});
