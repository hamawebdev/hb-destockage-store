// WEB-4: the post-build CSP generator. Unit tests on the scanner/rules and a fixture "dist" whose
// every inline script/style must be covered by the CSP its path receives (a missing hash fails).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildRules,
  effectiveGroup,
  mergeSamePattern,
  type PageScan,
  CspError,
  HEADER_MARK,
  MAX_LINE,
  TURNSTILE_ORIGIN,
  buildCsp,
  generate,
  patternMatches,
  renderHeaders,
  scanHtml,
  sha256,
} from '../scripts/csp.ts';

const STYLE_HOME = '.h{color:red}';
const STYLE_PRODUCT = '.p{color:blue}';
const SPEC = '{"prefetch":[{"where":{"href_matches":"/*"},"eagerness":"moderate"}]}';
const LOADER = "addEventListener('load',()=>{})";

function page(lang: string, tpl: string, style: string, extra = ''): string {
  return (
    `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" data-tpl="${tpl}"><head><meta charset="utf-8">` +
    `<style>${style}</style><script type="speculationrules">${SPEC}</script>` +
    `<script type="application/ld+json">{"@type":"Product"}</script></head>` +
    `<body><main>${tpl}</main>${extra}<script>${LOADER}</script></body></html>`
  );
}

/** A small site shaped like shell's route map. */
function site(dir: string): void {
  const put = (rel: string, html: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), html);
  };
  for (const lang of ['ar', 'fr']) {
    put(`${lang}/index.html`, page(lang, 'home', STYLE_HOME));
    put(`${lang}/p/pack-a/index.html`, page(lang, 'product', STYLE_PRODUCT, '<form action="/api/order" method="post"></form>'));
    put(`${lang}/p/pack-b/index.html`, page(lang, 'product', STYLE_PRODUCT, '<form action="/api/order" method="post"></form>'));
    put(`${lang}/c/cuisine/index.html`, page(lang, 'category', '.c{}'));
    put(`${lang}/c/cuisine/2/index.html`, page(lang, 'category', '.c{}'));
    put(`${lang}/search/index.html`, page(lang, 'search', '.s{}'));
    put(`${lang}/${lang === 'ar' ? 'altawsil' : 'livraison'}/index.html`, page(lang, 'content', '.t{}'));
    put(`${lang}/${lang === 'ar' ? 'man-nahnu' : 'a-propos'}/index.html`, page(lang, 'content', '.t{}'));
    put(`${lang}/order/confirmation/index.html`, page(lang, 'confirmation', '.k{}'));
    put(`${lang}/order/review/index.html`, page(lang, 'review', '.r{}', '<form data-hb="form" method="post" action="/api/order"></form>'));
    put(`${lang}/404.html`, page(lang, '404', '.n{}'));
  }
  put('404.html', page('ar', '404', '.nb{}'));
}

const tmp: string[] = [];
function tmpSite(): string {
  const d = mkdtempSync(join(tmpdir(), 'hb-csp-'));
  tmp.push(d);
  site(d);
  return d;
}
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Parses our `_headers` and applies it like Workers static assets: all matching rules, `!` detaches earlier values. */
function headersFor(text: string, path: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    if (!line.startsWith(' ')) {
      current = patternMatches(line.trim(), path) ? line.trim() : null;
      continue;
    }
    if (current === null) continue;
    const t = line.trim();
    if (t.startsWith('! ')) out.delete(t.slice(2).toLowerCase());
    else {
      const i = t.indexOf(':');
      const k = t.slice(0, i).toLowerCase();
      out.set(k, [...(out.get(k) ?? []), t.slice(i + 1).trim()]);
    }
  }
  return out;
}

function cspOf(text: string, path: string): string {
  const v = headersFor(text, path).get('content-security-policy') ?? [];
  expect(v, `exactly one CSP for ${path}`).toHaveLength(1);
  return v[0]!;
}

