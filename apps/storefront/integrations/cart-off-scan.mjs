// Cart-off build guard (CART-4, ledger C-8/C-9; plan artifacts/CART-0/plan.md §2). Pure over a file list and a
// reader, so hb-postbuild (fails the build), scripts/cart-off-check.mjs (evidence) and the unit test share it.
// Owner: cart.

/** Cart files and folders that must not exist in a cart-off dist (paths relative to dist, `/`-separated). */
export const CART_PATHS = [/^js\/cart\.js$/, /^js\/cart-sheet\.js$/, /^(ar|fr)\/cart\//, /^(ar|fr)\/checkout\//];

/**
 * Text that means cart UI or a reference to cart code. Checked in every text file shipped (HTML, JS, JSON,
 * _headers, _redirects, XML, TXT), so a page, a script, the CSP or a header rule naming a cart file fails.
 */
export const CART_MARKERS = [
  'cart.js',
  'cart-sheet.js',
  '/cart/',
  '/checkout/',
  'data-cart-',
  'hd-cart',
  'cat-add-cart',
  'class="cat-add"',
  'hb.cart.',
];

const TEXT = /\.(html|js|mjs|json|txt|xml|webmanifest)$|(^|\/)_(headers|redirects)$/;

/**
 * @param {readonly string[]} files every file under dist, relative, `/`-separated
 * @param {(rel: string) => string} read file text
 * @returns {string[]} problems (empty = clean)
 */
export function cartOffProblems(files, read) {
  const out = [];
  for (const f of files) {
    if (CART_PATHS.some((re) => re.test(f))) out.push(`${f}: cart file shipped`);
    if (!TEXT.test(f)) continue;
    const text = read(f);
    for (const m of CART_MARKERS) {
      const i = text.indexOf(m);
      if (i !== -1) out.push(`${f}: contains "${m}" (…${text.slice(Math.max(0, i - 40), i + m.length + 40).replace(/\s+/g, ' ')}…)`);
    }
  }
  return out;
}
