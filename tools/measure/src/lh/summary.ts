/**
 * Lighthouse result parsing and the pass/fail rules of `npm run lh` (MEAS-2). Pure: no Chrome,
 * no I/O, so every rule is unit-tested with synthetic results (test/lh.test.ts).
 */

export const LH_VERSION = '13.6.0';
/** Lighthouse 13 mobile defaults (constants.throttling.mobileSlow4G + moto G power emulation). */
export const MOBILE_DEFAULTS = { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4, width: 412, height: 823, deviceScaleFactor: 1.75 } as const;
/** CLAUDE.md font fallback rule: Arabic pages with Speed Index ≥ 1.95 s fail. */
export const AR_SI_LIMIT_MS = 1950;
/**
 * benchmarkIndex below which a run counts as "machine loaded" and is retried once.
 * Evidence: this machine's quiet spike runs scored 1,843–2,347 (medians 2,134–2,217); runs
 * taken while it was loaded fell to 117–1,505 (research-evidence raw Lighthouse JSON, 155 runs).
 */
export const DEFAULT_MIN_BENCHMARK = 1500;
/**
 * 1-minute load average above which a run counts as contended (lead's machine rule, 2026-11-05:
 * 8 cores shared by 20+ agents; an unguarded score is noise). The runner waits for the load to
 * drop below it before each run, and retries a contended run once.
 */
export const DEFAULT_MAX_LOAD = 4;

export interface RunMetrics { score: number; a11y: number; fcp: number; lcp: number; tbt: number; cls: number; si: number }
/** Not gated (not a CLAUDE.md budget), recorded for the report. */
export interface InfoScores { bestPractices?: number; seo?: number }

