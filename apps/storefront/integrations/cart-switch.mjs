// Cart switch at build time (CART-3, CART-4; plan artifacts/CART-0/plan.md §3–§5). Pure, unit-tested in
// test/cart-switch.test.ts. hb-postbuild applies these to dist/js before minifying, so the minifier removes the
// branch the switch turns off and the shipped file carries no code for the other mode.
//
// Each rule rewrites ONE exact source line to a constant. If the line is not found exactly once the build fails:
// someone edited it, and the switch must be re-checked rather than silently shipping both modes.
// Owner: cart.

/**
 * @typedef {{ file: string, when: 'cartOn' | 'cartOff', from: string, to: string }} BuildConstant
 * `when`: the build in which the rewrite applies.
 */

/** @type {readonly BuildConstant[]} */
export const BUILD_CONSTANTS = [
  // search.js: the buy-link branch exists for cart-off builds; a cart-on build ships search.js as it was before CART-3.
  { file: 'search.js', when: 'cartOn', from: 'const BUY = true;', to: 'const BUY = false;' },
  // order.js: its cart mode (checkout lines, import of cart.js) exists only for /{lang}/checkout/; a cart-off build ships
  // the single-product form alone (CART-4). The line is order.js's own, unchanged: cart-on stays byte-identical.
  { file: 'order.js', when: 'cartOff', from: "const cartMode = ds.mode === 'cart';", to: 'const cartMode = false;' },
];

/**
 * @param {string} file basename under dist/js (e.g. `search.js`)
 * @param {string} code source text
 * @param {boolean} cartEnabled
 * @returns {{ code: string, errors: string[] }}
 */
export function applyBuildConstants(file, code, cartEnabled) {
  const errors = [];
  let out = code;
  for (const r of BUILD_CONSTANTS) {
    if (r.file !== file || (r.when === 'cartOn') !== cartEnabled) continue;
    const n = out.split(r.from).length - 1;
    if (n !== 1) {
      errors.push(`cart switch: js/${file} must contain "${r.from}" exactly once (found ${n}); re-check integrations/cart-switch.mjs`);
      continue;
    }
    out = out.replace(r.from, r.to);
  }
  return { code: out, errors };
}

/**
 * Salt for `?v=` of a file whose shipped bytes depend on the switch: the two modes must never share a URL, since
 * `/js/*` is served immutable. Cart on keeps today's (unsalted) version.
 * @param {string} file
 * @param {boolean} cartEnabled
 * @returns {string | undefined}
 */
export function versionSalt(file, cartEnabled) {
  if (cartEnabled) return undefined;
  return BUILD_CONSTANTS.some((r) => r.file === file) ? 'cart-off' : undefined;
}