/** Every inline executable script and every <style> in the page must have its hash in the CSP. */
function assertCovered(html: string, csp: string, path: string): void {
  const s = scanHtml(html, path);
  const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? '';
  const styleSrc = /style-src ([^;]*)/.exec(csp)?.[1] ?? '';
  for (const h of s.scriptHashes) expect(scriptSrc, `${path} script ${h}`).toContain(h);
  for (const h of s.styleHashes) expect(styleSrc, `${path} style ${h}`).toContain(h);
}

describe('scanHtml', () => {
  test('hashes exact inline content: classic, module, speculationrules; skips ld+json, src scripts, comments', () => {
    const html =
      `<html lang="fr" data-tpl="home"><head><!-- <script>evil()</script> --><STYLE>a{}</STYLE>` +
      `<script type="module">m()</script><script type="speculationrules">${SPEC}</script>` +
      `<script type="application/ld+json">{}</script><script src="/js/order.js?v=1" defer></script>` +
      `<script>const s = "</scr" + "ipt>"; x()</script></head></html>`;
    const s = scanHtml(html, '/fr/');
    expect(s).toMatchObject({ lang: 'fr', template: 'home', problems: [] });
    expect(s.styleHashes).toEqual([sha256('a{}')]);
    expect([...s.scriptHashes].sort()).toEqual([sha256('m()'), sha256(SPEC), sha256('const s = "</scr" + "ipt>"; x()')].sort());
    expect(s.scriptHashes).not.toContain(sha256('evil()'));
  });

  test('a script body ends at the first </script, like the HTML tokenizer', () => {
    const s = scanHtml('<html><script>a("</script>")</script></html>', '/');
    expect(s.scriptHashes).toEqual([sha256('a("')]);
  });

  test('attributes with ">" inside quotes do not confuse the scanner', () => {
    const s = scanHtml('<html><div title="a>b"><style>x{}</style></div></html>', '/');
    expect(s.styleHashes).toEqual([sha256('x{}')]);
    expect(s.problems).toEqual([]);
  });

  test.each([
    ['<div style="color:red"></div>', /style= attribute/],
    ['<button onclick="x()">b</button>', /inline event handler onclick/],
    ['<a href="javascript:alert(1)">x</a>', /javascript: URL/],
    ['<script src="https://cdn.example/x.js"></script>', /cross-origin script/],
    ['<script src="//cdn.example/x.js"></script>', /cross-origin script/],
  ])('%s is reported as uncoverable', (snippet, re) => {
    expect(scanHtml(`<html><body>${snippet}</body></html>`, '/').problems.join('\n')).toMatch(re);
  });

  test('order form detection', () => {
    expect(scanHtml('<html><form method="post" action="/api/order"></form></html>', '/').hasOrderForm).toBe(true);
    expect(scanHtml('<html><form action="/search/"></form></html>', '/').hasOrderForm).toBe(false);
  });
});

describe('buildCsp', () => {
  test('no unsafe-inline, no nonce; Turnstile only when asked', () => {
    const plain = buildCsp([sha256('a')], [sha256('b')], false);
    expect(plain).not.toMatch(/unsafe-inline|nonce-|unsafe-eval/);
    expect(plain).not.toContain(TURNSTILE_ORIGIN);
    expect(plain).toContain("default-src 'none'");
    expect(plain).toContain("frame-ancestors 'none'");
    const order = buildCsp([], [], true);
    expect(order).toContain(`script-src 'self' ${TURNSTILE_ORIGIN}`);
    expect(order).toContain(`frame-src ${TURNSTILE_ORIGIN}`);
    expect(order).toContain("style-src 'none'");
  });
});

