import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  checkOutboundUrl,
  clampTimeout,
  guardedFetch,
  parseRetryAfter,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRY_AFTER_MS,
  MAX_TIMEOUT_MS,
} from '../src/http.ts';

let server: Server;
let base: string;
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits += 1;
    const path = req.url ?? '/';
    const status = /^\/status\/(\d+)/.exec(path)?.[1];
    if (status) {
      if (status === '429') res.setHeader('Retry-After', '7');
      res.statusCode = Number(status);
      res.end(`body-${status}`);
      return;
    }
    if (path === '/redirect') {
      res.statusCode = 302;
      res.setHeader('Location', 'https://api.yalidine.app/v1/');
      res.end();
      return;
    }
    if (path === '/stall-body') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('partial');
      return; // never ends
    }
    if (path === '/hang') return; // never answers
    if (path === '/big') {
      res.end('x'.repeat(2048));
      return;
    }
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const NON_PRODUCTION = ['development', 'test', '', undefined] as const;
const REFUSED = [
  'https://api.yalidine.app/',
  'http://127.0.0.1.nip.io/',
  'http://localhost.evil.test/',
  'http://127.0.0.1@api.yalidine.app/',
  'http://[::1]/',
  'foo://127.0.0.1/',
  'ftp://localhost/',
  'http://0/',
  'http://localhost./',
  'http://[::ffff:127.0.0.1]/',
  'http://user:pw@127.0.0.1/',
  'not a url',
];

