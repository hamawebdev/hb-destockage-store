// CART-3/CART-4: the cart switch's build constants (integrations/cart-switch.mjs). Pins the exact source lines
// hb-postbuild rewrites, so an edit to them fails here instead of shipping the other mode's code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { minify } from 'vite';
import { describe, expect, test } from 'vitest';
import { applyBuildConstants, BUILD_CONSTANTS, versionSalt } from '../integrations/cart-switch.mjs';

const src = (f: string) => readFileSync(join(process.cwd(), 'public', 'js', f), 'utf8');
/** Exactly what hb-postbuild step 7 does to a dist/js file. */
async function ship(file: string, cartEnabled: boolean): Promise<string> {
  const c = applyBuildConstants(file, src(file), cartEnabled);
  expect(c.errors).toEqual([]);
  const r = await minify(file, c.code, { compress: { target: 'es2022' }, mangle: true, module: true });
  expect(r.errors).toEqual([]);
  return r.code;
}

describe('build constants', () => {
  test.each(BUILD_CONSTANTS.map((r) => [r.file, r.from] as const))('public/js/%s contains "%s" exactly once', (file, line) => {
    expect(src(file).split(line).length - 1).toBe(1);
  });

  test('a missing or duplicated line is a build error, never a silent pass', () => {
    expect(applyBuildConstants('search.js', 'const x = 1;', true).errors[0]).toMatch(/search\.js must contain "const BUY = true;" exactly once \(found 0\)/);
    expect(applyBuildConstants('search.js', 'const BUY = true;\nconst BUY = true;', true).errors[0]).toMatch(/found 2/);
    expect(applyBuildConstants('variant.js', 'anything', true)).toEqual({ code: 'anything', errors: [] });
  });

  test('search.js: cart on drops the buy branch entirely; cart off keeps it', async () => {
    const on = await ship('search.js', true);
    const off = await ship('search.js', false);
    for (const needle of ['cat-res-buy', 'card.buy', 'cat-res-row']) {
      expect(on).not.toContain(needle);
      expect(off).toContain(needle);
    }
  });

  test('?v= salt: cart-off URLs differ from cart-on ones; cart on keeps the unsalted version', () => {
    expect(versionSalt('search.js', true)).toBeUndefined();
    expect(versionSalt('search.js', false)).toBe('cart-off');
    expect(versionSalt('variant.js', false)).toBeUndefined();
  });
});