describe('generate on a fixture site', () => {
  test('every page gets exactly one CSP that covers all its inline scripts and styles', () => {
    const d = tmpSite();
    const report = generate(d);
    const text = readFileSync(join(d, '_headers'), 'utf8');
    expect(text.startsWith(HEADER_MARK)).toBe(true);
    const pages: [string, string][] = [];
    for (const lang of ['ar', 'fr']) {
      for (const p of [`/${lang}/`, `/${lang}/p/pack-a/`, `/${lang}/c/cuisine/2/`, `/${lang}/search/`, `/${lang}/order/review/`, `/${lang}/order/confirmation/`, `/${lang}/404.html`]) {
        const rel = p.endsWith('/') ? `${p.slice(1)}index.html` : p.slice(1);
        pages.push([p, readFileSync(join(d, rel), 'utf8')]);
      }
    }
    for (const [p, html] of pages) assertCovered(html, cspOf(text, p), p);
    expect(report.rules).toBeLessThanOrEqual(100);
    expect(report.longestLine).toBeLessThanOrEqual(MAX_LINE);
  });

  test('a page whose inline style was changed after generation is NOT covered (the check fails)', () => {
    const d = tmpSite();
    generate(d);
    const text = readFileSync(join(d, '_headers'), 'utf8');
    const tampered = page('ar', 'home', '.h{color:green}');
    expect(() => assertCovered(tampered, cspOf(text, '/ar/'), '/ar/')).toThrow();
    const extraScript = page('ar', 'home', STYLE_HOME).replace('</body>', '<script>steal()</script></body>');
    expect(() => assertCovered(extraScript, cspOf(text, '/ar/'), '/ar/')).toThrow();
  });

  test('product pages allow Turnstile; home, category and review-free pages do not', () => {
    const d = tmpSite();
    generate(d);
    const text = readFileSync(join(d, '_headers'), 'utf8');
    expect(cspOf(text, '/ar/p/pack-b/')).toContain(`frame-src ${TURNSTILE_ORIGIN}`);
    expect(cspOf(text, '/fr/')).not.toContain(TURNSTILE_ORIGIN);
    expect(cspOf(text, '/fr/c/cuisine/')).not.toContain(TURNSTILE_ORIGIN);
    expect(cspOf(text, '/fr/order/confirmation/')).not.toContain(TURNSTILE_ORIGIN);
  });

  test('templates do not leak hashes into each other; unknown URLs get the 404 policy', () => {
    const d = tmpSite();
    generate(d);
    const text = readFileSync(join(d, '_headers'), 'utf8');
    expect(cspOf(text, '/ar/')).not.toContain(sha256(STYLE_PRODUCT));
    expect(cspOf(text, '/ar/p/pack-a/')).toContain(sha256(STYLE_PRODUCT));
    const unknown = cspOf(text, '/ar/no-such-page/');
    expect(unknown).toContain(sha256('.n{}'));
    expect(unknown).not.toContain(sha256(STYLE_PRODUCT));
  });

  test('content pages under /{lang}/ get exact rules, not /{lang}/* (which would shadow everything)', () => {
    const d = tmpSite();
    const r = generate(d);
    const content = r.groups.find((g) => g.key === 'ar:content')!;
    expect(content.patterns).toEqual(['/ar/altawsil/', '/ar/man-nahnu/']);
    expect(r.groups.find((g) => g.key === 'ar:product')!.patterns).toEqual(['/ar/p/*']);
  });

  test('security and cache headers', () => {
    const d = tmpSite();
    generate(d);
    const text = readFileSync(join(d, '_headers'), 'utf8');
    const html = headersFor(text, '/fr/');
    expect(html.get('strict-transport-security')).toEqual(['max-age=31536000; includeSubDomains']);
    expect(html.get('x-content-type-options')).toEqual(['nosniff']);
    expect(html.get('referrer-policy')).toEqual(['strict-origin-when-cross-origin']);
    expect(html.get('cross-origin-opener-policy')).toEqual(['same-origin']);
    expect(html.get('permissions-policy')?.[0]).toContain('camera=()');
    expect(html.get('cache-control')).toEqual(['public, max-age=0, must-revalidate']);
    expect(headersFor(text, '/_astro/x.AbC123.js').get('cache-control')).toEqual(['public, max-age=31536000, immutable']);
    expect(headersFor(text, '/img/p/a-360.avif').get('cache-control')).toEqual(['public, max-age=31536000, immutable']);
    expect(text).not.toMatch(/set-cookie/i);
  });

  test('No-Vary-Search params=("v") on the order step only (not confirmation, review or other pages)', () => {
    const d = tmpSite();
    for (const lang of ['ar', 'fr']) {
      mkdirSync(join(d, `${lang}/order/pack-a`), { recursive: true });
      writeFileSync(join(d, `${lang}/order/pack-a/index.html`), page(lang, 'order-step', '.os{}'));
    }
    generate(d);
    const text = readFileSync(join(d, '_headers'), 'utf8');
    for (const lang of ['ar', 'fr']) {
      expect(headersFor(text, `/${lang}/order/pack-a/`).get('no-vary-search'), lang).toEqual(['params=("v")']);
      for (const p of [`/${lang}/order/confirmation/`, `/${lang}/order/review/`, `/${lang}/p/pack-a/`, `/${lang}/`]) {
        expect(headersFor(text, p).get('no-vary-search'), p).toBeUndefined();
      }
      // The order step still gets exactly one CSP covering its own inline code.
      assertCovered(page(lang, 'order-step', '.os{}'), cspOf(text, `/${lang}/order/pack-a/`), `/${lang}/order/pack-a/`);
    }
  });

  test('build fails on uncoverable markup, on a foreign _headers, and on a missing dist', () => {
    const d = tmpSite();
    writeFileSync(join(d, 'ar/search/index.html'), page('ar', 'search', '.s{}').replace('<main>', '<main style="x">'));
    expect(() => generate(d)).toThrow(/style= attribute/);
    const e = tmpSite();
    writeFileSync(join(e, '_headers'), '/*\n  X-Test: 1\n');
    expect(() => generate(e)).toThrow(/not generated by this script/);
    expect(() => generate(join(e, 'nope'))).toThrow(CspError);
  });

  test('regenerating over our own _headers is fine (idempotent)', () => {
    const d = tmpSite();
    generate(d);
    const first = readFileSync(join(d, '_headers'), 'utf8');
    generate(d);
    expect(readFileSync(join(d, '_headers'), 'utf8')).toBe(first);
  });
});

