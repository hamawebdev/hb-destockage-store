import { describe, expect, test } from 'vitest';
import { checkPage, findPhysicalProperty, mergeStyles, orphanImagePreload, pruneCustomProperties, removeEmptyRules } from '../integrations/postbuild-core.mjs';
import { ALLOWED_INLINE_SCRIPTS, LOADER } from '../src/lib/inline-scripts.mjs';

const page = (head: string, body = '', html = '<html lang="fr" dir="ltr">') =>
  `<!doctype html>${html}<head><meta charset="utf-8">${head}</head><body>${body}<script>${LOADER}</script></body></html>`;
const ok = (h: string) => checkPage(h, { allowedInlineScripts: ALLOWED_INLINE_SCRIPTS, file: 'x.html' });

describe('mergeStyles', () => {
  test('merges every <style> into one at the first position, in order', () => {
    const r = mergeStyles('<head><style>a{}</style><title>t</title><style>b{}</style></head><body><style>c{}</style></body>');
    expect(r.count).toBe(3);
    expect(r.html).toBe('<head><style>a{}b{}c{}</style><title>t</title></head><body></body>');
  });
  test('no style: unchanged', () => {
    expect(mergeStyles('<p>x</p>').html).toBe('<p>x</p>');
  });
  test('$ sequences in CSS survive', () => {
    expect(mergeStyles('<style>a{content:"$&"}</style>').html).toBe('<style>a{content:"$&"}</style>');
  });
});

describe('pruneCustomProperties', () => {
  test('drops unreferenced properties, keeps chains, iterates to a fixpoint', () => {
    const css = ':root{--a:1px;--b:var(--a);--c:2px;--d:var(--c)}p{margin:var(--b)}';
    expect(pruneCustomProperties(css)).toBe(':root{--a:1px;--b:var(--a)}p{margin:var(--b)}');
  });
  test('removes rules and at-rules left empty', () => {
    const css = ':root{--x:1}@media (prefers-reduced-motion:reduce){:root{--y:0}}p{color:red}';
    expect(pruneCustomProperties(css)).toBe('p{color:red}');
  });
  test('keeps a property read from a language override', () => {
    const css = ':root{--lh:1.5}[lang|=ar]{--lh:1.7}p{line-height:var(--lh)}';
    expect(pruneCustomProperties(css)).toBe(css);
  });
  test('removeEmptyRules leaves non-empty rules alone', () => {
    expect(removeEmptyRules('a{}b{c:d}@layer x{}')).toBe('b{c:d}');
  });
});

describe('findPhysicalProperty', () => {
  test.each(['a{margin-left:0}', 'a{padding-right:1px}', 'a{left:0}', 'a{border-right-width:1px}', 'a{text-align:left}', 'a{float:right}'])('rejects %s', (css) => {
    expect(findPhysicalProperty(css)).not.toBeNull();
  });
  test.each(['a{margin-inline-start:0}', 'a{inset-inline-end:0}', 'a{text-align:start}', 'a{--space-right:1px}', 'a{border-inline-end:1px solid}'])('accepts %s', (css) => {
    expect(findPhysicalProperty(css)).toBeNull();
  });
});

describe('checkPage', () => {
  const good = page('<style>p{color:red}</style><link rel="canonical" href="https://x.dz/fr/">');
  test('a good page passes', () => expect(ok(good)).toEqual([]));
  test('lang/dir must match', () => {
    expect(ok(page('<style>p{}</style>', '', '<html lang="ar" dir="ltr">')).join()).toMatch(/dir="rtl"/);
    expect(ok(page('<style>p{}</style>', '', '<html>')).join()).toMatch(/lacks lang/);
  });
  test('exactly one <style>', () => {
    expect(ok(page('')).join()).toMatch(/found 0/);
    expect(ok(page('<style>a{}</style><style>b{}</style>')).join()).toMatch(/found 2/);
  });
  test('style= and on*= attributes are rejected', () => {
    expect(ok(page('<style>p{}</style>', '<p style="color:red">x</p>')).join()).toMatch(/style=/);
    expect(ok(page('<style>p{}</style>', '<button onclick="x()">x</button>')).join()).toMatch(/onclick=/);
  });
  test('physical properties in the sheet are rejected', () => {
    expect(ok(page('<style>p{margin-left:1px}</style>')).join()).toMatch(/physical/);
  });
  test('external stylesheet and external script are rejected', () => {
    expect(ok(page('<style>p{}</style><link rel="stylesheet" href="/a.css">')).join()).toMatch(/external stylesheet/);
    expect(ok(page('<style>p{}</style>', '<script type="module" src="/js/a.js"></script>')).join()).toMatch(/external <script src>/);
  });
  test('only allow-listed inline scripts; ld+json allowed but must not contain </script', () => {
    expect(ok(page('<style>p{}</style>', '<script>alert(1)</script>')).join()).toMatch(/allow-list/);
    expect(ok(page('<style>p{}</style><script type="application/ld+json">{"a":1}</script>'))).toEqual([]);
    expect(ok(page('<style>p{}</style><script type="application/ld+json">{"a":"<script"}</script>')).join()).toMatch(/ld\+json/);
  });
  test('an image preload must match an <img>/<source> srcset', () => {
    const pre = '<link rel="preload" as="image" imagesrcset="/a-360.avif 360w" imagesizes="100vw">';
    expect(ok(page(`<style>p{}</style>${pre}`)).join()).toMatch(/image preload matches no/);
    expect(ok(page(`<style>p{}</style>${pre}`, '<img srcset="/a-360.avif 360w" src="/a-360.avif" alt="">'))).toEqual([]);
  });
  test('no cross-origin resource in <head>', () => {
    expect(ok(page('<style>p{}</style><link rel="preconnect" href="https://challenges.cloudflare.com">')).join()).toMatch(/cross-origin/);
    expect(ok(page('<style>p{}</style><link rel="alternate" hreflang="ar" href="https://x.dz/ar/">'))).toEqual([]);
  });
});

