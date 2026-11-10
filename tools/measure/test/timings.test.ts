/** MEAS-5: timing statistics and failure handling (the live run is in artifacts/MEAS-5/). */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiWriteAllowed, groupFailures, main, percentile, report, series, stats, timeOne } from '../src/timings/cli.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('timings', () => {
  it('nearest-rank percentiles', () => {
    const xs = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 90)).toBe(9);
    expect(percentile([42], 90)).toBe(42);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
    expect(stats(xs)).toEqual({ n: 10, p50: 5, p90: 9, min: 1, max: 10 });
  });

  let srv: Server; let base = '';
  let hits = 0;
  beforeAll(async () => {
    srv = createServer((req, res) => {
      hits++;
      if (req.url === '/flaky' && hits % 2 === 0) { res.writeHead(503); res.end('busy'); return; }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => srv.close(() => ok())));

  it('warm-up runs are not counted; samples are positive ms', async () => {
    const s = await series('home', 'ttfb', '/', 200, 5, 2, () => timeOne(`${base}/`));
    expect(s.samples.length).toBe(5);
    expect(s.statuses).toEqual([200, 200, 200, 200, 200]);
    expect(s.samples.every((ms) => ms > 0)).toBe(true);
  });

  it('a wrong status is a failure, never a sample, and fails the report', async () => {
    hits = 0;
    const s = await series('flaky', 'ttfb', '/flaky', 200, 4, 0, () => timeOne(`${base}/flaky`));
    expect(s.samples.length).toBe(2);
    expect(s.failures.length).toBe(2);
    expect(s.failures[0]).toMatch(/HTTP 503 \(expected 200\) busy/);
    const r = report([s], { base, runs: 4, warmup: 0, loadavg: '0' });
    expect(r.ok).toBe(false);
    expect(r.txt).toMatch(/TIMINGS FAILED/);
    const good = report([await series('home', 'ttfb', '/', 200, 3, 0, () => timeOne(`${base}/`))], { base, runs: 3, warmup: 0, loadavg: '0' });
    expect(good.ok).toBe(true);
    expect(JSON.parse(good.json).results[0].stats.n).toBe(3);
  });

  it('groups identical failures', () => {
    expect(groupFailures(['run 1: HTTP 307 (expected 200) ', 'run 2: HTTP 307 (expected 200) ', 'run 4: HTTP 500 boom']))
      .toEqual(['2× (runs 1, 2): HTTP 307 (expected 200) ', 'run 4: HTTP 500 boom']);
  });

  // rev-a MEAS-5 r1 Important: never write orders to a real site
  it('the API series (which writes orders) runs only on loopback, the harness, or an explicitly named *.workers.dev', () => {
    const ok = (base: string, allowWriteHost?: string, harness = false) => apiWriteAllowed(base, { harness, allowWriteHost }).ok;
    for (const b of ['http://127.0.0.1:4110', 'http://localhost:4210', 'http://[::1]:4110']) expect(ok(b), b).toBe(true);
    expect(ok('https://comptoirdeluxe.com', undefined, true)).toBe(true); // the harness started it: it is ours
    // production-like hosts: refused, with or without the flag
    expect(ok('https://comptoirdeluxe.com')).toBe(false);
    expect(ok('https://comptoirdeluxe.com', 'hb-test.hamawebdev.workers.dev')).toBe(false); // flag for another host
    expect(ok('https://comptoirdeluxe.com', 'comptoirdeluxe.com')).toBe(false);                // flag only takes workers.dev
    expect(ok('http://127.0.0.2:4110')).toBe(false);                                     // not the loopback names we allow
    const r = apiWriteAllowed('https://www.comptoirdeluxe.com', { harness: false, allowWriteHost: 'www.comptoirdeluxe.com' });
    expect(r.ok === false && r.reason).toMatch(/accepts only a \*\.workers\.dev host/);
    // a temporary deploy: allowed only when named exactly
    expect(ok('https://hb-abc.hamawebdev.workers.dev')).toBe(false);
    expect(ok('https://hb-abc.hamawebdev.workers.dev', 'hb-abc.hamawebdev.workers.dev')).toBe(true);
    expect(ok('https://hb-abc.hamawebdev.workers.dev', 'HB-ABC.hamawebdev.workers.dev')).toBe(true);
    expect(ok('https://hb-abc.hamawebdev.workers.dev', 'hb-xyz.hamawebdev.workers.dev')).toBe(false);
    expect(ok('https://evil.workers.dev.example.com', 'evil.workers.dev.example.com')).toBe(false);
  });

  it('against a non-allowed host: no POST is sent, pages are still timed, the refusal is reported', async () => {
    const posts: string[] = [];
    const s2 = createServer((req, res) => {
      if (req.method !== 'GET') { posts.push(`${req.method} ${req.url}`); res.writeHead(201); res.end('{}'); return; }
      res.writeHead(req.url?.includes('__timings-missing') ? 404 : 200); res.end('ok');
    });
    await new Promise<void>((ok) => s2.listen(0, '127.0.0.2', ok)); // reachable, but not a loopback NAME we allow
    const port = (s2.address() as AddressInfo).port;
    const out = mkdtempSync(path.join(tmpdir(), 'hb-timings-'));
    const dist = mkdtempSync(path.join(tmpdir(), 'hb-timings-site-'));
    const pages: Record<string, string> = { '': 'home', 'c/x/': 'category', 'p/a/': 'product', 'search/': 'search', 'livraison/': 'content', 'order/confirmation/': 'order-confirmed' };
    for (const l of ['ar', 'fr']) {
      for (const [p, t] of Object.entries(pages)) { mkdirSync(path.join(dist, l, p), { recursive: true }); writeFileSync(path.join(dist, l, p, 'index.html'), `<html lang="${l}" data-tpl="${t}"></html>`); }
      writeFileSync(path.join(dist, l, '404.html'), `<html lang="${l}" data-tpl="not-found"></html>`);
    }
    try {
      const code = await main(['--base-url', `http://127.0.0.2:${port}`, '--dist', dist, '--runs', '2', '--warmup', '0', '--out', out]);
      expect(posts).toEqual([]);
      expect(code).toBe(0);
      const txt = readFileSync(path.join(out, 'timings.txt'), 'utf8');
      expect(txt).toMatch(/API series \(POST \/api\/quote, \/api\/order\): REFUSED: "127\.0\.0\.2" is not loopback/);
      expect(txt).toMatch(/home-ar +ttfb +p50/);
      expect(txt).not.toMatch(/api-order/);
    } finally {
      await new Promise<void>((ok) => s2.close(() => ok()));
      rmSync(out, { recursive: true, force: true });
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
