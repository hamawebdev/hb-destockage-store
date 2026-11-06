#!/usr/bin/env node
/**
 * npm run axe — accessibility gate (MEAS-3): axe-core with every default rule (WCAG 2.0/2.1/2.2 A
 * and AA plus best-practice; exceptions only via DECISIONS.md, see AXE_DISABLED_RULES) on every
 * template in /ar/ and /fr/ at 360, 768 and 1440 px, plus a keyboard pass per template.
 *
 * Colour contrast axe cannot compute (`incomplete`: text over images, gradients, overlaps) is
 * measured from pixels (`measureContrast`) and gated like a violation.
 *
 * Keyboard pass (per template × lang × width): Tab until focus leaves the page, recording each
 * stop: element, accessible text, whether focus is VISIBLE (pixels of the element's box ± 8 px
 * differ between focused and blurred: WCAG 2.4.7) and whether it is OBSCURED (the element at the
 * box centre is not the focused element or inside it, e.g. under a sticky header: WCAG 2.4.11).
 * Then the same walk with Shift+Tab. In both directions, focus that returns to an earlier stop (or
 * does not move) before every tabbable element was visited is a keyboard TRAP (WCAG 2.1.2), and a
 * tabbable element never reached is a failure (WCAG 2.1.1). See `walk`.
 *
 * Output (--out, default <main checkout>/artifacts/axe-run): axe.json, keyboard.json, axe.txt.
 * Exit 0 = zero axe violations and no keyboard failure; 1 = failures; 2 = setup error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';
import { REPO_ROOT, artifactsRoot } from '../lib/paths.ts';
import { launch, loadStable, newContext } from '../lib/browser.ts';
import { TARGET_OPTIONS, TARGET_USAGE, resolveTargets, serverFor } from '../lib/targets.ts';

/**
 * Every rule axe-core runs by default: the WCAG 2.0/2.1/2.2 A/AA rules AND best-practice
 * (landmark-unique, region, heading-order, …). Lead ruling 2026-11-06: "zero axe violations"
 * covers all of them. An exception is a rule id listed here AND named, with its reason, in the
 * DECISIONS.md entry given; otherwise the run refuses to start (exit 2). See `checkExceptions`.
 */
export const AXE_DISABLED_RULES: ReadonlyArray<{ id: string; decision: string }> = [];

