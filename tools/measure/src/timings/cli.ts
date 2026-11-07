#!/usr/bin/env node
/**
 * Local timings (MEAS-5) for the closing report: TTFB of every template target, and the latency
 * of POST /api/quote and POST /api/order, each as p50 / p90 / min / max over N runs (after
 * warm-up runs that are not counted).
 *
 *   node tools/measure/src/timings/cli.ts                      # seed a fresh D1, boot the web Worker (e2e harness)
 *   node tools/measure/src/timings/cli.ts --base-url http://127.0.0.1:4210 --persist .wrangler/hb-local
 *
 * LOCAL numbers (wrangler dev on this machine, no network): they compare builds and catch
 * regressions; they are not production latencies. Requests run one at a time.
 * Every timed request must answer its expected status (page 200; not-found: a missing URL, 404;
 * quote 200; order 201): a wrong
 * status is a failure (exit 1), never a fast sample. Exit 2 = setup error.
 * Output (--out, default <main checkout>/artifacts/timings-run): timings.json, timings.txt.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_DIST, REPO_ROOT, artifactsRoot } from '../lib/paths.ts';
import { discover, type TemplateTarget } from '../templates.ts';

export interface Series { name: string; kind: 'ttfb' | 'quote' | 'order'; url: string; samples: number[]; statuses: number[]; expect: number; failures: string[] }
export interface Stats { n: number; p50: number; p90: number; min: number; max: number }

const OPTIONS = {
  'base-url': { type: 'string' }, persist: { type: 'string' }, dist: { type: 'string' },
  runs: { type: 'string' }, warmup: { type: 'string' }, out: { type: 'string' },
  variant: { type: 'string' }, wilaya: { type: 'string' }, commune: { type: 'string' },
  'no-api': { type: 'boolean' }, help: { type: 'boolean' },
} as const;
const USAGE = `usage: node tools/measure/src/timings/cli.ts [--base-url URL --persist DIR] [--dist DIR] [--runs 30] [--warmup 3] [--out DIR]
  [--variant ID --wilaya CODE --commune ID] [--no-api]
  without --base-url: seeds a fresh local D1 and boots the web Worker (as npm run e2e does)`;

/** Nearest-rank percentile (p in 0..100) of numbers. */
export function percentile(xs: readonly number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export function stats(xs: readonly number[]): Stats {
  const r = (v: number): number => Math.round(v * 10) / 10;
  return { n: xs.length, p50: r(percentile(xs, 50)), p90: r(percentile(xs, 90)), min: r(Math.min(...xs)), max: r(Math.max(...xs)) };
}

/** Time one request: ms until the response headers arrive (TTFB as the client sees it); the body is then read and discarded. */
export async function timeOne(url: string, init?: RequestInit): Promise<{ ms: number; status: number; body: string }> {
  const t0 = performance.now();
  const r = await fetch(url, { redirect: 'manual', ...init });
  const ms = performance.now() - t0;
  const body = await r.text();
  return { ms, status: r.status, body };
}

/**
 * Run `make()` warmup + runs times one after another; keep the timings of the counted runs.
 * A counted run with the wrong status is recorded as a failure, not as a sample.
 */
export async function series(name: string, kind: Series['kind'], url: string, expect: number, runs: number, warmup: number,
  make: (i: number) => Promise<{ ms: number; status: number; body: string }>): Promise<Series> {
  const s: Series = { name, kind, url, samples: [], statuses: [], expect, failures: [] };
  for (let i = 0; i < warmup + runs; i++) {
    const r = await make(i);
    if (i < warmup) continue;
    s.statuses.push(r.status);
    if (r.status === expect) s.samples.push(r.ms);
    else s.failures.push(`run ${i - warmup + 1}: HTTP ${r.status} (expected ${expect}) ${r.body.slice(0, 160).replace(/\s+/g, ' ')}`);
  }
  return s;
}

/** Identical failures (same status and body) once, with their count and run numbers. */
export function groupFailures(failures: readonly string[]): string[] {
  const by = new Map<string, number[]>();
  for (const f of failures) {
    const m = /^run (\d+): (.*)$/.exec(f);
    const key = m ? m[2]! : f;
    by.set(key, [...(by.get(key) ?? []), m ? Number(m[1]) : 0]);
  }
  return [...by].map(([msg, rs]) => rs.length > 1 ? `${rs.length}× (runs ${rs.join(', ')}): ${msg}` : `run ${rs[0]}: ${msg}`);
}

export function report(all: Series[], meta: Record<string, unknown>): { json: string; txt: string; ok: boolean } {
  const rows = all.map((s) => ({ ...s, stats: s.samples.length ? stats(s.samples) : null }));
  const ok = rows.every((s) => !s.failures.length && s.samples.length > 0);
  const pad = (v: string, n: number): string => v.padEnd(n);
  const line = (s: (typeof rows)[number]): string => s.stats
    ? `${pad(s.name, 30)} ${pad(s.kind, 6)} p50 ${String(s.stats.p50).padStart(7)} ms  p90 ${String(s.stats.p90).padStart(7)} ms  min ${String(s.stats.min).padStart(7)}  max ${String(s.stats.max).padStart(7)}  n ${s.stats.n}${s.failures.length ? `  FAIL ${s.failures.length}` : ''}`
    : `${pad(s.name, 30)} ${pad(s.kind, 6)} FAIL: no successful run`;
  const txt = [
    `timings (LOCAL wrangler dev, sequential): ${meta['base']}, ${meta['runs']} runs after ${meta['warmup']} warm-up, load ${meta['loadavg']}`,
    ...rows.map(line),
    ...rows.flatMap((s) => groupFailures(s.failures).map((f) => `  ${s.name}: ${f}`)),
    ok ? 'TIMINGS OK' : 'TIMINGS FAILED: some requests did not answer their expected status',
  ].join('\n');
  return { json: `${JSON.stringify({ tool: 'hb-timings', ok, ...meta, results: rows }, null, 2)}\n`, txt: `${txt}\n`, ok };
}

export async function main(argv: string[]): Promise<number> {
  let a;
  try { a = parseArgs({ args: argv, options: OPTIONS }).values; } catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); return 2; }
  if (a.help) { console.log(USAGE); return 0; }
  const runs = Number(a.runs ?? 30), warmup = Number(a.warmup ?? 3);
  if (!(runs >= 1 && warmup >= 0)) { console.error(`timings: bad --runs/--warmup\n${USAGE}`); return 2; }
  const dist = path.resolve(a.dist ?? DEFAULT_DIST);
  const out = path.resolve(a.out ?? path.join(artifactsRoot(), 'timings-run'));
  mkdirSync(out, { recursive: true });
  const reg = discover(dist);
  if (reg.errors.length || !reg.targets.length) { console.error(`timings: template registry (${dist}): ${reg.errors.join('; ') || 'no targets'}`); return 2; }

  // the e2e harness reads HB_E2E_PERSIST at import: set it first, then import
  if (a.persist) process.env['HB_E2E_PERSIST'] = path.resolve(a.persist);
  const h = await import('../../../../tests/e2e/harness.ts');
  let base = a['base-url']?.replace(/\/$/, '');
  let stop: (() => Promise<void>) | null = null;
  try {
    if (!base) {
      const missing = h.missing('storefront', 'seed');
      if (missing) { console.error(`timings: cannot boot the web Worker: ${missing}`); return 2; }
      h.seedFresh();
      const w = await h.startWorker('web', path.join(out, 'logs'));
      base = w.url; stop = w.stop;
    }
    const all: Series[] = [];
    for (const t of reg.targets as TemplateTarget[]) {
      // not-found: what a visitor gets for a missing URL (404), not the 404.html file itself
      // (lh scores that file because Lighthouse refuses a 404; Workers assets redirect *.html)
      const [url, expect] = t.template === 'not-found' ? [`/${t.lang}/__timings-missing-page__/`, 404] : [t.url, t.expectStatus];
      all.push(await series(t.id, 'ttfb', url, expect, runs, warmup, () => timeOne(base + url)));
      console.log(`  ${t.id} ${url}: ${JSON.stringify(stats(all.at(-1)!.samples))}`);
    }
    if (!a['no-api']) {
      const pick = pickIds(h, { variant: a.variant, wilaya: a.wilaya, commune: a.commune }, runs + warmup);
      const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: base! }, body: JSON.stringify(body) });
      const quoteBody = { items: [{ variantId: pick.variant, qty: 1 }], wilayaCode: pick.wilaya, communeId: pick.commune };
      const q = await timeOne(`${base}/api/quote`, json(quoteBody));
      const total = (JSON.parse(q.body || '{}') as { totalDzd?: number }).totalDzd;
      if (q.status !== 200 || typeof total !== 'number') { console.error(`timings: /api/quote setup call: HTTP ${q.status} ${q.body.slice(0, 300)}`); return 2; }
      all.push(await series('api-quote', 'quote', '/api/quote', 200, runs, warmup, () => timeOne(`${base}/api/quote`, json(quoteBody))));
      const stamp = Date.now();
      all.push(await series('api-order', 'order', '/api/order', 201, runs, warmup, (i) => timeOne(`${base}/api/order`, json({
        lang: 'fr', items: quoteBody.items, name: `Timing ${i}`, phone: h.testPhone(stamp % 1_000_000 + i), wilayaCode: pick.wilaya, communeId: pick.commune,
        idempotencyKey: randomUUID(), expectedTotalDzd: total, fillMs: 10_000,
      }))));
    }
    const meta = { generatedAt: new Date().toISOString(), base, dist, runs, warmup, loadavg: loadavg().map((x) => x.toFixed(2)).join(' '), node: process.version, mode: stop ? 'harness (fresh seeded D1, wrangler dev)' : 'external server' };
    const r = report(all, meta);
    writeFileSync(path.join(out, 'timings.json'), r.json);
    writeFileSync(path.join(out, 'timings.txt'), r.txt);
    console.log(`\n${r.txt}reports: ${path.join(out, 'timings.json')}, ${path.join(out, 'timings.txt')}`);
    return r.ok ? 0 : 1;
  } catch (e) {
    console.error(`timings: ${(e as Error).message}`);
    return 2;
  } finally {
    if (stop) await stop();
  }
}