describe('LOADER', () => {
  test('is the only allowed inline script and only accepts same-origin /js/*.js', () => {
    expect(ALLOWED_INLINE_SCRIPTS).toEqual([LOADER]);
    const re = /if\(\/(.+?)\/\.test\(u\)\)/.exec(LOADER)?.[1];
    expect(re).toBeDefined();
    const rx = new RegExp(re as string);
    expect(rx.test('/js/search.js')).toBe(true);
    expect(rx.test('/js/order.js?v=3f9a-c1')).toBe(true);
    expect(rx.test('/js/order.js?x=1')).toBe(false);
    expect(() => new Function(LOADER)).not.toThrow();
    expect(rx.test('https://evil.example/js/a.js')).toBe(false);
    expect(rx.test('//evil.example/js/a.js')).toBe(false);
  });
});

describe('orphanImagePreload', () => {
  const pre = '<link rel="preload" as="image" imagesrcset="/a-360.avif 360w" imagesizes="100vw">';
  test('matched by an <img srcset>', () => expect(orphanImagePreload(`${pre}<img srcset="/a-360.avif 360w">`)).toBeNull());
  test("the preload's own imagesrcset does not count", () => expect(orphanImagePreload(pre)).toBe('/a-360.avif 360w'));
  test('a different srcset does not count', () => expect(orphanImagePreload(`${pre}<img srcset="/b-360.avif 360w">`)).toBe('/a-360.avif 360w'));
  test('font preloads are ignored', () => expect(orphanImagePreload('<link rel="preload" as="font" href="/f.woff2">')).toBeNull());
});

describe('trimUnusedRules (guarded)', async () => {
  const { trimUnusedRules, selectorMayMatch, classesIn } = await import('../integrations/postbuild-core.mjs');
  const known = (c: string) => ['used', 'a', 'b', 'js-added'].includes(c);
  test('drops a plain rule whose class is unused, keeps used ones', () => {
    expect(trimUnusedRules('.used{c:1}.gone{c:2}', known)).toBe('.used{c:1}');
  });
  test('keeps a rule if ANY selector in the list may match', () => {
    expect(trimUnusedRules('.gone,.used{c:1}', known)).toBe('.gone,.used{c:1}');
  });
  test('keeps attribute/state selectors and :has/:dir/:lang/:is/:where/:not', () => {
    for (const sel of ['.gone[open]', '.gone[aria-current]', '.gone:has(.x)', '.gone:dir(rtl)', ':lang(ar) .gone', ':is(.gone)', ':where(.gone)', '.used:not(.gone)']) {
      expect(selectorMayMatch(sel, known), sel).toBe(true);
    }
  });
  test('keeps type, universal and pseudo-element-only selectors', () => {
    expect(trimUnusedRules('p{c:1}*{c:2}::view-transition-group(root){c:3}', known)).toBe('p{c:1}*{c:2}::view-transition-group(root){c:3}');
  });
  test('recurses into @layer/@media/@supports/@starting-style and drops them when empty', () => {
    expect(trimUnusedRules('@layer x{.gone{c:1}.used{c:2}}@media (min-width:1px){.gone{c:3}}@starting-style{.gone{c:4}}', known)).toBe('@layer x{.used{c:2}}');
  });
  test('never touches @font-face, @keyframes or statement at-rules', () => {
    const css = '@layer a,b;@font-face{font-family:F;src:url(x)}@keyframes k{0%{opacity:0}}';
    expect(trimUnusedRules(css, known)).toBe(css);
  });
  test('a class referenced only by client JS is known through the caller', () => expect(trimUnusedRules('.js-added{c:1}', known)).toBe('.js-added{c:1}'));
  test('strings with braces are not split', () => expect(trimUnusedRules('.used::after{content:"}{"}', known)).toBe('.used::after{content:"}{"}'));
  test('classesIn reads class attributes', () => expect([...classesIn('<a class="x  y"><b class="z">')]).toEqual(['x', 'y', 'z']));
});
