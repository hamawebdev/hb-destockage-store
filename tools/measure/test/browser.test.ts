/**
 * MEAS-3: screenshots, axe and the keyboard pass, against the fixture site in real Chrome.
 * Every gate here has a fixture proving it fails: missing alt, low contrast, invisible focus,
 * focus hidden under a sticky header, keyboard traps (script keydown, focusout, Shift+Tab only),
 * low contrast axe cannot compute, a page that does not load.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main as shots } from '../src/shots/cli.ts';
import { main as axe } from '../src/axe/cli.ts';
import { cleanup, edit, freshSite } from './fixtures/site.ts';
import { addA11yPages } from './fixtures/a11y.ts';

const temps: string[] = [];
afterAll(() => { cleanup(); for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const outDir = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'hb-m3-')); temps.push(d); return d; };
const T = { timeout: 300_000 };
const FR_H = 'fr/index.html';
interface Res { id: string; width: number; violations?: Array<{ id: string }>; failures?: string[]; forward?: string; backward?: string; contrast?: Array<{ ok: boolean | null; ratio?: number }> }
const read = (f: string): { results: Res[] } => JSON.parse(readFileSync(f, 'utf8'));

describe('npm run shots', () => {
  it('writes viewport + full-page PNGs per template × lang × width and a contact sheet; deterministic', T, async () => {
    const d = freshSite();
    const out = outDir();
    const args = ['--dist', d, '--serve', 'static', '--port', '0', '--url', '/ar/', '--url', '/fr/p/pack-cuisine/', '--out', out];
    expect(await shots(args)).toBe(0);
    for (const w of [360, 768, 1440]) {
      for (const f of [`home/ar-${w}.png`, `home/ar-${w}-full.png`, `product/fr-${w}.png`, `product/fr-${w}-full.png`]) {
        expect(existsSync(path.join(out, 'shots', f)), f).toBe(true);
      }
    }
    const sheet = readFileSync(path.join(out, 'shots/index.html'), 'utf8');
    expect(sheet).toContain('src="home/ar-360.png"');
    // same input → same pixels
    const out2 = outDir();
    expect(await shots([...args.slice(0, -1), out2])).toBe(0);
    for (const f of ['home/ar-360.png', 'product/fr-1440-full.png']) {
      expect(readFileSync(path.join(out2, 'shots', f)).equals(readFileSync(path.join(out, 'shots', f))), `${f} differs between runs`).toBe(true);
    }
  });

  it('a page that does not load fails', T, async () => {
    const d = freshSite();
    expect(await shots(['--dist', d, '--serve', 'static', '--port', '0', '--url', '/fr/nope/', '--out', outDir()])).toBe(1);
  });

  it('templates missing from the build fail (never silently skipped)', T, async () => {
    const d = freshSite(); // has only home + product
    expect(await shots(['--dist', d, '--serve', 'static', '--port', '0', '--template', 'home', '--out', outDir()])).toBe(1);
  });
});

describe('npm run axe (axe-core WCAG 2.2 A/AA + keyboard pass)', () => {
  const run = async (d: string, url: string): Promise<{ code: number; out: string }> => {
    const out = outDir();
    const code = await axe(['--dist', d, '--serve', 'static', '--port', '0', '--url', url, '--out', out]);
    return { code, out };
  };

  it('good pages pass: zero violations, focus visible at every stop, focus cycles', T, async () => {
    const d = freshSite();
    const { code, out } = await run(d, '/fr/p/pack-cuisine/');
    expect(code).toBe(0);
    const kb = read(path.join(out, 'keyboard.json'));
    expect(kb.results.map((r) => r.width)).toEqual([360, 768, 1440]);
    // Tab past the last element leaves the page; Shift+Tab past the first wraps to the last in headless Chrome
    expect(kb.results.every((r) => r.forward === 'left' && ['left', 'wrapped'].includes(r.backward ?? ''))).toBe(true);
    expect(readFileSync(path.join(out, 'axe.txt'), 'utf8')).toMatch(/AXE OK/);
  });

  it('an image without alt is an axe violation', T, async () => {
    const d = freshSite();
    edit(d, FR_H, (s) => s.replace('alt="Pack cuisine"', ''));
    const { code, out } = await run(d, '/fr/');
    expect(code).toBe(1);
    expect(read(path.join(out, 'axe.json')).results.flatMap((r) => (r.violations ?? []).map((v) => v.id))).toContain('image-alt');
  });

  it('low-contrast text is an axe violation', T, async () => {
    const d = freshSite();
    edit(d, FR_H, (s) => s.replace('<style>', '<style>h1{color:#bbb}'));
    const { code, out } = await run(d, '/fr/');
    expect(code).toBe(1);
    expect(read(path.join(out, 'axe.json')).results.flatMap((r) => (r.violations ?? []).map((v) => v.id))).toContain('color-contrast');
  });

  it('invisible focus fails the keyboard pass (WCAG 2.4.7)', T, async () => {
    const d = freshSite();
    edit(d, FR_H, (s) => s.replace('<style>', '<style>*:focus,*:focus-visible{outline:none!important;box-shadow:none!important}'));
    const { code, out } = await run(d, '/fr/');
    expect(code).toBe(1);
    expect(read(path.join(out, 'keyboard.json')).results.flatMap((r) => r.failures ?? []).join('\n')).toMatch(/focus not visible/);
  });

  it('focus hidden under a sticky header fails the keyboard pass (WCAG 2.4.11)', T, async () => {
    const d = freshSite();
    edit(d, FR_H, (s) => s.replace('<style>', '<style>.cover{position:fixed;inset:0;background:#fff;z-index:9}')
      .replace('</body>', '<div class="cover" aria-hidden="true"></div></body>'));
    const { code, out } = await run(d, '/fr/');
    expect(code).toBe(1);
    expect(read(path.join(out, 'keyboard.json')).results.flatMap((r) => r.failures ?? []).join('\n')).toMatch(/obscured/);
  });

  it('a page that does not load fails', T, async () => {
    const d = freshSite();
    expect((await run(d, '/fr/nope/')).code).toBe(1);
  });

  it('a lazy image far below the fold does not hang the load (it is loaded eagerly)', T, async () => {
    const d = freshSite(); addA11yPages(d);
    const { code } = await run(d, '/fr/lazy/');
    expect(code).toBe(0);
  });

  const kbFailures = (out: string): string => read(path.join(out, 'keyboard.json')).results.flatMap((r) => r.failures ?? []).join('\n');

  it('a JS keyboard trap fails (rev-c fixture: Tab bounces between two links, the third is never reached)', T, async () => {
    const d = freshSite(); addA11yPages(d);
    const { code, out } = await run(d, '/fr/trap/');
    expect(code).toBe(1);
    const f = kbFailures(out);
    expect(f).toMatch(/Tab: focus cycles among 2 element\(s\) \[a#x\[href="#a"\], a#y\[href="#b"\]\] and never reaches 1 other tabbable element\(s\) \[a\[href="#c"\]\] \(keyboard trap, WCAG 2\.1\.2\)/);
    expect(f).toMatch(/Shift\+Tab: focus cycles/);
    expect(read(path.join(out, 'keyboard.json')).results.every((r) => r.forward === 'trap' && r.backward === 'trap')).toBe(true);
    expect(readFileSync(path.join(out, 'axe.txt'), 'utf8')).toMatch(/AXE FAILED/);
  });

  it('a focusout handler pulling focus back into a region is a trap', T, async () => {
    const d = freshSite(); addA11yPages(d);
    const { code, out } = await run(d, '/fr/region/');
    expect(code).toBe(1);
    expect(kbFailures(out)).toMatch(/Tab: focus cycles among 2 element\(s\) \[a\[href="#1"\], a\[href="#2"\]\] and never reaches 1 other.*\[a\[href="#3"\]\]/);
  });

  it('a trap on Shift+Tab only is caught by the backward walk', T, async () => {
    const d = freshSite(); addA11yPages(d);
    const { code, out } = await run(d, '/fr/shift/');
    expect(code).toBe(1);
    const r = read(path.join(out, 'keyboard.json')).results;
    expect(r.every((x) => x.forward === 'left' && x.backward === 'trap')).toBe(true);
    expect(kbFailures(out)).toMatch(/Shift\+Tab: focus cycles .*never reaches 1 other tabbable element\(s\) \[a#x/);
  });

  it('no false trap: radio group, select, disabled, hidden, inert, closed details and dialog, skip link', T, async () => {
    const d = freshSite(); addA11yPages(d);
    const { code, out } = await run(d, '/fr/widgets/');
    expect(kbFailures(out)).toBe('');
    expect(code).toBe(0);
    const kb = JSON.parse(readFileSync(path.join(out, 'keyboard.json'), 'utf8')) as { results: Array<{ stops: Array<{ el: string }>; backwardOrder: string[] }> };
    // skip link, one stop for the radio group, select, input, summary, button
    expect(kb.results[0]!.stops.map((s) => s.el)).toEqual(['a[href="#main"]', 'input[name="c"]', 'select[name="q"]', 'input[name="n"]', 'summary', 'button']);
    expect(kb.results[0]!.backwardOrder.length).toBe(6);
  });

  it('low contrast axe cannot compute (text over a gradient) is measured from pixels and fails', T, async () => {
    const d = freshSite(); addA11yPages(d);
    const { code, out } = await run(d, '/fr/contrast-low/');
    expect(code).toBe(1);
    const cc = read(path.join(out, 'axe.json')).results.flatMap((r) => r.contrast ?? []);
    expect(cc.length).toBe(3); // one per width
    expect(cc.every((c) => c.ok === false && (c.ratio ?? 9) < 1.6)).toBe(true);
    expect(readFileSync(path.join(out, 'axe.txt'), 'utf8')).toMatch(/\[color-contrast measured\] .*< 4\.5:1/);
  });

  it('readable text over the same gradient is measured and passes', T, async () => {
    const d = freshSite(); addA11yPages(d);
    const { code, out } = await run(d, '/fr/contrast-ok/');
    const cc = read(path.join(out, 'axe.json')).results.flatMap((r) => r.contrast ?? []);
    expect(cc.length).toBe(3);
    expect(cc.every((c) => c.ok === true && (c.ratio ?? 0) >= 4.5)).toBe(true);
    expect(code).toBe(0);
  });
});
