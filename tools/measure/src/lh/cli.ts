#!/usr/bin/env node
/**
 * npm run lh — Lighthouse 13.6.0 mobile (simulated throttling), N runs per template URL in
 * /ar/ and /fr/, under the machine-wide exclusive lock. Usage: tools/measure/README.md.
 * Exit 0 = every URL green; 1 = a failure; 2 = setup error (wrong version, server, flags);
 * 3 = inconclusive: no clean failure, but some URL failed only on a contended machine.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_DIST, REPO_ROOT, artifactsRoot } from '../lib/paths.ts';
import { discover, targetsFromUrls, type TemplateTarget } from '../templates.ts';
import { DEFAULT_PORT, externalServer, startServer, type ServeMode, type Server } from '../serve.ts';
import { ensureLock } from './lock.ts';
import { DEFAULT_MAX_LOAD, DEFAULT_MIN_BENCHMARK, LH_VERSION, parseLhr, pct, summarize, type RunRecord, type TargetSummary } from './summary.ts';

const USAGE = `usage: npm run lh -- [options]
  --dist <dir>          built site (default apps/storefront/dist); templates are discovered from it
  --base-url <url>      measure an already running server instead of starting one
  --serve <mode>        auto (default: wrangler dev of apps/web if present, else static) | static | wrangler
  --port <n>            port for the server it starts (default ${DEFAULT_PORT}; measure block 4110–4119)
  --url <path>          measure only this path (repeatable), e.g. --url /ar/ --url /fr/p/x/
  --urls <file>         measure the paths listed in a file (one per line, # comments)
  --template <name>     only targets of this template (repeatable)
  --runs <n>            runs per URL (default 5; the gate always uses 5)
  --min-benchmark <n>   benchmarkIndex below which a run is contended (default ${DEFAULT_MIN_BENCHMARK})
  --max-load <n>        1-minute load average above which a run is contended (default ${DEFAULT_MAX_LOAD})
  --quiet-wait <s>      before each run, wait up to this long for the load to drop (default 900)
  --quiet-wait-total <s>  total load-wait budget for the whole invocation (default 1800); once spent,
                        runs start at once (and are flagged contended when the load is high)
  --out <dir>           output directory (default <main checkout>/artifacts/lh)
  --chrome-path <path>  Chrome binary (default /usr/bin/google-chrome)
  --gate                strict mode for scripts/gate.sh (also HB_GATE=1): refuses every option that
                        narrows or relaxes the run (--url, --urls, --template, --runs, --min-benchmark,
                        --max-load, --base-url, --dist)`;

const require = createRequire(import.meta.url);

function lighthouseBin(): { bin: string; version: string } {
  const pkgPath = require.resolve('lighthouse/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string; bin: Record<string, string> | string };
  const rel = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin['lighthouse'] ?? '');
  return { bin: path.join(path.dirname(pkgPath), rel), version: pkg.version };
}

function runLighthouse(bin: string, url: string, outFile: string, chromePath: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, url,
      '--output=json', `--output-path=${outFile}`, '--only-categories=performance,accessibility,best-practices,seo',
      `--chrome-path=${chromePath}`, '--chrome-flags=--headless=new --no-sandbox --disable-gpu --no-first-run --disable-dev-shm-usage',
      '--max-wait-for-load=60000', '--quiet'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); stderr += '\nkilled after 240 s'; }, 240_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

/** Remaining total load-wait budget (ms) for this invocation; bounds the gate's wall time. */
const waitBudget = { remainingMs: 1800_000 };

