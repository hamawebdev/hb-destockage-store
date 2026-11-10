// CART-4 (ledger C-8, C-9): the cart-off guard that hb-postbuild runs and scripts/cart-off-check.mjs reports.
import { describe, expect, test } from 'vitest';
import { cartOffProblems } from '../integrations/cart-off-scan.mjs';

const scan = (files: Record<string, string>) => cartOffProblems(Object.keys(files), (f) => files[f]!);

describe('cartOffProblems', () => {
  test('a clean cart-off dist passes', () => {
    expect(
      scan({
        'fr/index.html': '<a class="cat-card-buy" href="/fr/order/poele/">Commander</a>',
        'js/order.js': 'const a=1;',
        'js/search.js': 'e.o&&x("cat-res-buy")',
        'fr/order/poele/index.html': '<form id="order-form">',
        'img/p.avif': 'binary cart.js would be ignored here',
      }),
    ).toEqual([]);
  });

  test.each([
    ['js/cart.js', 'x'],
    ['js/cart-sheet.js', 'x'],
    ['ar/cart/ui.json', '{}'],
    ['fr/cart/items/101.json', '{}'],
    ['fr/checkout/index.html', '<html>'],
  ])('cart file %s fails', (f, body) => {
    expect(scan({ [f]: body }).join()).toMatch(/cart file shipped/);
  });

  test.each([
    ['fr/index.html', '<body data-js="/js/cart.js?v=1">'],
    ['fr/index.html', '<button class="hd-tool hd-cart" data-cart-open>'],
    ['ar/p/x/index.html', '<button class="cat-btn cat-cta cat-add-cart" data-cart-add="1">'],
    ['ar/index.html', '<button class="cat-add" type="button" data-cart-add="101">'],
    ['js/order.js', 'import("/js/cart.js")'],
    ['js/x.js', 'localStorage.getItem("hb.cart.v1")'],
    ['_headers', '/fr/checkout/*\n  Content-Security-Policy: x'],
    ['fr/order/x/index.html', '<form data-items="/fr/cart/items/{id}.json">'],
  ])('reference in %s fails: %s', (f, body) => {
    expect(scan({ [f]: body }).length).toBeGreaterThan(0);
  });
});
