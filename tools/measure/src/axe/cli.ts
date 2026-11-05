#!/usr/bin/env node
/**
 * npm run axe — accessibility gate (MEAS-3): axe-core with the WCAG 2.0/2.1/2.2 A and AA tags on
 * every template in /ar/ and /fr/ at 360 and 1440 px, plus a keyboard pass per template.
 *
 * Keyboard pass (per template × lang at 1440 and 360 px): press Tab until focus cycles (max 150
 * stops) and record each stop: element, accessible text, whether focus is VISIBLE (pixels of the
 * element's box ± 8 px differ between focused and blurred: WCAG 2.4.7) and whether it is
 * OBSCURED (the element at the box centre is not the focused element or inside it, e.g. under a
 * sticky header: WCAG 2.4.11). Invisible or obscured focus is a failure.
 *
 * Output (--out, default <main checkout>/artifacts/axe-run): axe.json, keyboard.json, axe.txt.
 * Exit 0 = zero axe violations and no keyboard failure; 1 = failures; 2 = setup error.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';
import { REPO_ROOT, artifactsRoot } from '../lib/paths.ts';
import { launch, loadStable, newContext } from '../lib/browser.ts';
import { TARGET_OPTIONS, TARGET_USAGE, resolveTargets, serverFor } from '../lib/targets.ts';

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
export const AXE_WIDTHS = [360, 1440];
export const AXE_PORT = 4116;
const MAX_STOPS = 150;

const USAGE = `usage: npm run axe -- [options]\n${TARGET_USAGE}\n  (default --out <main checkout>/artifacts/axe-run)`;

export interface AxeViolation { id: string; impact: string | null; help: string; helpUrl: string; nodes: Array<{ target: string; html: string; summary: string }> }
export interface KeyStop { i: number; el: string; text: string; visible: boolean; obscured: boolean; rect: { x: number; y: number; w: number; h: number } }
export interface KeyboardResult { id: string; url: string; width: number; stops: KeyStop[]; cycled: boolean; failures: string[] }

/** Describe the focused element (runs in the page). */
const DESCRIBE = `(() => {
  const e = document.activeElement;
  if (!e || e === document.body || e === document.documentElement) return null;
  const r = e.getBoundingClientRect();
  const name = (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('alt') || e.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
  const sel = e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.getAttribute('href') ? '[href="' + e.getAttribute('href') + '"]' : '') + (e.getAttribute('name') ? '[name="' + e.getAttribute('name') + '"]' : '');
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const top = document.elementFromPoint(Math.min(Math.max(cx, 0), innerWidth - 1), Math.min(Math.max(cy, 0), innerHeight - 1));
  const obscured = r.width > 0 && r.height > 0 && !!top && !(top === e || e.contains(top) || top.contains(e));
  const offscreen = r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
  return { sel, name, x: r.left, y: r.top, w: r.width, h: r.height, obscured: obscured && !offscreen };
})()`;

async function keyboardPass(page: Page, id: string, url: string, width: number): Promise<KeyboardResult> {
  const stops: KeyStop[] = [];
  const failures: string[] = [];
  const seen = new Set<string>();
  let cycled = false;
  await page.evaluate('window.scrollTo(0, 0); document.activeElement && document.activeElement.blur && document.activeElement.blur()');
  for (let i = 1; i <= MAX_STOPS; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(30);
    const d = await page.evaluate(DESCRIBE) as null | { sel: string; name: string; x: number; y: number; w: number; h: number; obscured: boolean };
    if (!d) { cycled = true; break; } // focus left the document content: one full cycle
    const key = `${d.sel}|${d.name}|${Math.round(d.x)}|${Math.round(d.y)}`;
    if (seen.has(key)) { cycled = true; break; }
    seen.add(key);
    // visible focus: compare the element's area (± 8 px for outlines) focused vs blurred
    const vp = page.viewportSize() ?? { width, height: 900 };
    const clip = { x: Math.max(0, d.x - 8), y: Math.max(0, d.y - 8), width: Math.min(d.w + 16, vp.width), height: Math.min(d.h + 16, vp.height) };
    let visible = true;
    if (clip.width > 0 && clip.height > 0 && d.y + d.h > 0 && d.y < vp.height) {
      const a = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
      await page.evaluate('window.__hbFocus = document.activeElement; document.activeElement.blur()');
      const b = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
      // restore focus with keyboard modality preserved (focus-visible) so the next Tab continues
      await page.evaluate('window.__hbFocus && window.__hbFocus.focus({ preventScroll: true })');
      visible = !a.equals(b);
    }
    const stop: KeyStop = { i, el: d.sel, text: d.name, visible, obscured: d.obscured, rect: { x: Math.round(d.x), y: Math.round(d.y), w: Math.round(d.w), h: Math.round(d.h) } };
    stops.push(stop);
    if (!visible) failures.push(`stop ${i} ${d.sel} "${d.name}": focus not visible (WCAG 2.4.7)`);
    if (d.obscured) failures.push(`stop ${i} ${d.sel} "${d.name}": focused element obscured (WCAG 2.4.11)`);
  }
  if (!cycled) failures.push(`no focus cycle within ${MAX_STOPS} stops (possible keyboard trap, WCAG 2.1.2)`);
  if (!stops.length) failures.push('no focusable element reached by Tab');
  return { id, url, width, stops, cycled, failures };
}

