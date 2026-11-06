// WEB-5 against a real local D1 in workerd: rows land with the server's time, the cleaned path,
// per-metric ratings, and nothing that identifies the visitor.
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startSeeded, type Started } from './support/harness.ts';

let h: Started;
beforeAll(async () => {
  h = await startSeeded();
});
afterAll(async () => {
  await h?.server.close();
});

test('a beacon becomes one row per metric, server-timed, path without query, no IP', async () => {
  const before = Date.now();
  const res = await h.server.fetch('/api/rum', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'CF-Connecting-IP': '105.98.1.2' },
    body: JSON.stringify({ v: 1, lang: 'fr', tpl: 'home', path: '/fr/?gclid=abc', navType: 'navigate', proto: 'h2', ttfb: 120, lcp: 4500, dns: 30, at: 1 }),
  });
  expect(res.status).toBe(204);
  expect(res.headers.get('set-cookie')).toBeNull();
  // The insert runs after the response (waitUntil): poll briefly.
  let rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 50 && rows.length < 3; i++) {
    rows = (await h.env.DB.prepare(`select * from rum_events where path = '/fr/' order by metric`).all()).results as Record<string, unknown>[];
    if (rows.length < 3) await new Promise((r) => setTimeout(r, 100));
  }
  expect(rows.map((r) => [r['metric'], r['value'], r['rating']])).toEqual([
    ['DNS', 30, null],
    ['LCP', 4500, 'poor'],
    ['TTFB', 120, 'good'],
  ]);
  for (const r of rows) {
    expect(r).toMatchObject({ template: 'home', lang: 'fr', nav_type: 'navigate', proto: 'h2', prerendered: 0 });
    expect(r['at'] as number).toBeGreaterThanOrEqual(before);
    expect(r['at'] as number).toBeLessThanOrEqual(Date.now());
  }
  expect(JSON.stringify(rows)).not.toMatch(/105\.98|gclid/);
});
