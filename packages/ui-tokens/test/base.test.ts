import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ICON_MIRROR_RULE } from '../src/index.ts';
import { BRAND_PATH, PKG_DIR, PROVISIONAL_PATH, readSource } from '../src/gen/source.ts';
import { physicalProperties } from '../src/lint.ts';
import { tokens, tokensSource } from '../src/index.ts';

const read = (f: string): string => readFileSync(join(PKG_DIR, f), 'utf8');
const SHEETS = ['tokens.css', 'font-face.css', 'base.css', 'forms.css'] as const;
const base = read('base.css');
const forms = read('forms.css');
const both = base + forms;
const flat = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
/** Declarations of one rule: the text between `<selector> {` and the next `}`. */
const rule = (css: string, selector: string): string => {
  const i = flat(css).indexOf(`${selector} {`);
  if (i < 0) throw new Error(`no rule ${selector}`);
  const s = flat(css).slice(i);
  return s.slice(s.indexOf('{') + 1, s.indexOf('}'));
};

describe('logical properties only', () => {
  test.each(SHEETS)('%s has no physical (direction-specific) declarations', (f) => {
    expect(physicalProperties(read(f))).toEqual([]);
  });

  test.each(SHEETS)('%s never tests direction through an ancestor (:dir(...) followed by a combinator)', (f) => {
    expect(flat(read(f))).not.toMatch(/:dir\((rtl|ltr)\)\s*[\w.#[*>~+:]/);
  });

  test('the lint catches physical declarations and allows logical ones', () => {
    const bad = `a{margin-left:1px}b{left:0}c{text-align:left}d{padding:1px 2px 3px 4px}e{border-radius:4px 0 0 4px}
      f{border-right:1px solid}g{inset:0 auto auto 0}h{float:right}i{padding-top:2px}j{top:0}k{border-top-left-radius:2px}`;
    expect(physicalProperties(bad)).toHaveLength(11);
    const good = `@media (min-width: 768px){a{margin-inline-start:1px;inset:0;padding:1px 2px;text-align:start;border-radius:50%;
      translate:0 8px;transform:scaleX(-1);inset-inline-end:0;width:10px;float:inline-start}}`;
    expect(physicalProperties(good)).toEqual([]);
  });
});

describe('base.css uses the token contract', () => {
  const defined = new Set([...read('tokens.css').matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
  const HOOKS = new Set(['--stack-gap', '--cluster-gap']); // per-use hooks with fallbacks

  test('every var() it reads is defined in tokens.css (or is a documented hook)', () => {
    const used = [...new Set([...both.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1] as string))];
    expect(used.filter((v) => !defined.has(v) && !HOOKS.has(v))).toEqual([]);
  });

  test('letter-spacing and line-height only via tokens (so Arabic gets 0 and 1.6–1.8)', () => {
    for (const m of flat(both).matchAll(/letter-spacing: ([^;}]+)/g)) expect(m[1]).toMatch(/^var\(--ls-[\w-]+\)$/);
    for (const m of flat(both).matchAll(/line-height: ([^;}]+)/g)) expect(m[1]).toMatch(/^var\(--lh-[\w-]+\)$/);
  });

  test('an element switching to Arabic takes the Arabic line-height at zero specificity', () => {
    expect(rule(base, ':where([lang|="ar"])')).toBe(' line-height: var(--lh-body); ');
  });

  test('/fr/ with a lang="ar" span: nothing resolves to the webfont (review TOKENS-4 r1 F2, lead rule)', () => {
    const sheets = SHEETS.map(read).join('\n');
    // 1. The webfont family is named only by the --font-arabic definition and @font-face.
    const naming = [...flat(sheets).matchAll(/([^{};]+)\{[^{}]*HB Noto Sans Arabic[^{}]*\}/g)].map((m) => (m[1] as string).trim());
    expect(naming).toEqual([':root', '@font-face']);
    // 2. --font-arabic is read in exactly one place, and that selector only matches an Arabic root.
    const reads = [...flat(sheets).matchAll(/([^{};]+)\{[^{}]*var\(--font-arabic\)[^{}]*\}/g)].map((m) => (m[1] as string).trim());
    expect(reads).toEqual([':root:lang(ar)']);
    // 3. Every font-family uses the per-page --font-body, the system --font-switcher, or inherit.
    for (const m of flat(sheets).matchAll(/font-family: ?([^;}]+)/g)) {
      expect(m[1]).toMatch(/^(var\(--font-(body|switcher)\)|inherit|"HB Noto Sans Arabic")$/);
    }
    // 4. Arabic content inside a non-Arabic page gets the system Arabic stack.
    expect(rule(base, ':where(:root:not(:lang(ar)) [lang|="ar"])')).toBe(' font-family: var(--font-switcher); ');
    expect(tokens.font.family.switcher).not.toMatch(/HB Noto|Noto Sans Arabic/);
  });

  test('every component colour state is a brand contrast pair (review TOKENS-4 r1 F1)', () => {
    const pairs = new Set(
      (readSource(tokensSource.path.endsWith('provisional.tokens.json') ? PROVISIONAL_PATH : BRAND_PATH).tokens.contrastPairs?.pairs ?? [])
        .filter((p) => p.min >= 4.5)
        .map((p) => `${p.fg}/${p.bg}`),
    );
    const decl = (css: string, sel: string, prop: string): string | undefined =>
      new RegExp(`(?:^ |; )${prop}: var\\(--color-([\\w-]+)\\)`).exec(rule(css, sel))?.[1];
    // [state selector, fallback selector it inherits colour/background from]
    const states: [string, string, string][] = [
      [base, '.btn-primary', '.btn-primary'], [base, '.btn-primary:hover', '.btn-primary'],
      [base, '.btn-secondary', '.btn-secondary'], [base, '.btn-secondary:hover', '.btn-secondary'],
      [forms, '.input', '.input'], [forms, '.input:disabled', '.input'],
      [forms, '.note', '.note'], [forms, '.note-success', '.note'], [forms, '.note-warning', '.note'], [forms, '.note-danger', '.note'],
      [forms, '.chip:has(:checked)', '.chip'],
    ];
    for (const [css, sel, from] of states) {
      const fg = decl(css, sel, 'color') ?? decl(css, from, 'color') ?? 'text';
      const bg = decl(css, sel, 'background') ?? decl(css, from, 'background') ?? 'surface';
      expect(pairs, `${sel}: ${fg} on ${bg}`).toContain(`${fg}/${bg}`);
    }
  });

  test('tap targets ≥ 44px on every interactive component', () => {
    expect(tokens.layout.tapMin).toBe('44px');
    for (const sel of ['.btn', '.btn-icon']) expect(rule(base, sel)).toContain('var(--tap-min)');
    for (const sel of ['.input', '.choice', '.chip']) expect(rule(forms, sel)).toContain('min-block-size: var(--tap-min)');
  });

  test('visible focus ring, sticky-header scroll padding, link colour', () => {
    expect(rule(base, ':focus-visible')).toBe(' outline: var(--focus-width) solid var(--color-focus); outline-offset: var(--focus-offset); ');
    expect(rule(base.slice(base.indexOf('@layer base {')), 'html')).toContain('scroll-padding-block-start: var(--scroll-pad-start)');
    expect(rule(base, 'a')).toContain('color: var(--color-accent-text)');
    expect(rule(forms, '.input')).toContain('border: var(--bw-control) solid var(--color-border-control)');
  });

  test('grid columns and breakpoints follow tokens', () => {
    const f = flat(base);
    expect(rule(base, '.grid')).toContain(`repeat(${tokens.layout.gridColumns[360]}, minmax(0, 1fr))`);
    expect(f).toContain(`@media (min-width: ${tokens.breakpoint.md}px) { .grid { grid-template-columns: repeat(${tokens.layout.gridColumns[768]},`);
    expect(f).toContain(`@media (min-width: ${tokens.breakpoint.lg}px) { .grid { grid-template-columns: repeat(${tokens.layout.gridColumns[1024]},`);
  });

  test('motion: view transitions + @starting-style, all off under prefers-reduced-motion', () => {
    const f = flat(base);
    expect(f).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{ @view-transition \{ navigation: auto; \}/);
    expect(f).toContain('@starting-style');
    expect(f).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ animation-duration: 0\.01ms !important;/);
  });

  test('directional icons flip in RTL with the exported rule', () => {
    expect(flat(base).replace(/ /g, '').replace(/;\}/g, '}')).toContain(ICON_MIRROR_RULE.replace(/ /g, ''));
  });

  test('no rule depends on page data: swatch colour is an SVG fill, not a custom property', () => {
    expect(both).not.toContain('--swatch');
    expect(rule(forms, '.swatch svg')).toContain('border-radius: var(--radius-round)');
  });

  test('same layer order statement as the storefront', () => {
    for (const s of [base, forms]) expect(s).toContain('@layer reset, tokens, base, layout, components, utilities;');
  });
});