export interface RunRecord {
  target: string;
  url: string;
  attempt: number;
  retry: boolean;
  file: string;
  /** set when the run produced no usable result (crash, runtime error, missing category) */
  error?: string;
  /** configuration problems that make the result invalid as evidence (wrong version, desktop…) */
  problems: string[];
  lighthouseVersion?: string;
  benchmarkIndex?: number;
  loadavgBefore: number;
  loadavgAfter?: number;
  /** benchmarkIndex below the minimum */
  lowBenchmark: boolean;
  /** lowBenchmark, or the 1-minute load average above the maximum when the run started */
  contended: boolean;
  status?: number;
  finalUrl?: string;
  docTransferBytes?: number;
  docResourceBytes?: number;
  metrics?: RunMetrics;
  info?: InfoScores;
  /** browser console errors (Lighthouse `errors-in-console`): deterministic, gated */
  consoleErrors?: string[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Extract metrics and validate the configuration of one Lighthouse result (LHR). */
export function parseLhr(lhrIn: unknown, requestedUrl: string, minBenchmark = DEFAULT_MIN_BENCHMARK): Omit<RunRecord, 'target' | 'url' | 'attempt' | 'retry' | 'file' | 'loadavgBefore' | 'loadavgAfter' | 'contended'> {
  const lhr = obj(lhrIn);
  const problems: string[] = [];
  const version = typeof lhr['lighthouseVersion'] === 'string' ? lhr['lighthouseVersion'] : undefined;
  if (version !== LH_VERSION) problems.push(`Lighthouse ${version ?? '?'} (required exactly ${LH_VERSION})`);
  const cs = obj(lhr['configSettings']);
  const thr = obj(cs['throttling']);
  const scr = obj(cs['screenEmulation']);
  if (cs['formFactor'] !== 'mobile' || scr['mobile'] !== true) problems.push(`formFactor ${String(cs['formFactor'])} (required mobile)`);
  if (scr['disabled'] !== false) problems.push(`screenEmulation.disabled = ${String(scr['disabled'])} (mobile emulation must be on)`);
  if (cs['throttlingMethod'] !== 'simulate') problems.push(`throttlingMethod ${String(cs['throttlingMethod'])} (required simulate)`);
  for (const [k, want] of [['rttMs', MOBILE_DEFAULTS.rttMs], ['throughputKbps', MOBILE_DEFAULTS.throughputKbps], ['cpuSlowdownMultiplier', MOBILE_DEFAULTS.cpuSlowdownMultiplier]] as const) {
    if (num(thr[k]) !== want) problems.push(`throttling.${k} = ${String(thr[k])} (Lighthouse mobile default ${want})`);
  }
  for (const [k, want] of [['width', MOBILE_DEFAULTS.width], ['height', MOBILE_DEFAULTS.height], ['deviceScaleFactor', MOBILE_DEFAULTS.deviceScaleFactor]] as const) {
    if (num(scr[k]) !== want) problems.push(`screenEmulation.${k} = ${String(scr[k])} (default ${want})`);
  }
  const env = obj(lhr['environment']);
  const benchmarkIndex = num(env['benchmarkIndex']);
  const base = {
    problems,
    ...(version ? { lighthouseVersion: version } : {}),
    ...(benchmarkIndex !== undefined ? { benchmarkIndex } : {}),
    lowBenchmark: benchmarkIndex !== undefined && benchmarkIndex < minBenchmark,
  };
  const rt = obj(lhr['runtimeError']);
  if (typeof rt['code'] === 'string') return { ...base, error: `runtimeError ${rt['code']}: ${String(rt['message'] ?? '')}` };
  const cats = obj(lhr['categories']);
  const score = num(obj(cats['performance'])['score']);
  const a11y = num(obj(cats['accessibility'])['score']);
  if (score === undefined || a11y === undefined) return { ...base, error: `missing category score (performance ${String(score)}, accessibility ${String(a11y)})` };
  const audits = obj(lhr['audits']);
  const metric = (id: string): number | undefined => num(obj(audits[id])['numericValue']);
  const m = { fcp: metric('first-contentful-paint'), lcp: metric('largest-contentful-paint'), tbt: metric('total-blocking-time'), cls: metric('cumulative-layout-shift'), si: metric('speed-index') };
  const missing = Object.entries(m).filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length) return { ...base, error: `missing metrics: ${missing.join(', ')}` };
  const items = (obj(obj(audits['network-requests'])['details'])['items'] as unknown[] | undefined) ?? [];
  const finalUrl = typeof lhr['finalDisplayedUrl'] === 'string' ? lhr['finalDisplayedUrl'] : undefined;
  const doc = items.map(obj).find((i) => i['url'] === finalUrl) ?? items.map(obj).find((i) => i['resourceType'] === 'Document');
  const status = num(doc?.['statusCode']);
  const docTransferBytes = num(doc?.['transferSize']);
  const docResourceBytes = num(doc?.['resourceSize']);
  if (finalUrl !== undefined && finalUrl !== requestedUrl) problems.push(`redirected: ${requestedUrl} → ${finalUrl}`);
  const bp = num(obj(cats['best-practices'])['score']);
  const seo = num(obj(cats['seo'])['score']);
  const consoleItems = (obj(obj(audits['errors-in-console'])['details'])['items'] as unknown[] | undefined) ?? [];
  const consoleErrors = consoleItems.map(obj).map((i) => `${String(i['source'] ?? '')}: ${String(i['description'] ?? '')}`.slice(0, 300));
  return {
    ...base,
    ...(status !== undefined ? { status } : {}),
    ...(finalUrl !== undefined ? { finalUrl } : {}),
    ...(docTransferBytes !== undefined ? { docTransferBytes } : {}),
    ...(docResourceBytes !== undefined ? { docResourceBytes } : {}),
    metrics: { score, a11y, fcp: m.fcp ?? 0, lcp: m.lcp ?? 0, tbt: m.tbt ?? 0, cls: m.cls ?? 0, si: m.si ?? 0 },
    info: { ...(bp !== undefined ? { bestPractices: bp } : {}), ...(seo !== undefined ? { seo } : {}) },
    consoleErrors,
  };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return NaN;
  return n % 2 ? (s[(n - 1) / 2] ?? NaN) : ((s[n / 2 - 1] ?? 0) + (s[n / 2] ?? 0)) / 2;
}

/** Lighthouse displays category scores as Math.round(score × 100). */
export const pct = (score: number): number => Math.round(score * 100);

export interface TargetSummary {
  id: string;
  template: string;
  lang: string;
  url: string;
  ok: boolean;
  /** pass; fail; inconclusive = failed, but at least one run was on a contended machine */
  verdict: 'pass' | 'fail' | 'inconclusive';
  failures: string[];
  notes: string[];
  runs: number;
  /** the run whose performance score is the median (sorted by score, middle one) */
  medianRun?: { attempt: number; file: string; score: number; a11y: number };
  /** per-metric medians across runs */
  medians?: { score: number; a11y: number; fcp: number; lcp: number; tbt: number; cls: number; si: number };
  benchmarkIndex: Array<number | null>;
  loadavg: number[];
}

/**
 * Pass/fail for one template URL. `final` = the record kept for each attempt (the retry when a
 * loaded run was retried). Any errored attempt fails the URL: a crash is red, never "median of 4".
 */
export function summarize(t: { id: string; template: string; lang: string; url: string; expectStatus: number }, final: RunRecord[], expectedRuns: number, all: RunRecord[] = final): TargetSummary {
  // hard = deterministic (never excused by machine load); perf = load-sensitive timing results
  const failures: string[] = [];
  const perf: string[] = [];
  const notes: string[] = [];
  if (final.length !== expectedRuns) failures.push(`${final.length} of ${expectedRuns} runs recorded`);
  for (const r of final) {
    if (r.error) failures.push(`run ${r.attempt}${r.retry ? ' (retry)' : ''} failed: ${r.error}`);
    for (const p of r.problems) failures.push(`run ${r.attempt}: ${p}`);
    if (!r.error && r.status !== undefined && r.status !== t.expectStatus) failures.push(`run ${r.attempt}: HTTP ${r.status} (expected ${t.expectStatus})`);
    if (!r.error && r.status === undefined) failures.push(`run ${r.attempt}: main document not found in network-requests`);
    if (r.consoleErrors?.length) failures.push(`run ${r.attempt}: ${r.consoleErrors.length} console error(s): ${r.consoleErrors.slice(0, 3).join(' | ')}`);
  }
  const why = (r: RunRecord): string => `benchmarkIndex ${r.benchmarkIndex ?? '?'}, load ${r.loadavgBefore.toFixed(1)}`;
  for (const r of all.filter((x) => x.retry)) {
    const first = all.find((x) => x.attempt === r.attempt && !x.retry);
    notes.push(`run ${r.attempt} retried: first attempt was contended (${first ? why(first) : '?'})`);
  }
  const contended = final.filter((r) => r.contended);
  if (contended.length) notes.push(`${contended.length} of ${final.length} runs contended after retry (${contended.map(why).join('; ')})`);
  const good = final.filter((r): r is RunRecord & { metrics: RunMetrics } => !r.error && !!r.metrics);
  const base = {
    id: t.id, template: t.template, lang: t.lang, url: t.url, runs: final.length, notes,
    benchmarkIndex: final.map((r) => r.benchmarkIndex ?? null), loadavg: final.map((r) => r.loadavgBefore),
  };
  if (!good.length) return { ...base, ok: false, verdict: 'fail', failures: failures.length ? failures : ['no successful run'] };
  const byScore = [...good].sort((a, b) => a.metrics.score - b.metrics.score || a.attempt - b.attempt);
  const mid = byScore[Math.floor((byScore.length - 1) / 2)] ?? byScore[0];
  const med = (k: keyof RunMetrics): number => median(good.map((r) => r.metrics[k]));
  const medians = { score: med('score'), a11y: med('a11y'), fcp: med('fcp'), lcp: med('lcp'), tbt: med('tbt'), cls: med('cls'), si: med('si') };
  if (mid && pct(mid.metrics.score) !== 100) perf.push(`median Performance ${pct(mid.metrics.score)} (required 100; runs: ${good.map((r) => pct(r.metrics.score)).join(', ')})`);
  const badA11y = good.filter((r) => pct(r.metrics.a11y) !== 100);
  if (badA11y.length) failures.push(`Accessibility ${badA11y.map((r) => pct(r.metrics.a11y)).join(', ')} in ${badA11y.length} run(s) (required 100 in every run)`);
  if (t.lang === 'ar' && medians.si >= AR_SI_LIMIT_MS) {
    perf.push(`median Speed Index ${Math.round(medians.si)} ms ≥ ${AR_SI_LIMIT_MS} ms on an Arabic page: CLAUDE.md font fallback rule (switch to the system Arabic font and record it in DECISIONS.md)`);
  }
  // Only the performance score and its timing metrics are load-sensitive. A hard failure
  // (accessibility, HTTP status, console errors, crashes, configuration) is FAIL whatever the load;
  // a performance-only failure with any contended run is INCONCLUSIVE; a pass under load stands
  // (load only makes simulated metrics worse).
  const verdict = failures.length ? 'fail' : perf.length === 0 ? 'pass' : contended.length ? 'inconclusive' : 'fail';
  failures.push(...perf);
  if (verdict === 'pass' && contended.length) notes.push('passed despite contention (load only worsens Lighthouse metrics)');
  return {
    ...base,
    ok: verdict === 'pass',
    verdict,
    failures,
    ...(mid ? { medianRun: { attempt: mid.attempt, file: mid.file, score: pct(mid.metrics.score), a11y: pct(mid.metrics.a11y) } } : {}),
    medians,
  };
}