describe('rules scale with templates, not with products (lead ruling on ORDER-STEP)', () => {
  const STYLE: Record<string, string> = {};
  const scan = (path: string, lang: string, template: string): PageScan => ({
    path,
    lang,
    template,
    scriptHashes: [sha256(SPEC), sha256(LOADER)],
    styleHashes: [(STYLE[template] ??= sha256(`.${template}{}`))],
    hasOrderForm: template === 'order-step' || template === 'order-confirmed',
    hasMeta: false,
    problems: [],
  });
  function catalogue(products: number): PageScan[] {
    const pages: PageScan[] = [scan('/404.html', 'ar', 'not-found')];
    for (const lang of ['ar', 'fr']) {
      pages.push(scan(`/${lang}/`, lang, 'home'), scan(`/${lang}/search/`, lang, 'search'), scan(`/${lang}/404.html`, lang, 'not-found'));
      pages.push(scan(`/${lang}/order/confirmation/`, lang, 'order-confirmed'), scan(`/${lang}/order/review/`, lang, 'order-confirmed'));
      pages.push(scan(`/${lang}/livraison/`, lang, 'content'), scan(`/${lang}/a-propos/`, lang, 'content'));
      for (let c = 0; c < 20; c++) pages.push(scan(`/${lang}/c/cat-${c}/`, lang, 'category'), scan(`/${lang}/c/cat-${c}/2/`, lang, 'category'));
      for (let i = 0; i < products; i++) {
        pages.push(scan(`/${lang}/p/product-${i}/`, lang, 'product'), scan(`/${lang}/order/product-${i}/`, lang, 'order-step'));
      }
    }
    return pages;
  }

  test('~500 products per language: same rule count as 10, under the cap, every page gets its own template policy', () => {
    const small = buildRules(catalogue(10));
    const large = buildRules(catalogue(500));
    expect(large.rules.length).toBe(small.rules.length);
    expect(large.rules.length).toBeLessThanOrEqual(100);
    expect(() => renderHeaders(large.rules)).not.toThrow();
    for (const p of catalogue(500)) expect(effectiveGroup(large.groups, p.path)?.key, p.path).toBe(`${p.lang}:${p.template}`);
    const patterns = large.rules.map((r) => r.pattern);
    expect(patterns).toContain('/ar/order/*');
    expect(patterns).toContain('/ar/p/*');
    // confirmation and review are exact rules AFTER the order-step wildcard, so they win
    expect(patterns.lastIndexOf('/ar/order/confirmation/')).toBeGreaterThan(patterns.indexOf('/ar/order/*'));
    expect(patterns.lastIndexOf('/ar/order/review/')).toBeGreaterThan(patterns.indexOf('/ar/order/*'));
  });

  test('applied like the platform: confirmation/review get only their policy, the order step only its own; unknown URLs under a wildcard keep the 404 styles', () => {
    const { rules } = buildRules(catalogue(500));
    const text = renderHeaders(rules);
    for (const lang of ['ar', 'fr']) {
      const conf = cspOf(text, `/${lang}/order/confirmation/`);
      const review = cspOf(text, `/${lang}/order/review/`);
      const step = cspOf(text, `/${lang}/order/product-77/`);
      expect(conf).toContain(STYLE['order-confirmed']);
      expect(conf).not.toContain(STYLE['order-step']);
      expect(review).toBe(conf);
      expect(step).toContain(STYLE['order-step']);
      expect(step).not.toContain(STYLE['order-confirmed']);
      // /ar/p/deleted/ is answered with the 404 page: its style must be allowed there too
      expect(cspOf(text, `/${lang}/p/deleted-product/`)).toContain(STYLE['not-found']);
      expect(cspOf(text, `/${lang}/order/deleted-product/`)).toContain(STYLE['not-found']);
    }
  });

  test('a cap overflow still fails the build', () => {
    const pages = catalogue(1);
    // 120 content pages (exact rules each) cannot fit in 100 rules
    for (let i = 0; i < 120; i++) pages.push(scan(`/ar/page-${i}/`, 'ar', 'content'));
    expect(() => renderHeaders(buildRules(pages).rules)).toThrow(/100/);
  });
});

