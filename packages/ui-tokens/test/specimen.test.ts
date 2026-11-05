import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { contrast, isolate } from '../src/gen/build-specimen.ts';
import { generateAll } from '../src/gen/generate.ts';
import { BRAND_PATH, PROVISIONAL_PATH, SPECIMEN_DIR, readSource } from '../src/gen/source.ts';
import { physicalProperties } from '../src/lint.ts';
import { icons, tokens, tokensSource } from '../src/index.ts';

const src = readSource(tokensSource.path.endsWith('provisional.tokens.json') ? PROVISIONAL_PATH : BRAND_PATH);
const page = { fr: readFileSync(join(SPECIMEN_DIR, 'fr.html'), 'utf8'), ar: readFileSync(join(SPECIMEN_DIR, 'ar.html'), 'utf8') };

describe('specimen', () => {
  test('specimen/{fr,ar}.html equal a fresh build of the current tokens, icons, font, base and forms', () => {
    const all = generateAll(src);
    expect(page.fr).toBe(all[join(SPECIMEN_DIR, 'fr.html')]);
    expect(page.ar).toBe(all[join(SPECIMEN_DIR, 'ar.html')]);
  });

  test.each(['fr', 'ar'] as const)('%s: right lang/dir, every colour, type step, icon and contrast pair shown', (lang) => {
    const html = page[lang];
    expect(html).toContain(`<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">`);
    for (const c of Object.keys(tokens.color)) expect(html, c).toContain(`--color-${c}</bdi>`);
    for (const s of Object.keys(tokens.fontSize)) expect(html, s).toContain(`font-size:var(--fs-${s})`);
    for (const n of Object.keys(icons)) expect(html, n).toContain(`<bdi dir="ltr">${n}</bdi>`);
    expect(html.match(/class="sp-pair"/g)).toHaveLength(src.tokens.contrastPairs?.pairs.length ?? -1);
    expect(html).not.toContain('✗');
  });

  test('Latin runs in Arabic copy are isolated whole (review TOKENS-5 r1: accented letters split runs)', () => {
    const body = page.ar.slice(page.ar.indexOf('<body>'));
    expect(body).not.toContain('[['); // every marker rendered
    expect(body).not.toMatch(/<\/bdi>\p{Script=Latin}/u);
    expect(body).not.toMatch(/\p{Script=Latin}<bdi/u);
    expect(page.ar).toMatch(/<a class="btn btn-secondary sp-switch" href="fr\.html" lang="fr" dir="ltr"[^>]*>Français<\/a>/);
    expect(page.fr).toMatch(/<a class="btn btn-secondary sp-switch" href="ar\.html" lang="ar" dir="rtl"[^>]*>العربية<\/a>/);
  });

  test('isolate(): marked spans are wrapped whole, accents and digits included; nothing is guessed', () => {
    expect(isolate('اقرأ [[fr|Français à 14 600, été ç]] الآن')).toBe('اقرأ <bdi dir="ltr" lang="fr">Français à 14 600, été ç</bdi> الآن');
    expect(isolate('Prix : 14 600 DA, déjà ç à é')).toBe('Prix : 14 600 DA, déjà ç à é');
    expect(isolate('نص Français 2026 نص')).toBe('نص Français 2026 نص');
    expect(isolate('[[en|a < b & "c"]]')).toBe('<bdi dir="ltr" lang="en">a &lt; b &amp; &quot;c&quot;</bdi>');
  });

  test('its own CSS is logical-only and the language switch never names the webfont', () => {
    for (const html of Object.values(page)) {
      const css = /<style>([\s\S]*)<\/style>/.exec(html)?.[1] ?? '';
      expect(physicalProperties(css)).toEqual([]);
      expect(css).toContain('.sp-switch { font-family: var(--font-switcher); }');
    }
  });

  test('contrast() matches WCAG reference values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });
});
