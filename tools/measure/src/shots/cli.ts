#!/usr/bin/env node
/**
 * npm run shots — screenshots of every template × ar/fr × 360/768/1440 px (MEAS-3).
 * <out>/shots/<template>/<lang>-<width>.png (viewport) and <lang>-<width>-full.png (full page),
 * an index.html contact sheet and shots.json. Exit 0 = every page loaded with the expected status;
 * 1 = a page failed or the registry has errors; 2 = setup error.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO_ROOT, artifactsRoot } from '../lib/paths.ts';
import { WIDTHS, launch, loadStable, newContext } from '../lib/browser.ts';
import { TARGET_OPTIONS, TARGET_USAGE, resolveTargets, serverFor } from '../lib/targets.ts';

const USAGE = `usage: npm run shots -- [options]\n${TARGET_USAGE}\n  (default --out <main checkout>/artifacts/shots-run; files under <out>/shots/)`;
export const SHOTS_PORT = 4114;

interface Shot { template: string; kind?: string; id: string; lang: string; url: string; width: number; file: string; full: string; status: number; error?: string }

export async function main(argv: string[]): Promise<number> {
  let a;
  try { a = parseArgs({ args: argv, options: TARGET_OPTIONS }).values; } catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); return 2; }
  if (a.help) { console.log(USAGE); return 0; }
  const { dist, targets, skipped, errors } = resolveTargets(a);
  const out = path.resolve(a.out ?? path.join(artifactsRoot(), 'shots-run'));
  const dir = path.join(out, 'shots');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (!targets.length) { console.error(`shots: ${errors.join('; ')}`); return 1; }
  let server;
  try { server = await serverFor(a, dist, SHOTS_PORT, path.join(out, 'server.log')); } catch (e) { console.error(`shots: ${(e as Error).message}`); return 2; }
  const shots: Shot[] = [];
  const browser = await launch();
  try {
    for (const t of targets) {
      for (const width of WIDTHS) {
        const ctx = await newContext(browser, width);
        const { page, status, error } = await loadStable(ctx, server.baseUrl + t.url);
        // content pages share a template: keep each one's own file name
        // and variants (data-tpl-kind) too: product/ar-variable-360.png
        const stem = t.template === 'content' ? `${t.lang}-${t.id.replace(/^content-(ar|fr)-/, '')}` : t.kind ? `${t.lang}-${t.kind}` : t.lang;
        const rel = path.join(t.template, `${stem}-${width}.png`);
        const relFull = path.join(t.template, `${stem}-${width}-full.png`);
        const s: Shot = { template: t.template, ...(t.kind ? { kind: t.kind } : {}), id: t.id, lang: t.lang, url: t.url, width, file: rel, full: relFull, status, ...(error ? { error } : {}) };
        if (!error && status !== t.expectStatus) s.error = `HTTP ${status} (expected ${t.expectStatus})`;
        if (!error) {
          mkdirSync(path.join(dir, t.template), { recursive: true });
          await page.screenshot({ path: path.join(dir, rel), animations: 'disabled', caret: 'hide' });
          await page.screenshot({ path: path.join(dir, relFull), fullPage: true, animations: 'disabled', caret: 'hide' });
        }
        shots.push(s);
        console.log(`  ${t.id} ${width}px ${s.error ? `ERROR ${s.error}` : 'ok'}`);
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    await server.stop();
  }
  const failed = shots.filter((s) => s.error);
  const ok = errors.length === 0 && failed.length === 0;
  writeFileSync(path.join(dir, 'index.html'), contactSheet(shots, server.baseUrl));
  writeFileSync(path.join(out, 'shots.json'), `${JSON.stringify({ tool: 'hb-shots', generatedAt: new Date().toISOString(), ok, dist, server: server.mode, errors, skipped, shots }, null, 2)}\n`);
  for (const e of errors) console.log(`ERROR ${e}`);
  console.log(`\n${ok ? 'SHOTS OK' : 'SHOTS FAILED'}: ${shots.length - failed.length}/${shots.length} captures; contact sheet ${path.join(dir, 'index.html')}`);
  return ok ? 0 : 1;
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** A plain contact sheet: one row per template page, one column per language × width. */
export function contactSheet(shots: Shot[], base: string): string {
  const rows = new Map<string, Shot[]>();
  for (const s of shots) {
    const key = s.template === 'content' ? s.id.replace(/-(ar|fr)-/, '-') : s.kind ? `${s.template}-${s.kind}` : s.template;
    rows.set(key, [...(rows.get(key) ?? []), s]);
  }
  const cell = (s: Shot | undefined): string => !s ? '<td></td>' : s.error
    ? `<td class="err">${esc(s.lang)} ${s.width}px<br>${esc(s.error)}</td>`
    : `<td><a href="${esc(s.full)}"><img src="${esc(s.file)}" alt="${esc(`${s.id} ${s.width}px`)}" loading="lazy"></a><br>${esc(s.lang)} ${s.width}px · <a href="${esc(s.full)}">full</a></td>`;
  const body = [...rows].map(([k, list]) => `<tr><th>${esc(k)}<br><small>${esc([...new Set(list.map((s) => s.url))].join(' '))}</small></th>${
    ['ar', 'fr'].flatMap((l) => WIDTHS.map((w) => cell(list.find((s) => s.lang === l && s.width === w)))).join('')}</tr>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>HB storefront screenshots</title>
<style>body{font:14px system-ui,sans-serif;margin:16px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px;vertical-align:top;text-align:start}img{max-width:220px;max-height:420px;display:block}.err{background:#fee;color:#900}</style></head>
<body><h1>Screenshots</h1><p>${esc(base)} · ${new Date().toISOString()} · deterministic: reduced motion, animations off, fonts settled (reload so <code>font-display: optional</code> uses the cached font)</p>
<table><tr><th>template</th>${['ar', 'fr'].flatMap((l) => WIDTHS.map((w) => `<th>${l} ${w}px</th>`)).join('')}</tr>
${body}</table></body></html>
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(REPO_ROOT);
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e: unknown) => { console.error(e); process.exitCode = 2; });
}