describe('outbound guard', () => {
  for (const env of NON_PRODUCTION) {
    for (const url of REFUSED) {
      it(`refuses ${url} when env is ${String(env)}, with no fetch`, async () => {
        const spy = vi.fn<typeof fetch>();
        const result = await guardedFetch(url, {}, { env, fetch: spy });
        expect(result.kind).toBe('refused');
        expect(spy).not.toHaveBeenCalled();
      });
    }
  }

  it.each(['http://127.0.0.1:1/', 'http://localhost:1/', 'http://2130706433/', 'http://127.1/'])(
    'allows loopback form %s outside production',
    (url) => {
      expect(checkOutboundUrl(url, 'development').ok).toBe(true);
    },
  );

  it('requires https in production', async () => {
    const spy = vi.fn<typeof fetch>();
    const result = await guardedFetch('http://api.yalidine.app/', {}, { env: 'production', fetch: spy });
    expect(result).toEqual({ kind: 'refused', reason: 'not_https' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows a real https host in production', async () => {
    const spy = vi.fn<typeof fetch>(async () => new Response('ok'));
    const result = await guardedFetch('https://api.yalidine.app/v1/', {}, { env: 'production', fetch: spy });
    expect(result.kind).toBe('response');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('treats a near-miss of "production" as non-production', () => {
    expect(checkOutboundUrl('https://api.yalidine.app/', 'Production').ok).toBe(false);
    expect(checkOutboundUrl('https://api.yalidine.app/', 'production ').ok).toBe(false);
  });

  it('always asks for manual redirects, whatever the caller passes', async () => {
    const spy = vi.fn<typeof fetch>(async () => new Response('ok'));
    await guardedFetch(
      'http://127.0.0.1:1/',
      { redirect: 'follow' } as never,
      { env: 'test', fetch: spy },
    );
    expect(spy.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });
});

describe('guardedFetch results over real HTTP', () => {
  it.each([401, 403, 404, 500])('returns a response for HTTP %i, in one attempt', async (status) => {
    const before = hits;
    const result = await guardedFetch(`${base}/status/${status}`, {}, { env: 'test' });
    expect(result).toMatchObject({ kind: 'response', status, text: `body-${status}` });
    expect(hits - before).toBe(1);
  });

  it('exposes Retry-After on 429', async () => {
    const result = await guardedFetch(`${base}/status/429`, {}, { env: 'test' });
    expect(result).toMatchObject({ kind: 'response', status: 429, retryAfterMs: 7000 });
  });

  it('does not follow a redirect to a real host', async () => {
    const before = hits;
    const result = await guardedFetch(`${base}/redirect`, {}, { env: 'test' });
    expect(result).toEqual({ kind: 'redirect', status: 302 });
    expect(hits - before).toBe(1);
  });

  it('times out when the server never answers', async () => {
    const result = await guardedFetch(`${base}/hang`, {}, { env: 'test', timeoutMs: 50 });
    expect(result).toEqual({ kind: 'timeout' });
  });

  it('times out when headers arrive and the body stalls', async () => {
    const result = await guardedFetch(`${base}/stall-body`, {}, { env: 'test', timeoutMs: 100 });
    expect(result).toEqual({ kind: 'timeout' });
  });

  it('caps the body size', async () => {
    const result = await guardedFetch(`${base}/big`, {}, { env: 'test', maxBytes: 1024 });
    expect(result).toEqual({ kind: 'too_large' });
  });

  it('reports a refused connection as network', async () => {
    const result = await guardedFetch('http://127.0.0.1:1/', {}, { env: 'test', timeoutMs: 2000 });
    expect(result.kind).toBe('network');
  });
});

describe('guardedFetch never throws and never leaks the URL', () => {
  const failing = (error: unknown): typeof fetch =>
    (async () => {
      throw error;
    }) as typeof fetch;

  it.each([
    ['TypeError', new TypeError('failed https://x.test/?api_token=SECRET')],
    ['AbortError', new DOMException('aborted', 'AbortError')],
    ['a string', 'boom SECRET'],
    ['undefined', undefined],
  ])('rejecting with %s becomes a value', async (_name, error) => {
    const result = await guardedFetch('http://127.0.0.1:1/?api_token=SECRET', {}, {
      env: 'test',
      fetch: failing(error),
    });
    expect(['network', 'timeout']).toContain(result.kind);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('a synchronous throw from fetch becomes a value', async () => {
    const thrower = (() => {
      throw new Error('sync SECRET');
    }) as unknown as typeof fetch;
    const result = await guardedFetch('http://127.0.0.1:1/', {}, { env: 'test', fetch: thrower });
    expect(result.kind).toBe('network');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('a body stream error becomes a value', async () => {
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error('stream SECRET'));
      },
    });
    const result = await guardedFetch('http://127.0.0.1:1/', {}, {
      env: 'test',
      fetch: async () => new Response(broken),
    });
    expect(result.kind).toBe('network');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('a body that ignores the abort signal still times out', async () => {
    const stalled = new ReadableStream({ pull: () => new Promise(() => undefined) });
    const result = await guardedFetch('http://127.0.0.1:1/', {}, {
      env: 'test',
      timeoutMs: 50,
      fetch: async () => new Response(stalled),
    });
    expect(result).toEqual({ kind: 'timeout' });
  });
});

describe('clampTimeout', () => {
  it.each([
    [undefined, DEFAULT_TIMEOUT_MS],
    [Number.NaN, DEFAULT_TIMEOUT_MS],
    [Number.POSITIVE_INFINITY, DEFAULT_TIMEOUT_MS],
    [Number.NEGATIVE_INFINITY, DEFAULT_TIMEOUT_MS],
    [0, 1],
    [-5, 1],
    [500, 500],
    [999_999, MAX_TIMEOUT_MS],
  ])('%s becomes %i', (input, expected) => {
    expect(clampTimeout(input)).toBe(expected);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.UTC(2026, 10, 9, 12, 0, 0);

  it.each([
    ['7', 7000],
    ['0', 0],
    [' 12 ', 12_000],
    ['Mon, 09 Nov 2026 12:00:30 GMT', 30_000],
    ['Mon, 09 Nov 2026 11:00:00 GMT', 0],
    [null, null],
    ['', null],
    ['soon', null],
    ['foo 1', null],
    ['-5', null],
    ['1.5', null],
    ['999999999', MAX_RETRY_AFTER_MS],
    ['Mon, 09 Nov 2099 12:00:30 GMT', MAX_RETRY_AFTER_MS],
  ])('%s gives %s', (input, expected) => {
    expect(parseRetryAfter(input, now)).toBe(expected);
  });
});