/** Errors for exceptions not backed by DECISIONS.md (`## D-NNN — …` section naming the rule id in backticks). */
export function checkExceptions(rules: ReadonlyArray<{ id: string; decision: string }>, decisions: string): string[] {
  const errors: string[] = [];
  for (const r of rules) {
    const start = decisions.search(new RegExp(`^## ${r.decision}\\b`, 'm'));
    const rest = start < 0 ? '' : decisions.slice(start + 3);
    const section = start < 0 ? '' : rest.slice(0, rest.search(/^## /m) < 0 ? undefined : rest.search(/^## /m));
    if (!section) errors.push(`axe rule "${r.id}" is disabled citing ${r.decision}, which is not in DECISIONS.md`);
    else if (!section.includes(`\`${r.id}\``)) errors.push(`axe rule "${r.id}" is disabled citing ${r.decision}, which does not name \`${r.id}\``);
  }
  return errors;
}
export const AXE_WIDTHS = [360, 768, 1440];
export const AXE_PORT = 4116;
const MAX_STOPS = 150;

const USAGE = `usage: npm run axe -- [options]\n${TARGET_USAGE}\n  (default --out <main checkout>/artifacts/axe-run)`;

export interface AxeViolation { id: string; impact: string | null; help: string; helpUrl: string; nodes: Array<{ target: string; html: string; summary: string }> }
export interface KeyStop { i: number; el: string; text: string; visible: boolean; obscured: boolean; rect: { x: number; y: number; w: number; h: number } }
export interface KeyboardResult {
  id: string; url: string; width: number; stops: KeyStop[];
  /** both directions completed a full cycle (focus left the page, or wrapped after every tabbable element) */
  cycled: boolean; forward: WalkResult['end']; backward: WalkResult['end'];
  /** Shift+Tab focus order */
  backwardOrder: string[]; failures: string[];
}

/**
 * In-page helpers for the keyboard pass. Each focused element gets a stable "unit" id (a radio
 * group is one unit: Tab stops once per group). `tabbable()` lists the units a keyboard user must
 * be able to reach with Tab right now: focusable, tabIndex ≥ 0, enabled, not inert, rendered
 * (not display:none / visibility:hidden / inside a closed <details>), and, while a modal <dialog>
 * is open, only its content.
 */
const KB_HELPERS = `window.__hbKb = window.__hbKb || (() => {
  const ids = new WeakMap(); let n = 0; const forms = new WeakMap(); let nf = 0;
  const idOf = (e) => { if (!ids.has(e)) ids.set(e, ++n); return ids.get(e); };
  const formOf = (e) => { const f = e.form || document; if (!forms.has(f)) forms.set(f, ++nf); return forms.get(f); };
  const unit = (e) => e.tagName === 'INPUT' && e.type === 'radio' && e.name ? 'radio:' + formOf(e) + ':' + e.name : 'el:' + idOf(e);
  const sel = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.getAttribute('href') ? '[href="' + e.getAttribute('href') + '"]' : '') + (e.getAttribute('name') ? '[name="' + e.getAttribute('name') + '"]' : '');
  const FOCUSABLE = 'a[href],area[href],button,input:not([type=hidden]),select,textarea,iframe,summary,audio[controls],video[controls],[contenteditable]:not([contenteditable=false]),[tabindex]';
  const tabbable = () => {
    const root = document.querySelector('dialog:modal') || document;
    const out = new Map();
    for (const e of root.querySelectorAll(FOCUSABLE)) {
      if (e.tabIndex < 0 || e.matches(':disabled') || e.closest('[inert]')) continue;
      if (e.tagName === 'SUMMARY' && !(e.parentElement && e.parentElement.tagName === 'DETAILS' && e.parentElement.querySelector(':scope > summary') === e)) continue;
      if (!e.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) continue;
      const u = unit(e); if (!out.has(u)) out.set(u, sel(e));
    }
    return [...out].map(([u, s]) => ({ unit: u, sel: s }));
  };
  const active = () => {
    let e = document.activeElement;
    while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
    return e && e !== document.body && e !== document.documentElement ? e : null;
  };
  const describe = () => {
    const e = active(); if (!e || e.hasAttribute('data-hb-start')) return null;
    const r = e.getBoundingClientRect();
    const name = (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('alt') || e.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const top = document.elementFromPoint(Math.min(Math.max(cx, 0), innerWidth - 1), Math.min(Math.max(cy, 0), innerHeight - 1));
    const obscured = r.width > 0 && r.height > 0 && !!top && !(top === e || e.contains(top) || top.contains(e));
    const offscreen = r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
    // focus inside a nested context (iframe, media controls) stays on the same element for several Tabs
    const nested = /^(IFRAME|OBJECT|EMBED|AUDIO|VIDEO)$/.test(e.tagName);
    return { unit: unit(e), sel: sel(e), name, nested, x: r.left, y: r.top, w: r.width, h: r.height, obscured: obscured && !offscreen };
  };
  return { tabbable, describe };
})()`;

interface Described { unit: string; sel: string; name: string; nested: boolean; x: number; y: number; w: number; h: number; obscured: boolean }
type Tabbable = Array<{ unit: string; sel: string }>;

/** Consecutive Tabs allowed inside one nested context (an iframe, a <video>'s controls) before it counts as a trap. */
const MAX_NESTED = 30;

export interface WalkResult {
  /** how the walk ended: focus left the document; wrapped to stop 1 after every tabbable unit; trapped; ran out of stops; nothing focusable */
  end: 'left' | 'wrapped' | 'trap' | 'limit' | 'none';
  stops: Described[];
  failures: string[];
}

/**
 * Press `key` until focus leaves the document. A full cycle is focus leaving the document, or
 * wrapping back to the first stop once every tabbable unit has been visited. Any other repeat
 * (focus returns to a stop, or does not move) is a keyboard trap (WCAG 2.1.2), whatever causes it:
 * a keydown handler, a focusout handler that pulls focus back, or a focus loop in a widget.
 * After a full cycle, a tabbable unit that was never reached fails WCAG 2.1.1.
 * `onStop` runs the per-stop checks (forward pass only).
 */
async function walk(page: Page, key: 'Tab' | 'Shift+Tab', onStop?: (d: Described, i: number) => Promise<void>): Promise<WalkResult> {
  const dir = key === 'Tab' ? 'Tab' : 'Shift+Tab';
  // Start from a fixed point (blur() alone keeps Chrome's sequential-navigation starting point
  // where the last focus was): a temporary unfocusable-by-Tab marker at the start (Tab) or end
  // (Shift+Tab) of <body>, focused, then removed after the first press.
  await page.evaluate(`${KB_HELPERS}; window.scrollTo(0, 0);
    document.querySelectorAll('[data-hb-start]').forEach((e) => e.remove());
    { const s = document.createElement('span'); s.tabIndex = -1; s.setAttribute('data-hb-start', '');
      document.body.${key === 'Tab' ? 'prepend' : 'append'}(s); s.focus({ preventScroll: true }); }`);
  const initial = await page.evaluate('window.__hbKb.tabbable()') as Tabbable;
  const limit = Math.max(MAX_STOPS, 2 * initial.length + 20);
  const stops: Described[] = [];
  const failures: string[] = [];
  const firstAt = new Map<string, number>(); // unit → index in stops
  let nestedRun = 0;
  let end: WalkResult['end'] = 'limit';
  const missing = async (): Promise<Tabbable> => {
    const now = await page.evaluate('window.__hbKb.tabbable()') as Tabbable;
    return now.filter((t) => !firstAt.has(t.unit));
  };
  const list = (xs: Array<{ sel: string }>, n = 6): string => xs.slice(0, n).map((x) => x.sel).join(', ') + (xs.length > n ? ` … (+${xs.length - n})` : '');
  for (let press = 1; press <= limit; press++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(30);
    if (press === 1) await page.evaluate(`document.querySelectorAll('[data-hb-start]').forEach((e) => e.remove())`);
    const d = await page.evaluate('window.__hbKb.describe()') as Described | null;
    if (!d) { end = stops.length ? 'left' : 'none'; break; }
    const prev = stops[stops.length - 1];
    if (prev && prev.unit === d.unit && d.nested) {
      if (++nestedRun > MAX_NESTED) { end = 'trap'; failures.push(`${dir}: focus stays inside ${d.sel} for more than ${MAX_NESTED} presses (keyboard trap, WCAG 2.1.2)`); break; }
      continue;
    }
    nestedRun = 0;
    const at = firstAt.get(d.unit);
    if (at !== undefined) {
      const notReached = await missing();
      if (at === 0 && !notReached.length) { end = 'wrapped'; break; }
      end = 'trap';
      const loop = stops.slice(at);
      failures.push(`${dir}: focus cycles among ${loop.length} element(s) [${list(loop)}]` +
        (notReached.length ? ` and never reaches ${notReached.length} other tabbable element(s) [${list(notReached)}]` : '') + ' (keyboard trap, WCAG 2.1.2)');
      break;
    }
    firstAt.set(d.unit, stops.length);
    stops.push(d);
    if (onStop) await onStop(d, stops.length);
  }
  if (end === 'limit') failures.push(`${dir}: focus neither left the page nor cycled within ${limit} presses (keyboard trap, WCAG 2.1.2)`);
  if (end === 'none') failures.push(`${dir}: no focusable element reached`);
  if (end === 'left' || end === 'wrapped') {
    const notReached = await missing();
    if (notReached.length) failures.push(`${dir}: ${notReached.length} tabbable element(s) never reached [${list(notReached)}] (WCAG 2.1.1)`);
  }
  return { end, stops, failures };
}

async function keyboardPass(page: Page, id: string, url: string, width: number): Promise<KeyboardResult> {
  const stops: KeyStop[] = [];
  const failures: string[] = [];
  const vp = page.viewportSize() ?? { width, height: 900 };
  const fwd = await walk(page, 'Tab', async (d, i) => {
    // visible focus: compare the element's area (± 8 px for outlines) focused vs blurred
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
    stops.push({ i, el: d.sel, text: d.name, visible, obscured: d.obscured, rect: { x: Math.round(d.x), y: Math.round(d.y), w: Math.round(d.w), h: Math.round(d.h) } });
    if (!visible) failures.push(`stop ${i} ${d.sel} "${d.name}": focus not visible (WCAG 2.4.7)`);
    if (d.obscured) failures.push(`stop ${i} ${d.sel} "${d.name}": focused element obscured (WCAG 2.4.11)`);
  });
  const back = await walk(page, 'Shift+Tab');
  failures.push(...fwd.failures, ...back.failures);
  const full = (e: WalkResult['end']): boolean => e === 'left' || e === 'wrapped';
  return {
    id, url, width, stops, cycled: full(fwd.end) && full(back.end), forward: fwd.end, backward: back.end,
    backwardOrder: back.stops.map((s) => s.sel), failures,
  };
}

/**
 * axe reports colour contrast it cannot compute (text over an image or gradient, overlapping
 * elements, pseudo-element backgrounds) as `incomplete`. Measure those from pixels instead.
 * Three shots of the element's box: text forced to pure black, forced to pure white (both with
 * no text-shadow), and text transparent. The GLYPH MASK is every pixel where the black and white
 * shots differ by at least half (glyph coverage ≥ 50 %): it finds the glyphs whatever their real
 * colour and whatever the background, including text drawn in the background's own colour
 * (rev-a r2: diffing text-on vs text-off misses those). The transparent shot is the background
 * behind each glyph. Per mask pixel, contrast = the element's computed text colour
 * (alpha-composited over that background) vs that background. The worst CC_PERCENTILE of mask
 * pixels must reach 4.5:1 (3:1 for large text: ≥ 24 px, or ≥ 18.66 px and bold). Fewer than
 * CC_MIN_PIXELS mask pixels is CHECK BY HAND, never a pass.
 */
export interface ContrastCheck { target: string; reason: string; ok: boolean | null; ratio?: number; min?: number; median?: number; required?: number; pixels?: number; note?: string }

/** Share of glyph pixels allowed below the threshold: 2 % (a 7 % invisible tail must fail). */
export const CC_PERCENTILE = 0.02;
/** Smallest glyph mask that is measured; below it the item is listed for a manual check. */
export const CC_MIN_PIXELS = 30;

const CC_STYLE = '[data-hb-cc="k"]{color:#000!important;-webkit-text-fill-color:#000!important;text-shadow:none!important}'
  + '[data-hb-cc="w"]{color:#fff!important;-webkit-text-fill-color:#fff!important;text-shadow:none!important}'
  + '[data-hb-cc="t"]{color:transparent!important;-webkit-text-fill-color:transparent!important}';
const CC_ANALYSE = `async ([k, w, t, color, q, minPx]) => {
  const load = async (b64) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    return x.getImageData(0, 0, bmp.width, bmp.height).data;
  };
  const K = await load(k), W = await load(w), T = await load(t);
  const m = color.match(/[\\d.]+/g).map(Number); const [fr, fg, fb] = m; const fa = m.length > 3 ? m[3] : 1;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratios = [];
  for (let i = 0; i < K.length; i += 4) {
    if (Math.abs(W[i] - K[i]) + Math.abs(W[i + 1] - K[i + 1]) + Math.abs(W[i + 2] - K[i + 2]) < 383) continue; // glyph coverage < 50 %
    const br = T[i], bg = T[i + 1], bb = T[i + 2];
    const l1 = L(fa * fr + (1 - fa) * br, fa * fg + (1 - fa) * bg, fa * fb + (1 - fa) * bb), l2 = L(br, bg, bb);
    ratios.push((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
  }
  if (ratios.length < minPx) return { pixels: ratios.length };
  ratios.sort((p, r) => p - r);
  return { pixels: ratios.length, min: ratios[0], low: ratios[Math.floor(ratios.length * q)], median: ratios[Math.floor(ratios.length / 2)] };
}`;

async function measureContrast(page: Page, targets: string[][], reasons: string[]): Promise<ContrastCheck[]> {
  const out: ContrastCheck[] = [];
  await page.addStyleTag({ content: CC_STYLE });
  for (const [k, t] of targets.entries()) {
    const target = t.join(' >>> ');
    const reason = reasons[k] ?? '';
    if (t.length !== 1) { out.push({ target, reason, ok: null, note: 'inside an iframe or shadow root: check by hand' }); continue; }
    try {
      const loc = page.locator(t[0]!).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
      const box = await loc.boundingBox();
      const vp = page.viewportSize()!;
      const x = Math.max(0, Math.floor(box?.x ?? 0)), y = Math.max(0, Math.floor(box?.y ?? 0));
      const clip = box && { x, y, width: Math.min(Math.ceil(box.x + box.width), vp.width) - x, height: Math.min(Math.ceil(box.y + box.height), vp.height) - y };
      if (!clip || clip.width <= 0 || clip.height <= 0) { out.push({ target, reason, ok: null, note: 'element has no visible box' }); continue; }
      const style = await loc.evaluate((e) => { const s = (globalThis as unknown as { getComputedStyle: (x: unknown) => { color: string; fontSize: string; fontWeight: string } }).getComputedStyle(e); return { color: s.color, size: parseFloat(s.fontSize), weight: Number(s.fontWeight) || 400 }; });
      const shot = async (mode: 'k' | 'w' | 't'): Promise<string> => {
        await loc.evaluate((e, v) => e.setAttribute('data-hb-cc', v), mode);
        return (await page.screenshot({ clip, animations: 'disabled', caret: 'hide' })).toString('base64');
      };
      const shots = [await shot('k'), await shot('w'), await shot('t')];
      await loc.evaluate((e) => e.removeAttribute('data-hb-cc'));
      // a string pageFunction is evaluated as an expression (Playwright passes no arg to it): build the call
      const m = await page.evaluate(`(${CC_ANALYSE})(${JSON.stringify([...shots, style.color, CC_PERCENTILE, CC_MIN_PIXELS])})`) as undefined | { pixels: number; min?: number; low?: number; median?: number };
      if (!m || m.low === undefined) { out.push({ target, reason, ok: null, note: `glyph mask too small to measure (${m?.pixels ?? 0} px < ${CC_MIN_PIXELS})` }); continue; }
      const required = style.size >= 24 || (style.size >= 18.66 && style.weight >= 700) ? 3 : 4.5;
      const r2 = (v: number): number => Math.round(v * 100) / 100;
      out.push({ target, reason, ok: m.low >= required, ratio: r2(m.low), min: r2(m.min!), median: r2(m.median!), required, pixels: m.pixels });
    } catch (e) {
      out.push({ target, reason, ok: null, note: `could not measure: ${(e as Error).message.split('\n')[0]}` });
    }
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  let a;
  try { a = parseArgs({ args: argv, options: TARGET_OPTIONS }).values; } catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); return 2; }
  if (a.help) { console.log(USAGE); return 0; }
  const decisionsFile = path.join(REPO_ROOT, 'DECISIONS.md');
  const exceptionErrors = checkExceptions(AXE_DISABLED_RULES, existsSync(decisionsFile) ? readFileSync(decisionsFile, 'utf8') : '');
  if (exceptionErrors.length) { console.error(`axe: ${exceptionErrors.join('; ')}`); return 2; }
  const { dist, targets, skipped, errors } = resolveTargets(a);
  const out = path.resolve(a.out ?? path.join(artifactsRoot(), 'axe-run'));
  mkdirSync(out, { recursive: true });
  if (!targets.length) { console.error(`axe: ${errors.join('; ')}`); return 1; }
  let server;
  try { server = await serverFor(a, dist, AXE_PORT, path.join(out, 'server.log')); } catch (e) { console.error(`axe: ${(e as Error).message}`); return 2; }
  const axeResults: Array<{ id: string; url: string; width: number; violations: AxeViolation[]; incomplete: number; passes: number; contrast?: ContrastCheck[]; error?: string }> = [];
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
        const builder = new AxeBuilder({ page });
        if (AXE_DISABLED_RULES.length) builder.disableRules(AXE_DISABLED_RULES.map((x) => x.id));
        const r = await builder.analyze();
        const violations: AxeViolation[] = r.violations.map((v) => ({
          id: v.id, impact: v.impact ?? null, help: v.help, helpUrl: v.helpUrl,
          nodes: v.nodes.map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 200), summary: (n.failureSummary ?? '').slice(0, 300) })),
        }));
        const cc = r.incomplete.filter((v) => v.id === 'color-contrast').flatMap((v) => v.nodes);
        const contrast = await measureContrast(page, cc.map((n) => n.target.map(String)), cc.map((n) => (n.any[0]?.message ?? '').slice(0, 200)));
        axeResults.push({ id: t.id, url: t.url, width, violations, incomplete: r.incomplete.length, passes: r.passes.length, contrast });
        const kb = await keyboardPass(page, t.id, t.url, width);
        keyboard.push(kb);
        const ccBad = contrast.filter((c) => c.ok === false).length;
        console.log(`  ${t.id} ${width}px axe ${violations.length} violation(s)${contrast.length ? `, ${contrast.length} contrast measured (${ccBad} FAIL)` : ''}, keyboard ${kb.stops.length} stops ${kb.failures.length ? `${kb.failures.length} FAIL` : 'ok'}`);
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
  const ccAll = axeResults.flatMap((r) => (r.contrast ?? []).map((c) => ({ r, c })));
  const ccFails = ccAll.filter(({ c }) => c.ok === false);
  const ccManual = ccAll.filter(({ c }) => c.ok === null);
  const ok = errors.length === 0 && !pageErrors.length && !axeFails.length && !kbFails.length && !ccFails.length;
  const meta = { generatedAt: new Date().toISOString(), dist, server: server.mode, rules: 'axe-core defaults (WCAG A/AA + best-practice)', disabledRules: AXE_DISABLED_RULES, widths: AXE_WIDTHS, errors, skipped };
  writeFileSync(path.join(out, 'axe.json'), `${JSON.stringify({ tool: 'hb-axe', ok, ...meta, results: axeResults }, null, 2)}\n`);
  writeFileSync(path.join(out, 'keyboard.json'), `${JSON.stringify({ tool: 'hb-keyboard', ok: !kbFails.length, ...meta, results: keyboard }, null, 2)}\n`);
  const lines = [
    ...errors.map((e) => `ERROR ${e}`),
    ...pageErrors.map((r) => `${r.id} ${r.width}px: page error ${r.error}`),
    ...axeFails.flatMap((r) => r.violations.map((v) => `${r.id} ${r.url} ${r.width}px: [${v.id}] (${v.impact}) ${v.help}: ${v.nodes.map((n) => n.target).slice(0, 5).join(', ')}`)),
    ...ccFails.map(({ r, c }) => `${r.id} ${r.url} ${r.width}px: [color-contrast measured] ${c.target}: ${c.ratio}:1 < ${c.required}:1 (worst ${CC_PERCENTILE * 100} % of ${c.pixels} glyph pixels, min ${c.min}, median ${c.median}; axe: ${c.reason})`),
    ...kbFails.flatMap((k) => k.failures.map((f) => `${k.id} ${k.url} ${k.width}px keyboard: ${f}`)),
    ...ccManual.map(({ r, c }) => `CHECK BY HAND ${r.id} ${r.url} ${r.width}px: [color-contrast] ${c.target}: ${c.note} (axe: ${c.reason})`),
  ];
  const manual = ccManual.length ? `; ${ccManual.length} contrast item(s) to check by hand (listed)` : '';
  const verdict = ok
    ? `AXE OK: ${targets.length} URLs × ${AXE_WIDTHS.length} widths, 0 violations, keyboard ok${ccAll.length ? `, ${ccAll.length - ccManual.length} contrast item(s) axe could not compute measured ok` : ''}${manual}`
    : `AXE FAILED: ${axeFails.reduce((n, r) => n + r.violations.length, 0)} axe violations, ${ccFails.length} measured contrast failures, ${kbFails.length} keyboard failures, ${pageErrors.length + errors.length} errors${manual}`;
  writeFileSync(path.join(out, 'axe.txt'), `${[...lines, '', verdict].join('\n')}\n`);
  console.log(`\n${[...lines, verdict].join('\n')}\nreports: ${path.join(out, 'axe.json')}, ${path.join(out, 'keyboard.json')}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(REPO_ROOT);
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e: unknown) => { console.error(e); process.exitCode = 2; });
}