/** Wait (polling) until the 1-minute load average is ≤ max, up to waitS seconds and the remaining budget. */
async function waitForQuiet(max: number, waitS: number, label: string): Promise<void> {
  const start = Date.now();
  const end = start + Math.min(waitS * 1000, waitBudget.remainingMs);
  let said = false;
  while ((loadavg()[0] ?? 0) > max && Date.now() < end) {
    if (!said) { console.log(`  ${label}: waiting up to ${waitS} s for load ≤ ${max} (now ${loadavg()[0]?.toFixed(1)})`); said = true; }
    await new Promise((ok) => setTimeout(ok, 10_000));
  }
  waitBudget.remainingMs = Math.max(0, waitBudget.remainingMs - (Date.now() - start));
  if (said) console.log(`  ${label}: load ${loadavg()[0]?.toFixed(1)}${(loadavg()[0] ?? 0) > max ? ' still high, running anyway (run will be flagged contended)' : ', going'}; wait budget left ${Math.round(waitBudget.remainingMs / 1000)} s`);
}

async function oneRun(o: { bin: string; target: TemplateTarget; baseUrl: string; attempt: number; retry: boolean; dir: string; chromePath: string; minBenchmark: number; maxLoad: number; quietWait: number }): Promise<RunRecord> {
  const url = o.baseUrl + o.target.url;
  const file = path.join(o.dir, `${o.target.id}-${o.attempt}${o.retry ? '-retry' : ''}.json`);
  await waitForQuiet(o.maxLoad, o.quietWait, `${o.target.id} run ${o.attempt}${o.retry ? ' (retry)' : ''}`);
  const loadavgBefore = loadavg()[0] ?? 0;
  const { code, stderr } = await runLighthouse(o.bin, url, file, o.chromePath);
  const loadavgAfter = loadavg()[0] ?? 0;
  const busy = loadavgBefore > o.maxLoad;
  const rec: RunRecord = { target: o.target.id, url, attempt: o.attempt, retry: o.retry, file, problems: [], loadavgBefore, loadavgAfter, lowBenchmark: false, contended: busy };
  if (!existsSync(file)) return { ...rec, error: `lighthouse exited ${code} without a report: ${stderr.trim().split('\n').slice(-3).join(' | ')}` };
  let lhr: unknown;
  try { lhr = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { ...rec, error: `unreadable report: ${(e as Error).message}` }; }
  const parsed = parseLhr(lhr, url, o.minBenchmark);
  return { ...rec, ...parsed, contended: busy || parsed.lowBenchmark };
}

