/**
 * MEAS-2: the pass/fail rules of `npm run lh`, the template registry, the static server and the
 * lock helpers. Lighthouse itself is not run here (it needs the exclusive lock and minutes);
 * synthetic results exercise every rule, including the ones that must turn a run RED.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { AR_SI_LIMIT_MS, LH_VERSION, MOBILE_DEFAULTS, median, parseLhr, summarize, type RunRecord } from '../src/lh/summary.ts';
import { ancestors, ownerPid } from '../src/lh/lock.ts';
import { discover, templateFromUrl, targetsFromUrls } from '../src/templates.ts';
import { parseHeadersFile, resolveStatic, startStatic } from '../src/serve.ts';
import { put } from './fixtures/site.ts';

const URL0 = 'http://127.0.0.1:4112/ar/';

interface Opt {
  score?: number; a11y?: number; si?: number; lcp?: number; version?: string; formFactor?: string; mobile?: boolean;
  method?: string; rtt?: number; cpu?: number; bench?: number; status?: number; finalUrl?: string; runtimeError?: string; noPerf?: boolean;
  emulationDisabled?: boolean; consoleErrors?: string[];
}
function lhr(o: Opt = {}): unknown {
  const finalUrl = o.finalUrl ?? URL0;
  return {
    lighthouseVersion: o.version ?? LH_VERSION,
    finalDisplayedUrl: finalUrl,
    ...(o.runtimeError ? { runtimeError: { code: o.runtimeError, message: 'boom' } } : {}),
    configSettings: {
      formFactor: o.formFactor ?? 'mobile',
      throttlingMethod: o.method ?? 'simulate',
      throttling: { rttMs: o.rtt ?? MOBILE_DEFAULTS.rttMs, throughputKbps: MOBILE_DEFAULTS.throughputKbps, cpuSlowdownMultiplier: o.cpu ?? MOBILE_DEFAULTS.cpuSlowdownMultiplier },
      screenEmulation: { mobile: o.mobile ?? true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: o.emulationDisabled ?? false },
    },
    environment: { benchmarkIndex: o.bench ?? 2100 },
    categories: { performance: { score: o.noPerf ? null : (o.score ?? 1) }, accessibility: { score: o.a11y ?? 1 }, 'best-practices': { score: 0.96 }, seo: { score: 0.92 } },
    audits: {
      'first-contentful-paint': { numericValue: 800 },
      'largest-contentful-paint': { numericValue: o.lcp ?? 1000 },
      'total-blocking-time': { numericValue: 0 },
      'cumulative-layout-shift': { numericValue: 0 },
      'speed-index': { numericValue: o.si ?? 900 },
      'errors-in-console': { details: { items: (o.consoleErrors ?? []).map((d) => ({ source: 'javascript', description: d })) } },
      'network-requests': { details: { items: [{ url: finalUrl, resourceType: 'Document', statusCode: o.status ?? 200, transferSize: 2500, resourceSize: 7000 }] } },
    },
  };
}
const rec = (attempt: number, o: Opt = {}, extra: Partial<RunRecord> = {}): RunRecord => {
  const p = parseLhr(lhr(o), URL0);
  return { target: 'home-ar', url: URL0, attempt, retry: false, file: `/x/home-ar-${attempt}.json`, loadavgBefore: 1, ...p, contended: p.lowBenchmark, ...extra };
};
const T = { id: 'home-ar', template: 'home', lang: 'ar', url: '/ar/', expectStatus: 200 };
const five = (f: (i: number) => Opt = () => ({})): RunRecord[] => [1, 2, 3, 4, 5].map((i) => rec(i, f(i)));

describe('parseLhr guards (a mis-configured run never counts)', () => {
  it('accepts a default mobile 13.6.0 run', () => {
    const r = parseLhr(lhr(), URL0);
    expect(r.problems).toEqual([]);
    expect(r.error).toBeUndefined();
    expect(r.metrics?.score).toBe(1);
    expect(r.status).toBe(200);
  });
  it.each([
    ['another Lighthouse version', { version: '12.8.0' }, /Lighthouse 12\.8\.0/],
    ['desktop preset', { formFactor: 'desktop', mobile: false }, /formFactor desktop/],
    ['devtools throttling', { method: 'devtools' }, /throttlingMethod devtools/],
    ['custom RTT', { rtt: 40 }, /throttling\.rttMs/],
    ['no CPU slowdown', { cpu: 1 }, /cpuSlowdownMultiplier/],
    ['a redirect', { finalUrl: 'http://127.0.0.1:4112/fr/' }, /redirected/],
    ['mobile emulation disabled', { emulationDisabled: true }, /screenEmulation\.disabled/],
  ] as const)('flags %s', (_n, o, re) => {
    expect(parseLhr(lhr(o), URL0).problems.join('\n')).toMatch(re);
  });
  it('turns runtime errors and missing scores into errors', () => {
    expect(parseLhr(lhr({ runtimeError: 'NO_FCP' }), URL0).error).toMatch(/NO_FCP/);
    expect(parseLhr(lhr({ noPerf: true }), URL0).error).toMatch(/missing category score/);
    expect(parseLhr({}, URL0).error).toBeDefined();
  });
  it('marks a low benchmarkIndex', () => {
    expect(parseLhr(lhr({ bench: 498 }), URL0).lowBenchmark).toBe(true);
    expect(parseLhr(lhr({ bench: 2100 }), URL0).lowBenchmark).toBe(false);
  });
});

describe('summarize', () => {
  it('passes five 100/100 runs and reports medians', () => {
    const s = summarize(T, five((i) => ({ lcp: 900 + i * 10 })), 5);
    expect(s.ok).toBe(true);
    expect(s.medians?.lcp).toBe(930);
    expect(s.medianRun?.score).toBe(100);
  });
  it('fails when the median performance is 99 (median run by score)', () => {
    const s = summarize(T, five((i) => ({ score: i <= 3 ? 0.99 : 1 })), 5);
    expect(s.ok).toBe(false);
    expect(s.failures.join()).toMatch(/median Performance 99/);
  });
  it('passes when only a minority of runs is 99', () => {
    expect(summarize(T, five((i) => ({ score: i <= 2 ? 0.99 : 1 })), 5).ok).toBe(true);
  });
  it('treats 0.995 as 100 and 0.994 as 99 (Lighthouse rounding)', () => {
    expect(summarize(T, five(() => ({ score: 0.995 })), 5).ok).toBe(true);
    expect(summarize(T, five(() => ({ score: 0.994 })), 5).ok).toBe(false);
  });
  it('fails if any run has accessibility below 100', () => {
    const s = summarize(T, five((i) => ({ a11y: i === 5 ? 0.98 : 1 })), 5);
    expect(s.failures.join()).toMatch(/Accessibility 98/);
  });
  it('one crashed run is RED, never a median of 4 (QA)', () => {
    const runs = five();
    runs[2] = { ...rec(3), metrics: undefined, error: 'lighthouse exited 1 without a report' } as unknown as RunRecord;
    const s = summarize(T, runs, 5);
    expect(s.ok).toBe(false);
    expect(s.failures.join()).toMatch(/run 3 failed/);
  });
  it('missing runs are RED', () => {
    expect(summarize(T, five().slice(0, 4), 5).failures.join()).toMatch(/4 of 5 runs/);
  });
  it('a configuration problem in any run is RED', () => {
    expect(summarize(T, five((i) => (i === 1 ? { version: '13.5.0' } : {})), 5).ok).toBe(false);
  });
  it('wrong HTTP status is RED', () => {
    expect(summarize(T, five(() => ({ status: 404 })), 5).failures.join()).toMatch(/HTTP 404/);
  });
  it(`Arabic median Speed Index ≥ ${AR_SI_LIMIT_MS} ms is RED with the font-fallback message`, () => {
    const s = summarize(T, five(() => ({ si: AR_SI_LIMIT_MS })), 5);
    expect(s.ok).toBe(false);
    expect(s.failures.join()).toMatch(/font fallback rule/);
    expect(summarize(T, five(() => ({ si: AR_SI_LIMIT_MS - 1 })), 5).ok).toBe(true);
  });
  it('the Speed Index rule applies to Arabic pages only', () => {
    expect(summarize({ ...T, id: 'home-fr', lang: 'fr', url: '/fr/' }, five(() => ({ si: 2500 })), 5).ok).toBe(true);
  });
  it('reports retries and runs still contended after the retry', () => {
    const first = rec(2, { bench: 400 });
    const retry = rec(2, { bench: 450 }, { retry: true });
    const final = five();
    final[1] = retry;
    const s = summarize(T, final, 5, [...final, first]);
    expect(s.notes.join()).toMatch(/run 2 retried: first attempt was contended \(benchmarkIndex 400/);
    expect(s.notes.join()).toMatch(/1 of 5 runs contended after retry/);
    expect(s.verdict).toBe('pass');
  });
  it('a failure with a contended run is INCONCLUSIVE, not pass and not a clean fail', () => {
    const final = five(() => ({ score: 0.97 }));
    final[0] = { ...final[0] as RunRecord, contended: true, loadavgBefore: 21 };
    const s = summarize(T, final, 5);
    expect(s.ok).toBe(false);
    expect(s.verdict).toBe('inconclusive');
  });
  it('a failure on a quiet machine is FAIL', () => {
    expect(summarize(T, five(() => ({ score: 0.97 })), 5).verdict).toBe('fail');
  });
  it('a crash or wrong configuration is FAIL even when contended', () => {
    const final = five();
    final[0] = { ...rec(1, { version: '12.0.0' }), contended: true };
    expect(summarize(T, final, 5).verdict).toBe('fail');
  });
  it('deterministic failures are FAIL even on a contended machine (accessibility, status, console errors)', () => {
    const contend = (rs: RunRecord[]): RunRecord[] => rs.map((r) => ({ ...r, contended: true, loadavgBefore: 20 }));
    expect(summarize(T, contend(five(() => ({ a11y: 0.98 }))), 5).verdict).toBe('fail');
    expect(summarize(T, contend(five(() => ({ status: 500 }))), 5).verdict).toBe('fail');
    expect(summarize(T, contend(five(() => ({ consoleErrors: ['Uncaught TypeError: x is undefined'] }))), 5).verdict).toBe('fail');
    // …while a performance-only failure under contention stays inconclusive
    expect(summarize(T, contend(five(() => ({ score: 0.97 }))), 5).verdict).toBe('inconclusive');
    // a mix: perf failure + a11y failure under contention is FAIL
    expect(summarize(T, contend(five(() => ({ score: 0.97, a11y: 0.9 }))), 5).verdict).toBe('fail');
  });
  it('console errors fail on a quiet machine too, and best-practices/SEO scores are recorded, not gated', () => {
    const s = summarize(T, five((i) => (i === 3 ? { consoleErrors: ['boom'] } : {})), 5);
    expect(s.failures.join()).toMatch(/run 3: 1 console error/);
    const r = parseLhr(lhr(), URL0);
    expect(r.info).toEqual({ bestPractices: 0.96, seo: 0.92 });
    expect(summarize(T, five(), 5).ok).toBe(true);
  });
  it('median()', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'hb-lh-')); temps.push(d); return d; };
const page = (lang: string, tpl?: string): string => `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"${tpl ? ` data-tpl="${tpl}"` : ''}><head></head><body></body></html>`;

function site(dir: string, omit: string[] = []): void {
  const files: Record<string, string> = {};
  for (const l of ['ar', 'fr']) {
    Object.assign(files, {
      [`${l}/index.html`]: page(l, 'home'), [`${l}/c/x/index.html`]: page(l, 'category'), [`${l}/c/x/2/index.html`]: page(l, 'category'),
      [`${l}/p/a/index.html`]: page(l, 'product'), [`${l}/p/b/index.html`]: page(l, 'product'), [`${l}/search/index.html`]: page(l, 'search'),
      [`${l}/about-${l}/index.html`]: page(l, 'content'), [`${l}/delivery-${l}/index.html`]: page(l, 'content'),
      [`${l}/order/confirmation/index.html`]: page(l, 'order-confirmed'), [`${l}/404.html`]: page(l, 'not-found'),
    });
  }
  files['404.html'] = page('ar', 'not-found');
  for (const [f, c] of Object.entries(files)) if (!omit.includes(f)) put(dir, f, c);
}

describe('template registry', () => {
  it('classifies the CAT-1 URL scheme', () => {
    expect(['/ar/', '/ar/c/x/', '/ar/c/x/3/', '/fr/p/y/', '/fr/search/', '/fr/order/confirmation/', '/ar/404.html', '/fr/livraison/', '/fr/js/', '/fr/a/b/', '/404.html']
      .map(templateFromUrl)).toEqual(['home', 'category', 'category', 'product', 'search', 'order-confirmed', 'not-found', 'content', null, null, null]);
  });
  it('picks one target per template and language, every content page, and lists the rest', () => {
    const d = tmp();
    site(d);
    const r = discover(d);
    expect(r.errors).toEqual([]);
    expect(r.targets.map((t) => t.id)).toEqual([
      'home-ar', 'category-ar', 'product-ar', 'search-ar', 'content-ar-about-ar', 'content-ar-delivery-ar', 'order-confirmed-ar', 'not-found-ar',
      'home-fr', 'category-fr', 'product-fr', 'search-fr', 'content-fr-about-fr', 'content-fr-delivery-fr', 'order-confirmed-fr', 'not-found-fr',
    ]);
    expect(r.skipped.map((s) => s.url)).toContain('/404.html');
    expect(r.skipped.map((s) => s.url)).toContain('/ar/c/x/2/');
  });
  it('measures the heaviest page of a template', () => {
    const d = tmp();
    site(d);
    put(d, 'ar/p/b/index.html', page('ar', 'product').replace('<body>', `<body><p>${'x'.repeat(5000)}</p>`));
    expect(discover(d).targets.find((t) => t.id === 'product-ar')?.url).toBe('/ar/p/b/');
  });
  it('a template missing in one language is an error', () => {
    const d = tmp();
    site(d, ['fr/search/index.html']);
    expect(discover(d).errors).toEqual(['template search has no page in /fr/']);
  });
  it('a page of an unknown template is an error, never silently skipped (QA)', () => {
    const d = tmp();
    site(d);
    put(d, 'ar/compare/x/index.html', page('ar'));
    put(d, 'ar/wishlist/index.html', page('ar', 'wishlist'));
    expect(discover(d).errors.join('\n')).toMatch(/\/ar\/compare\/x\/: cannot tell its template[\s\S]*unknown <html data-tpl="wishlist">/);
  });
  it('data-tpl contradicting the URL is an error', () => {
    const d = tmp();
    site(d);
    put(d, 'ar/p/a/index.html', page('ar', 'content'));
    expect(discover(d).errors.join()).toMatch(/data-tpl="content" but the URL scheme says product/);
  });
  it('explicit URL lists', () => {
    expect(targetsFromUrls(['/ar/', 'http://h/fr/p/x/']).map((t) => [t.id, t.url])).toEqual([['01-home-ar', '/ar/'], ['02-product-fr', '/fr/p/x/']]);
  });
});

describe('static server', () => {
  it('maps paths like Workers static assets', () => {
    const d = tmp();
    site(d);
    expect(resolveStatic(d, '/ar/').status).toBe(200);
    expect(resolveStatic(d, '/ar/c/x')).toMatchObject({ status: 307, redirect: '/ar/c/x/' });
    expect(resolveStatic(d, '/ar/nope/')).toMatchObject({ status: 404, file: path.join(d, 'ar/404.html') });
    expect(resolveStatic(d, '/zz')).toMatchObject({ status: 404, file: path.join(d, '404.html') });
    expect(resolveStatic(d, '/../etc/passwd').status).not.toBe(200);
  });
  it('parses _headers', () => {
    const rules = parseHeadersFile('/*\n  X-Content-Type-Options: nosniff\n/img/*\n  Cache-Control: public, max-age=31536000, immutable\n');
    expect(rules.map((r) => [r.re.test('/img/a.avif'), r.headers])).toEqual([
      [true, [['X-Content-Type-Options', 'nosniff']]], [true, [['Cache-Control', 'public, max-age=31536000, immutable']]],
    ]);
  });
  it('serves brotli, _headers and 404 pages over HTTP', async () => {
    const d = tmp();
    site(d);
    put(d, '_headers', '/*\n  X-Test: yes\n');
    const s = await startStatic(d, 0);
    try {
      const r = await fetch(`${s.baseUrl}/fr/`, { headers: { 'accept-encoding': 'br' } });
      expect(r.status).toBe(200);
      expect(r.headers.get('x-test')).toBe('yes');
      const nf = await fetch(`${s.baseUrl}/fr/missing/`);
      expect(nf.status).toBe(404);
      expect(await nf.text()).toContain('lang="fr"');
      // fetch() decodes br transparently; check the raw encoding with a plain request
      const raw = await new Promise<Buffer>((ok, fail) => {
        import('node:http').then(({ get }) => get(`${s.baseUrl}/fr/`, { headers: { 'accept-encoding': 'br' } }, (res) => {
          expect(res.headers['content-encoding']).toBe('br');
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c)).on('end', () => ok(Buffer.concat(chunks)));
        }).on('error', fail), fail);
      });
      expect(brotliDecompressSync(raw).toString()).toContain('data-tpl="home"');
    } finally { await s.stop(); }
  });
});

describe('lock helpers', () => {
  it('reads the owner pid written by scripts/lib/locks.sh', () => {
    expect(ownerPid('2026-11-04T18:00:00Z pid=12345 lighthouse team/measure /x')).toBe(12345);
    expect(ownerPid('garbage')).toBeNull();
  });
  it('walks the parent chain', () => {
    const a = ancestors();
    expect(a[0]).toBe(process.ppid);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('gate mode', () => {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/lh/cli.ts');
  it.each([['--runs', '1'], ['--url', '/ar/'], ['--template', 'home'], ['--max-load', '99'], ['--base-url', 'http://x']])('refuses %s in --gate mode', (flag, val) => {
    const r = spawnSync(process.execPath, [cli, '--gate', flag, val], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/gate mode refuses/);
  });
  it('HB_GATE=1 is the same as --gate', () => {
    const r = spawnSync(process.execPath, [cli, '--runs', '1'], { encoding: 'utf8', env: { ...process.env, HB_GATE: '1' } });
    expect(r.status).toBe(2);
  });
});
