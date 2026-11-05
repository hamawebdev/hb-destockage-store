/**
 * Static checks over everything pages owns (components/catalog, its page files, public/js):
 *  - every UI string key used by a template exists in both languages' string tables;
 *  - CSS uses logical properties only and no letter-spacing outside the token (Arabic-safe);
 *  - no style="" / on*="" attributes and no Astro-processed <script> (hash CSP, shell's rules).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const catalogDir = join(here, '..');
const storefront = join(catalogDir, '../../..');
const repo = join(storefront, '../..');

function walk(dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'test' ? [] : walk(p, ext);
    return ext.test(f) ? [p] : [];
  });
}

const pageDirs = ['ar', 'fr'].flatMap((l) => ['c', 'p', 'search'].map((d) => join(storefront, 'src/pages', l, d)));
const astroFiles = [...walk(catalogDir, /\.astro$/), ...pageDirs.flatMap((d) => walk(d, /\.astro$/))];
const cssSources = [...astroFiles, ...walk(catalogDir, /\.css$/)];

function table(lang: 'ar' | 'fr'): Record<string, string> {
  const brand = join(repo, `brand/copy/strings.${lang}.json`);
  const file = existsSync(brand) ? brand : join(repo, `packages/catalog/src/fixtures/strings.${lang}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
}

describe('string keys', () => {
  const used = new Set<string>();
  const plural = new Set<string>();
  for (const f of astroFiles) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\(strings, '([\w.]+)'/g)) used.add(m[1]!);
    for (const m of src.matchAll(/\btp\(strings, lang, '([\w.]+)'/g)) plural.add(m[1]!);
  }
  test('templates use keys', () => {
    expect(used.size).toBeGreaterThan(10);
  });
  for (const lang of ['ar', 'fr'] as const) {
    test(`every key exists in strings.${lang}`, () => {
      const s = table(lang);
      expect([...used].filter((k) => !(k in s))).toEqual([]);
      expect([...plural].filter((k) => !(`${k}.other` in s))).toEqual([]);
    });
  }
});

describe('CSS rules (logical properties, Arabic-safe, CSP-safe)', () => {
  const physical = /(?:^|[;{\s])(?:margin|padding|border)-(?:left|right|top|bottom)\b|(?:^|[;{\s])(?:left|right|top|bottom)\s*:|text-align\s*:\s*(?:left|right)|float\s*:\s*(?:left|right)|(?:^|[;{\s])(?:width|height|min-width|max-width|min-height|max-height)\s*:/;
  for (const f of cssSources) {
    const rel = f.slice(storefront.length + 1);
    test(rel, () => {
      const src = readFileSync(f, 'utf8');
      const css = f.endsWith('.css') ? src : [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
      const bad = css.split('\n').filter((l) => physical.test(l.replace(/@media[^{]*\{/g, '')));
      expect(bad).toEqual([]);
      expect(css).not.toMatch(/letter-spacing\s*:\s*(?!var\(--ls-)/);
      if (f.endsWith('.astro')) {
        // Strings only through lib/i18n (shell's t()); QA markers only behind showDevMarkers().
        expect(src).not.toMatch(/strings\[|Object\.(entries|keys|values)\(strings/);
        for (const line of src.split('\n').filter((l) => l.includes("'dev."))) expect(line).toMatch(/\b(dev|ph) &&|\bdev \?|DEV/);
        expect(src).not.toMatch(/\sstyle=/);
        expect(src).not.toMatch(/\son[a-z]+=/);
        expect(src.replace(/<script type="application\/ld\+json"[^>]*\/>/g, '')).not.toMatch(/<script\b/);
      }
    });
  }
});