export async function main(argv: string[]): Promise<number> {
  let a;
  try {
    a = parseArgs({
      args: argv,
      options: {
        'dist': { type: 'string' }, 'base-url': { type: 'string' }, 'serve': { type: 'string' }, 'port': { type: 'string' },
        'url': { type: 'string', multiple: true }, 'urls': { type: 'string' }, 'template': { type: 'string', multiple: true },
        'runs': { type: 'string' }, 'min-benchmark': { type: 'string' }, 'max-load': { type: 'string' }, 'quiet-wait': { type: 'string' }, 'quiet-wait-total': { type: 'string' }, 'out': { type: 'string' }, 'chrome-path': { type: 'string' },
        'gate': { type: 'boolean' }, 'help': { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); return 2; }
  if (a.help) { console.log(USAGE); return 0; }
  if (a.gate || process.env['HB_GATE'] === '1') {
    const relaxing = (['url', 'urls', 'template', 'runs', 'min-benchmark', 'max-load', 'base-url', 'dist'] as const).filter((k) => a[k] !== undefined);
    if (relaxing.length) { console.error(`lh: gate mode refuses --${relaxing.join(', --')} (the gate measures every template, 5 runs, default thresholds)`); return 2; }
  }
  const runs = Number(a.runs ?? 5);
  const minBenchmark = Number(a['min-benchmark'] ?? DEFAULT_MIN_BENCHMARK);
  const maxLoad = Number(a['max-load'] ?? DEFAULT_MAX_LOAD);
  const quietWait = Number(a['quiet-wait'] ?? 900);
  waitBudget.remainingMs = Number(a['quiet-wait-total'] ?? 1800) * 1000;
  const port = Number(a.port ?? DEFAULT_PORT);
  const serveMode = (a.serve ?? 'auto') as ServeMode;
  if (!Number.isInteger(runs) || runs < 1 || !Number.isFinite(minBenchmark) || !Number.isFinite(maxLoad) || !Number.isFinite(quietWait) || !Number.isFinite(waitBudget.remainingMs) || !Number.isInteger(port) || !['auto', 'static', 'wrangler'].includes(serveMode)) {
    console.error(`bad --runs / --min-benchmark / --port / --serve\n${USAGE}`); return 2;
  }
  const chromePath = a['chrome-path'] ?? '/usr/bin/google-chrome';
  if (!existsSync(chromePath)) { console.error(`lh: Chrome not found at ${chromePath}`); return 2; }
  let lh;
  try { lh = lighthouseBin(); } catch (e) { console.error(`lh: lighthouse not installed: ${(e as Error).message}`); return 2; }
  if (lh.version !== LH_VERSION) { console.error(`lh: installed Lighthouse is ${lh.version}; required exactly ${LH_VERSION}`); return 2; }

  // ---- exclusive lock (re-exec under scripts/lib/locks.sh unless an ancestor already holds it)
  const relocked = ensureLock([fileURLToPath(import.meta.url), ...argv]);
  if (relocked !== null) return relocked;

  const dist = path.resolve(a.dist ?? DEFAULT_DIST);
  const out = path.resolve(a.out ?? path.join(artifactsRoot(), 'lh'));
  const runDir = path.join(out, 'runs');
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });

  // ---- targets
  const errors: string[] = [];
  let targets: TemplateTarget[];
  let skipped: Array<{ url: string; reason: string }> = [];
  if (a.url?.length || a.urls) {
    const list = [...(a.url ?? []), ...(a.urls ? readFileSync(a.urls, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean) : [])];
    targets = targetsFromUrls(list);
  } else {
    if (!existsSync(dist)) { console.error(`lh: dist not found: ${dist} (build first, or pass --url/--urls with --base-url)`); return 1; }
    const reg = discover(dist);
    targets = reg.targets;
    skipped = reg.skipped;
    errors.push(...reg.errors);
  }
  if (a.template?.length) targets = targets.filter((t) => a.template?.includes(t.template));
  if (!targets.length) errors.push('no URL to measure');

  // ---- server
  let server: Server;
  try {
    server = a['base-url'] ? externalServer(a['base-url']) : await startServer({ mode: serveMode, dist, port, logFile: path.join(out, 'server.log') });
  } catch (e) { console.error(`lh: ${(e as Error).message}`); return 2; }
  console.log(`lh: Lighthouse ${lh.version}, ${targets.length} URLs × ${runs} runs, ${server.mode} server ${server.baseUrl}, ${cpus().length} cores, load ${loadavg()[0]?.toFixed(1)}`);

  const all: RunRecord[] = [];
  const summaries: TargetSummary[] = [];
  const t0 = Date.now();
  try {
    for (const target of targets) {
      const final: RunRecord[] = [];
      for (let i = 1; i <= runs; i++) {
        const common = { bin: lh.bin, target, baseUrl: server.baseUrl, attempt: i, dir: runDir, chromePath, minBenchmark, maxLoad, quietWait };
        let r = await oneRun({ ...common, retry: false });
        all.push(r);
        if (r.contended) {
          console.log(`  ${target.id} run ${i}: contended (benchmarkIndex ${r.benchmarkIndex ?? '?'} vs min ${minBenchmark}, load ${r.loadavgBefore.toFixed(1)} vs max ${maxLoad}), retrying once`);
          r = await oneRun({ ...common, retry: true });
          all.push(r);
        }
        final.push(r);
        const m = r.metrics;
        console.log(`  ${target.id} run ${i}${r.retry ? ' (retry)' : ''}: ${r.error ? `ERROR ${r.error}` : `perf ${pct(m?.score ?? 0)} a11y ${pct(m?.a11y ?? 0)} LCP ${Math.round(m?.lcp ?? 0)} SI ${Math.round(m?.si ?? 0)} TBT ${Math.round(m?.tbt ?? 0)}`} bench ${r.benchmarkIndex ?? '?'} load ${r.loadavgBefore.toFixed(1)}`);
      }
      summaries.push(summarize(target, final, runs, all.filter((r) => r.target === target.id)));
    }
  } finally {
    await server.stop();
  }

  const ok = errors.length === 0 && summaries.every((s) => s.ok);
  const inconclusive = errors.length === 0 && !summaries.some((s) => s.verdict === 'fail') && summaries.some((s) => s.verdict === 'inconclusive');
  const report = {
    tool: 'hb-lh', generatedAt: new Date().toISOString(), ok, inconclusive, lighthouseVersion: lh.version, runsPerUrl: runs, minBenchmark, maxLoad,
    server: { mode: server.mode, baseUrl: server.baseUrl }, dist, durationS: Math.round((Date.now() - t0) / 1000),
    machine: { cores: cpus().length, loadavgEnd: loadavg() }, errors, skipped, targets: summaries, runs: all,
  };
  const table = formatTable(report);
  writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(out, 'summary.txt'), `${table}\n`);
  console.log(`\n${table}\n\nreport: ${path.join(out, 'summary.json')}`);
  return ok ? 0 : inconclusive ? 3 : 1;
}

