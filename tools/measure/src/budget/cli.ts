#!/usr/bin/env node
/**
 * npm run budget [-- --dist <dir>] [--out <dir>] [--own-origin https://example.dz]… [--quiet]
 * Exit 0 = every rule green; 1 = at least one violation; 2 = usage or internal error.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkSite, mergeRuntime, RULES, type SiteReport } from './check.ts';
import { runtimeChecks, type RuntimeResult } from './runtime.ts';
import { DEFAULT_DIST, artifactsRoot } from '../lib/paths.ts';

const USAGE = `usage: npm run budget -- [--dist <dir>] [--out <dir>] [--own-origin <origin>]… [--quiet] [--static-only]
  --dist        built storefront (default apps/storefront/dist)
  --out         report directory (default <main checkout>/artifacts/budget)
  --own-origin  origin treated as first-party in absolute URLs (repeatable), e.g. the production domain
  --quiet       print only violations and the verdict
  --static-only skip the Chrome runtime pass (fonts on /fr/, third-party requests); NOT valid for the gate`;

export async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        'dist': { type: 'string' },
        'out': { type: 'string' },
        'own-origin': { type: 'string', multiple: true },
        'quiet': { type: 'boolean' }, 'static-only': { type: 'boolean' },
        'help': { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (args.help) { console.log(USAGE); return 0; }
  const dist = path.resolve(args.dist ?? DEFAULT_DIST);
  const out = path.resolve(args.out ?? path.join(artifactsRoot(), 'budget'));
  let report: SiteReport;
  let runtime: { ran: boolean; results: RuntimeResult[] } = { ran: false, results: [] };
  try {
    report = checkSite(dist, { ownOrigins: args['own-origin'] ?? [] });
    const pages = report.pages.filter((p) => p.lang === 'ar' || p.lang === 'fr').map((p) => ({ url: p.url, lang: p.lang }));
    if (!args['static-only'] && pages.length) {
      const rt = await runtimeChecks(dist, pages);
      report = mergeRuntime(report, rt.violations);
      runtime = { ran: true, results: rt.results };
    }
  } catch (e) {
    console.error(`budget: internal error: ${(e as Error).stack ?? String(e)}`);
    return 2;
  }
  const table = formatTable(report, !!args.quiet) + (runtime.ran ? '' : '\n(runtime pass skipped: --static-only; not valid for the gate)');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'budget.json'), `${JSON.stringify({ ...report, runtime }, null, 2)}\n`);
  writeFileSync(path.join(out, 'budget.txt'), `${table}\n`);
  console.log(table);
  console.log(`\nreport: ${path.join(out, 'budget.json')}`);
  return report.ok ? 0 : 1;
}

export function formatTable(r: SiteReport, quiet: boolean): string {
  const lines: string[] = [];
  const kb = (n: number): string => (n / 1024).toFixed(1);
  if (!quiet) {
    lines.push(`dist: ${r.dist}`);
    const head = ['page', 'lang', 'html br KiB', 'target', 'js br KiB', 'crit KiB/req', 'viol'];
    const rows = r.pages.map((p) => [
      p.url, p.lang, kb(p.metrics.htmlBrGate), p.metrics.htmlTarget, kb(p.metrics.js.totalBr),
      `${kb(p.metrics.critical.bytes)}/${p.metrics.critical.count}`, String(p.violations.length),
    ]);
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)));
    const fmt = (row: string[]): string => row.map((c, i) => (i === 0 ? c.padEnd(w[i] ?? 0) : c.padStart(w[i] ?? 0))).join('  ');
    lines.push(fmt(head), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map(fmt));
    const b = r.budgets;
    lines.push(`budgets: html ≤ ${b.htmlBrMax} B br (target ${b.htmlBrTarget[0]}–${b.htmlBrTarget[1]} B), js ≤ ${b.jsBrMax} B br, `
      + `critical ≤ ${b.criticalBytesMax} B in ≤ ${b.criticalRequestsMax} requests, AVIF ≤ ${b.avifMaxBytes} B at ≤ ${b.avifCheckMaxWidth} w; `
      + `text measured at brotli q${b.brotliQualities.join('/q')}, gate = larger`);
  }
  const all = [
    ...r.siteViolations.map((v) => ({ page: '(site)', ...v })),
    ...r.pages.flatMap((p) => p.violations.map((v) => ({ page: p.url, ...v }))),
  ];
  if (all.length) {
    lines.push('', 'VIOLATIONS');
    for (const v of all) lines.push(`  ${v.page}  [${v.rule}] ${v.message}`);
  }
  const warns = r.pages.flatMap((p) => p.warnings.map((w) => `  ${p.url}  ${w}`));
  if (warns.length && !quiet) lines.push('', 'warnings (not blocking)', ...warns);
  const byRule = Object.entries(r.summary.byRule).map(([k, n]) => `${k}: ${n}`).join(', ');
  lines.push('', r.ok
    ? `BUDGET OK: ${r.summary.pages} pages, ${Object.keys(RULES).length} rules`
    : `BUDGET FAILED: ${r.summary.violations} violations (${byRule})`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e: unknown) => { console.error(e); process.exitCode = 2; });
}
