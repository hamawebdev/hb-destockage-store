import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildTokens, evalFluid, fluid } from '../src/gen/build-tokens.ts';
import { BRAND_PATH, CSS_OUT, PROVISIONAL_PATH, TS_OUT, readSource, resolveSource } from '../src/gen/source.ts';
import { tokens, tokensCss, tokensSource } from '../src/index.ts';

const css = readFileSync(CSS_OUT, 'utf8');

describe('generated files never drift from brand/tokens.json', () => {
  test('tokens.css and tokens.generated.ts equal a fresh build of the source they name', () => {
    // Compare against the file named in the header, so an unrelated BRAND change landing on main
    // cannot turn the gate red before tokens regenerates; the next test pins the real source.
    const named = tokensSource.path.endsWith('provisional.tokens.json') ? PROVISIONAL_PATH : BRAND_PATH;
    const out = buildTokens(readSource(named));
    expect(css).toBe(out.css);
    expect(readFileSync(TS_OUT, 'utf8')).toBe(out.ts);
    expect(tokensCss).toBe(css);
  });

  test('once brand/tokens.json exists, the outputs are built from it at its current hash', () => {
    if (!existsSync(BRAND_PATH)) return; // BRAND-1 not merged yet: provisional copy is the source
    const src = resolveSource();
    if (tokensSource.path.endsWith('provisional.tokens.json')) {
      // Merge-order window (BRAND-1 lands after TOKENS-1): warn, don't turn everyone's gate red.
      // tokens regenerates from brand/tokens.json in its next merge of main.
      if (readSource(PROVISIONAL_PATH).sourceSha256 !== src.sourceSha256) {
        console.warn('ui-tokens: built from the provisional copy, which differs from brand/tokens.json — regenerate');
      }
      return;
    }
    expect(tokensSource).toEqual({ path: 'brand/tokens.json', sha256: src.sourceSha256 });
  });
});

describe('contract', () => {
  const rootBlock = /:root\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const arBlock = /:lang\(ar\)\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const names = (block: string): string[] => [...block.matchAll(/--([\w-]+):/g)].map((m) => m[1] as string);

  test('exposes the custom properties consumers build against', () => {
    const have = new Set(names(rootBlock));
    for (const n of [
      'color-text', 'color-surface', 'color-accent', 'color-accent-text', 'color-focus', 'color-border-control',
      'font-latin', 'font-arabic', 'font-switcher', 'font-body', 'fw-regular', 'fw-emphasis',
      'lh-body', 'lh-heading', 'lh-display', 'lh-ui', 'ls-display', 'ls-heading', 'ls-caps',
      'fs-caption', 'fs-small', 'fs-body', 'fs-lead', 'fs-h3', 'fs-h2', 'fs-h1', 'fs-display', 'fs-hero',
      'space-1', 'space-4', 'gutter', 'container-max', 'header-h', 'scroll-pad-start', 'tap-min',
      'radius-md', 'shadow-overlay', 'focus-width', 'focus-offset', 'dur-fast', 'ease-standard', 'z-sticky', 'icon-md',
    ]) {
      expect(have, n).toContain(n);
    }
  });

  test('Arabic elements get the real invariants, not only variables (review TOKENS-1 r1 F1/N1)', () => {
    // Inherited computed values: a lang="ar" span in a French h1 must not keep the h1's letter-spacing.
    expect(arBlock).toContain('letter-spacing:0!important;');
    expect(arBlock).toContain('font-weight:400!important;');
    expect(arBlock).toContain('font-synthesis:none!important;');
    expect(tokens.font.synthesis).toBe('none');
  });

  test('Arabic: webfont stack, one weight, line-height 1.6–1.8, zero letter-spacing', () => {
    expect(arBlock).not.toContain('--font-body'); // per element would pull the webfont onto /fr/ spans
    expect(css).toContain(':root:lang(ar){--font-body:var(--font-arabic)}');
    expect(arBlock).toContain('--fw-emphasis:400');
    for (const k of ['body', 'heading', 'display', 'ui']) {
      const v = Number(new RegExp(`--lh-${k}:([\\d.]+)`).exec(arBlock)?.[1]);
      expect(v, k).toBeGreaterThanOrEqual(1.6);
      expect(v, k).toBeLessThanOrEqual(1.8);
    }
    for (const n of names(rootBlock).filter((n) => n.startsWith('ls-'))) expect(arBlock).toContain(`--${n}:0;`);
  });

  test('the Latin and switcher stacks never name the Arabic webfont (French pages download 0 bytes)', () => {
    expect(tokens.font.family.latin).not.toMatch(/HB Noto/);
    expect(tokens.font.family.switcher).not.toMatch(/HB Noto|Noto Sans Arabic/);
    expect(tokens.font.family.arabic.startsWith('"HB Noto Sans Arabic"')).toBe(true);
  });

  test('reduced motion collapses every duration', () => {
    const block = /prefers-reduced-motion:reduce\)\{:root\{([^}]*)\}/.exec(css)?.[1] ?? '';
    for (const k of Object.keys(tokens.motion.duration)) expect(block).toContain(`--dur-${k}:0.01ms`);
  });

  test('no physical properties in tokens.css', () => {
    expect(css).not.toMatch(/(^|[;{\s])(left|right|(margin|padding|border)-(left|right)|text-align:\s*(left|right))\s*:/m);
  });

  test('tap target and header height are present for base.css', () => {
    expect(tokens.layout.tapMin).toBe('44px');
    expect(tokens.layout.headerH).toMatch(/^\d+px$/);
  });
});

describe('fluid maths', () => {
  test('fluid() hits both endpoints', () => {
    const f = fluid(16, 40);
    expect(evalFluid(f, 360)).toBeCloseTo(16, 1);
    expect(evalFluid(f, 1440)).toBeCloseTo(40, 1);
    expect(evalFluid(f, 200)).toBe(16);
    expect(evalFluid(f, 2000)).toBe(40);
  });

  test('every type step evaluates to its brand px at 360 and 1440', () => {
    for (const [name, s] of Object.entries(tokens.fontSize)) {
      expect(evalFluid(s.css, 360), name).toBeCloseTo(s.px360, 0);
      expect(evalFluid(s.css, 1440), name).toBeCloseTo(s.px1440, 0);
    }
  });

  test('a clamp that misses its brand endpoint is rejected', () => {
    const src = readSource(PROVISIONAL_PATH);
    const bad = structuredClone(src.tokens);
    (bad.layout as Record<string, Record<string, unknown>>).gutter!.fluid = 'clamp(1rem, 0.6667rem + 1.4815vw, 2.5rem)';
    expect(() => buildTokens({ ...src, tokens: bad })).toThrow(/gutter/);
  });

  test('Arabic line-height outside 1.6–1.8 is rejected', () => {
    const src = readSource(PROVISIONAL_PATH);
    const bad = structuredClone(src.tokens);
    bad.font.lineHeight['arabic-body'] = { $value: 1.4 };
    expect(() => buildTokens({ ...src, tokens: bad })).toThrow(/Arabic/);
  });
});
