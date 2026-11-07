/** MEAS-5: timing statistics and failure handling (the live run is in artifacts/MEAS-5/). */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupFailures, percentile, report, series, stats, timeOne } from '../src/timings/cli.ts';

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
});