export function formatTable(r: { ok: boolean; inconclusive: boolean; errors: string[]; targets: TargetSummary[]; runsPerUrl: number; durationS: number; server: { mode: string } }): string {
  const head = ['template', 'url', 'perf', 'a11y', 'LCP', 'FCP', 'SI', 'TBT', 'CLS', 'bench', 'load', 'ok'];
  const rows = r.targets.map((t) => [
    t.id, t.url, String(t.medianRun?.score ?? '-'), String(t.medians ? pct(t.medians.a11y) : '-'),
    ...(t.medians ? [t.medians.lcp, t.medians.fcp, t.medians.si, t.medians.tbt].map((x) => String(Math.round(x))) : ['-', '-', '-', '-']),
    t.medians ? t.medians.cls.toFixed(3) : '-',
    String(Math.round(Math.min(...t.benchmarkIndex.map((b) => b ?? Infinity)))), Math.max(...t.loadavg).toFixed(1),
    t.verdict === 'pass' ? 'ok' : t.verdict === 'fail' ? 'FAIL' : 'INCONCL',
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((x) => (x[i] ?? '').length)));
  const fmt = (x: string[]): string => x.map((c, i) => (i < 2 ? c.padEnd(w[i] ?? 0) : c.padStart(w[i] ?? 0))).join('  ');
  const lines = [`medians of ${r.runsPerUrl} runs (perf = median run by score; ms; bench = lowest benchmarkIndex; load = highest 1-min load at run start), ${r.server.mode} server, ${r.durationS} s`,
    fmt(head), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map(fmt)];
  const fails = r.targets.flatMap((t) => t.failures.map((f) => `  ${t.id} ${t.url}: ${f}`));
  const notes = r.targets.flatMap((t) => t.notes.map((n) => `  ${t.id}: ${n}`));
  if (r.errors.length) lines.push('', 'ERRORS', ...r.errors.map((e) => `  ${e}`));
  if (fails.length) lines.push('', 'FAILURES', ...fails);
  if (notes.length) lines.push('', 'notes', ...notes);
  const n = (v: TargetSummary['verdict']): number => r.targets.filter((t) => t.verdict === v).length;
  lines.push('', r.ok ? `LIGHTHOUSE OK: ${r.targets.length} URLs`
    : r.inconclusive ? `LIGHTHOUSE INCONCLUSIVE: ${n('inconclusive')} of ${r.targets.length} URLs failed only on a contended machine; rerun when the load is ≤ the max`
    : `LIGHTHOUSE FAILED: ${n('fail')} of ${r.targets.length} URLs failed${n('inconclusive') ? `, ${n('inconclusive')} inconclusive` : ''}${r.errors.length ? `, ${r.errors.length} errors` : ''}`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(REPO_ROOT);
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e: unknown) => { console.error(e); process.exitCode = 2; });
}
