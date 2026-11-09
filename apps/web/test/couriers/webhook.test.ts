// SHIP-4 (SHIP-0 contract checks 21, 23): the public webhook route with a counting D1 stub, proving
// what costs a query and what ends up in the log.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { app } from '../../src/app.ts';
import type { Env } from '../../src/env.ts';

const TOKEN = 'a'.repeat(43);
const URL_OK = `https://shop.test/api/courier-hook/yalidine/${TOKEN}`;

interface Stub {
  env: Env;
  queries: string[];
}

function stub(first: unknown, opts: { throwOn?: RegExp; changes?: number } = {}): Stub {
  const queries: string[] = [];
  const DB = {
    prepare(sql: string) {
      queries.push(sql);
      if (opts.throwOn?.test(sql)) throw new Error('Failed query: INSERT\nparams: SENTINEL-body,SENTINEL-header');
      const stmt = {
        bind: () => stmt,
        first: async () => first,
        run: async () => ({ meta: { changes: opts.changes ?? 1 } }),
      };
      return stmt;
    },
  } as unknown as D1Database;
  return {
    queries,
    env: { ENV: 'test', SITE_HOSTS: 'shop.test', MIN_FILL_MS: '0', MIN_REVIEW_MS: '0', RUM_SAMPLE: '0', DB, ASSETS: {} as Fetcher } as unknown as Env,
  };
}

const ACCOUNT = { id: 1, courier: 'yalidine' };
const lines: string[] = [];
beforeEach(() => {
  lines.length = 0;
  for (const m of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
});
afterEach(() => vi.restoreAllMocks());

const post = (url: string, env: Env, body: BodyInit = '{}', headers: Record<string, string> = {}) => app.fetch(new Request(url, { method: 'POST', body, headers }), env);

describe('what costs a D1 query', () => {
  test.each([
    ['token too short', `https://shop.test/api/courier-hook/yalidine/${'a'.repeat(42)}`],
    ['token too long', `https://shop.test/api/courier-hook/yalidine/${'a'.repeat(44)}`],
    ['bad characters', `https://shop.test/api/courier-hook/yalidine/${'%21'.repeat(14)}a`],
    ['unknown courier', `https://shop.test/api/courier-hook/nope/${TOKEN}`],
    ['prototype name', `https://shop.test/api/courier-hook/__proto__/${TOKEN}`],
  ])('%s: 404 with no query', async (_n, url) => {
    const s = stub(ACCOUNT);
    expect((await post(url, s.env)).status).toBe(404);
    expect(s.queries).toHaveLength(0);
  });
  test('a well-formed unknown token: 404, one read, no write', async () => {
    const s = stub(null);
    expect((await post(URL_OK, s.env)).status).toBe(404);
    expect(s.queries).toHaveLength(1);
    expect(s.queries[0]).toMatch(/^SELECT/);
  });
  test('a valid token under another registered courier: the same 404, no write', async () => {
    const s = stub({ id: 1, courier: 'guepex' });
    expect((await post(URL_OK, s.env)).status).toBe(404);
    expect(s.queries).toHaveLength(1);
  });
  test('other methods: 405 with no query', async () => {
    const s = stub(ACCOUNT);
    const res = await app.fetch(new Request(URL_OK, { method: 'PUT', body: '{}' }), s.env);
    expect(res.status).toBe(405);
    expect(s.queries).toHaveLength(0);
  });
});

describe('body limits', () => {
  test('over the limit by header: 413, no insert', async () => {
    const s = stub(ACCOUNT);
    expect((await post(URL_OK, s.env, 'x', { 'content-length': String(40_000) })).status).toBe(413);
    expect(s.queries.filter((q) => /INSERT/.test(q))).toHaveLength(0);
  });
  test('over the limit in a chunked body with no length: 413, no insert', async () => {
    const s = stub(ACCOUNT);
    const stream = new ReadableStream({
      pull(ctrl) {
        ctrl.enqueue(new Uint8Array(10_000));
        if ((this as unknown as { n?: number }).n === undefined) (this as unknown as { n: number }).n = 0;
        if (++(this as unknown as { n: number }).n > 5) ctrl.close();
      },
    });
    const res = await app.fetch(new Request(URL_OK, { method: 'POST', body: stream, duplex: 'half' } as RequestInit), s.env);
    expect(res.status).toBe(413);
    expect(s.queries.filter((q) => /INSERT/.test(q))).toHaveLength(0);
  });
  test('the insert cap answers 503', async () => {
    const s = stub(ACCOUNT, { changes: 0 });
    const res = await post(URL_OK, s.env);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
  });
});

describe('logs (check 23)', () => {
  test('a failing insert goes through onError: 503, and neither token, path nor bound values are logged', async () => {
    const s = stub(ACCOUNT, { throwOn: /INSERT/ });
    const res = await post(URL_OK, s.env, 'SENTINEL-body', { 'x-signature': 'SENTINEL-header' });
    expect(res.status).toBe(503);
    const all = lines.join('\n');
    expect(all).toContain('unhandled_error');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('SENTINEL');
    expect(all).not.toContain('courier-hook/yalidine');
  });
  test('a D1 failure on the token read also ends in a redacted 503', async () => {
    const s = stub(ACCOUNT, { throwOn: /SELECT/ });
    expect((await post(URL_OK, s.env)).status).toBe(503);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});