export async function main(argv: string[]): Promise<number> {
  let a;
  try { a = parseArgs({ args: argv, options: TARGET_OPTIONS }).values; } catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); return 2; }
  if (a.help) { console.log(USAGE); return 0; }
  const { dist, targets, skipped, errors } = resolveTargets(a);
  const out = path.resolve(a.out ?? path.join(artifactsRoot(), 'axe-run'));
  mkdirSync(out, { recursive: true });
  if (!targets.length) { console.error(`axe: ${errors.join('; ')}`); return 1; }
  let server;
  try { server = await serverFor(a, dist, AXE_PORT, path.join(out, 'server.log')); } catch (e) { console.error(`axe: ${(e as Error).message}`); return 2; }
  const axeResults: Array<{ id: string; url: string; width: number; violations: AxeViolation[]; incomplete: number; passes: number; error?: string }> = [];
  const keyboard: KeyboardResult[] = [];
  const browser = await launch();
  try {
    for (const t of targets) {
      for (const width of AXE_WIDTHS) {
        const ctx = await newContext(browser, width);
        const { page, status, error } = await loadStable(ctx, server.baseUrl + t.url);
        const err = error ?? (status !== t.expectStatus ? `HTTP ${status} (expected ${t.expectStatus})` : undefined);
        if (err) {
          axeResults.push({ id: t.id, url: t.url, width, violations: [], incomplete: 0, passes: 0, error: err });
          console.log(`  ${t.id} ${width}px ERROR ${err}`);
          await ctx.close();
          continue;
        }
        const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        const violations: AxeViolation[] = r.violations.map((v) => ({
          id: v.id, impact: v.impact ?? null, help: v.help, helpUrl: v.helpUrl,
          nodes: v.nodes.map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 200), summary: (n.failureSummary ?? '').slice(0, 300) })),
        }));
        axeResults.push({ id: t.id, url: t.url, width, violations, incomplete: r.incomplete.length, passes: r.passes.length });
        const kb = await keyboardPass(page, t.id, t.url, width);
        keyboard.push(kb);
        console.log(`  ${t.id} ${width}px axe ${violations.length} violation(s), keyboard ${kb.stops.length} stops ${kb.failures.length ? `${kb.failures.length} FAIL` : 'ok'}`);
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    await server.stop();
  }
  const pageErrors = axeResults.filter((r) => r.error);
  const axeFails = axeResults.filter((r) => r.violations.length);
  const kbFails = keyboard.filter((k) => k.failures.length);
  const ok = errors.length === 0 && !pageErrors.length && !axeFails.length && !kbFails.length;
  const meta = { generatedAt: new Date().toISOString(), dist, server: server.mode, tags: AXE_TAGS, widths: AXE_WIDTHS, errors, skipped };
  writeFileSync(path.join(out, 'axe.json'), `${JSON.stringify({ tool: 'hb-axe', ok, ...meta, results: axeResults }, null, 2)}\n`);
  writeFileSync(path.join(out, 'keyboard.json'), `${JSON.stringify({ tool: 'hb-keyboard', ok: !kbFails.length, ...meta, results: keyboard }, null, 2)}\n`);
  const lines = [
    ...errors.map((e) => `ERROR ${e}`),
    ...pageErrors.map((r) => `${r.id} ${r.width}px: page error ${r.error}`),
    ...axeFails.flatMap((r) => r.violations.map((v) => `${r.id} ${r.url} ${r.width}px: [${v.id}] (${v.impact}) ${v.help}: ${v.nodes.map((n) => n.target).slice(0, 5).join(', ')}`)),
    ...kbFails.flatMap((k) => k.failures.map((f) => `${k.id} ${k.url} ${k.width}px keyboard: ${f}`)),
  ];
  const verdict = ok
    ? `AXE OK: ${targets.length} URLs × ${AXE_WIDTHS.length} widths, 0 violations, keyboard ok`
    : `AXE FAILED: ${axeFails.reduce((n, r) => n + r.violations.length, 0)} axe violations, ${kbFails.length} keyboard failures, ${pageErrors.length + errors.length} errors`;
  writeFileSync(path.join(out, 'axe.txt'), `${[...lines, '', verdict].join('\n')}\n`);
  console.log(`\n${[...lines, verdict].join('\n')}\nreports: ${path.join(out, 'axe.json')}, ${path.join(out, 'keyboard.json')}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(REPO_ROOT);
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e: unknown) => { console.error(e); process.exitCode = 2; });
}