describe('one block per pattern', () => {
  test('same-pattern rules are merged at the last position (No-Vary-Search + the order-step CSP on /ar/order/*)', () => {
    const merged = mergeSamePattern([
      { pattern: '/*', headers: [['A', '1']] },
      { pattern: '/ar/order/*', headers: [['No-Vary-Search', 'params=("v")']] },
      { pattern: '/ar/p/*', detach: ['CSP'], headers: [['CSP', 'p']] },
      { pattern: '/ar/order/*', detach: ['CSP'], headers: [['CSP', 'o']] },
      { pattern: '/ar/order/review/*', detach: ['No-Vary-Search'], headers: [] },
    ]);
    expect(merged.map((r) => r.pattern)).toEqual(['/*', '/ar/p/*', '/ar/order/*', '/ar/order/review/*']);
    expect(merged[2]).toEqual({ pattern: '/ar/order/*', detach: ['CSP'], headers: [['No-Vary-Search', 'params=("v")'], ['CSP', 'o']] });
  });

  test('renderHeaders refuses a duplicate pattern', () => {
    expect(() => renderHeaders([{ pattern: '/x/*', headers: [] }, { pattern: '/x/*', headers: [] }])).toThrow(/duplicate/);
  });
});

describe('platform limits', () => {
  test('more than 100 rules fails', () => {
    const rules = Array.from({ length: 101 }, (_, i) => ({ pattern: `/x${i}/`, headers: [['X', '1'] as const] }));
    expect(() => renderHeaders(rules)).toThrow(/100/);
  });

  test('a line over 2,000 characters fails', () => {
    expect(() => renderHeaders([{ pattern: '/*', headers: [['Content-Security-Policy', 'x'.repeat(2000)]] }])).toThrow(/2000/);
  });
});
