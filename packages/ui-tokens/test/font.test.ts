import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildFont } from '../src/gen/build-font.ts';
import { FONT_CSS_OUT, FONT_TS_OUT, PKG_DIR, REPO_DIR, SUBSET_CONFIG, readFontInput, resolveSource } from '../src/gen/source.ts';
import { unicodeRange, woff2CodePoints } from '../src/gen/woff2.ts';
import { arabicFontFace, fontFaceCss, tokens } from '../src/index.ts';

const cfg = JSON.parse(readFileSync(SUBSET_CONFIG, 'utf8'));
const woff2 = readFileSync(join(PKG_DIR, arabicFontFace.file));
const cps = woff2CodePoints(woff2);
const STRINGS_AR = join(REPO_DIR, 'brand', 'copy', 'strings.ar.json');
/** Arabic-script code points: these must come from the webfont, or cursive joining breaks mid-word. */
const isArabicScript = (c: number): boolean =>
  (c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) || (c >= 0x08a0 && c <= 0x08ff) || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff);

const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];

describe('Arabic font subset', () => {
  test('font-face.css and font.generated.ts equal a fresh build', () => {
    const out = buildFont(readFontInput(resolveSource()));
    expect(readFileSync(FONT_CSS_OUT, 'utf8')).toBe(out.css);
    expect(readFileSync(FONT_TS_OUT, 'utf8')).toBe(out.ts);
    expect(fontFaceCss).toBe(out.css);
  });

  test('pinned to the official notofonts release, static 400', () => {
    expect(cfg.source.url).toMatch(/^https:\/\/github\.com\/notofonts\/arabic\/releases\/download\/NotoSansArabic-v[\d.]+\//);
    expect(cfg.source.member).toMatch(/NotoSansArabic-Regular\.ttf$/);
    expect(existsSync(join(PKG_DIR, 'fonts', 'OFL.txt'))).toBe(true);
    expect(readFileSync(join(PKG_DIR, 'fonts', 'OFL.txt'), 'utf8')).toMatch(/SIL Open Font License, Version 1\.1/);
  });

  test('within budget (CLAUDE.md ~11.6 KiB)', () => {
    expect(woff2.length).toBe(arabicFontFace.bytes);
    expect(woff2.length).toBeLessThanOrEqual(cfg.budgetBytes);
  });

  test('@font-face: brand family, 400, optional, unicode-range = the file cmap', () => {
    expect(tokens.font.family.arabic.startsWith(`"${arabicFontFace.family}"`)).toBe(true);
    expect(fontFaceCss).toContain(`font-family:"${arabicFontFace.family}"`);
    expect(fontFaceCss).toContain('font-weight:400');
    expect(fontFaceCss).toContain('font-display:optional');
    expect(fontFaceCss).toContain(`unicode-range:${unicodeRange([...cps].filter((c) => c >= 0x20))}`);
    expect(fontFaceCss).toContain(`url("./${arabicFontFace.file}")`);
  });

  test('covers every Arabic letter, the Algerian letters ڨ ڢ ڧ, ڤ, Arabic punctuation and ASCII digits', () => {
    const need = [
      ...Array.from({ length: 0x063a - 0x0621 + 1 }, (_, i) => 0x0621 + i),
      ...Array.from({ length: 0x064a - 0x0641 + 1 }, (_, i) => 0x0641 + i),
      0x06a8, 0x06a2, 0x06a7, 0x06a4, 0x060c, 0x061b, 0x061f, 0x0640, 0x200f,
      ...Array.from({ length: 10 }, (_, i) => 0x30 + i),
    ];
    expect(need.filter((c) => !cps.has(c)).map((c) => c.toString(16))).toEqual([]);
  });

  test('covers every Arabic-script character in brand/copy/strings.ar.json', () => {
    if (!existsSync(STRINGS_AR)) return; // BRAND copy not merged yet
    const text = strings(JSON.parse(readFileSync(STRINGS_AR, 'utf8'))).join('');
    const missing = [...new Set([...text].map((ch) => ch.codePointAt(0) as number))].filter((c) => isArabicScript(c) && !cps.has(c));
    expect(missing.map((c) => `U+${c.toString(16).toUpperCase()} ${String.fromCodePoint(c)}`)).toEqual([]);
  });
});