/** Ids for the API calls: flags, else the seeded D1 (an active variant with stock for every run, a served wilaya with a commune). */
function pickIds(h: typeof import('../../../../tests/e2e/harness.ts'), f: { variant?: string | undefined; wilaya?: string | undefined; commune?: string | undefined }, needed: number): { variant: number; wilaya: number; commune: number } {
  let variant = f.variant ? Number(f.variant) : NaN;
  if (Number.isNaN(variant)) {
    const v = h.d1<{ id: number; stock: number | null }>(
      `SELECT v.id AS id, v.stock AS stock FROM variants v JOIN products p ON p.id = v.product_id WHERE v.active = 1 AND p.status = 'active'
       ORDER BY (v.stock IS NULL) DESC, v.stock DESC, v.id LIMIT 1`)[0];
    if (!v) throw new Error('no active variant in the D1');
    if (v.stock !== null && v.stock < needed) throw new Error(`the variant with the most stock (${v.id}) has ${v.stock} < ${needed} orders to place: lower --runs`);
    variant = v.id;
  }
  let wilaya = f.wilaya ? Number(f.wilaya) : NaN;
  let commune = f.commune ? Number(f.commune) : NaN;
  if (Number.isNaN(wilaya) || Number.isNaN(commune)) {
    const w = h.d1<{ code: number; cid: number }>(
      `SELECT d.wilaya_code AS code, (SELECT id FROM communes c WHERE c.wilaya_code = d.wilaya_code ORDER BY id LIMIT 1) AS cid FROM delivery_fees d
       WHERE d.available = 1 AND EXISTS (SELECT 1 FROM communes c WHERE c.wilaya_code = d.wilaya_code) ORDER BY d.wilaya_code LIMIT 1`)[0];
    if (!w) throw new Error('no served wilaya with a commune in the D1');
    wilaya = w.code; commune = w.cid;
  }
  return { variant, wilaya, commune };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(REPO_ROOT);
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e: unknown) => { console.error(e); process.exitCode = 2; });
}
