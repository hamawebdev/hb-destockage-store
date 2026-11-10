// The CSP grows by Meta's three origins only on pages that carry the Pixel (META-4; contract §7).
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { META_PIXEL_ORIGIN, META_SCRIPT_ORIGIN, buildCsp, generate, patternMatches, scanHtml } from '../scripts/csp.ts';

const page = (lang: string, tpl: string, marker: boolean) =>
  `<!doctype html><html lang="${lang}" data-tpl="${tpl}"><head><style>a{}</style></head><body${marker ? ' data-meta-pixel="000000000000000" data-meta-consent="required"' : ''}><script>1</script></body></html>`;

function site(marker: boolean): string {
  const d = mkdtempSync(join(tmpdir(), 'csp-meta-'));
  const files: [string, string][] = [
    ['ar/index.html', page('ar', 'home', marker)],
    ['ar/p/a/index.html', page('ar', 'product', marker)],
    ['ar/p/b/index.html', page('ar', 'product', marker)],
    ['ar/order/confirmation/index.html', page('ar', 'order-confirmed', marker)],
    ['ar/order/review/index.html', page('ar', 'order-confirmed', false)],
    ['ar/404.html', page('ar', 'not-found', false)],
  ];
  for (const [f, html] of files) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), html);
  }
  return d;
}

/** The CSP a path ends up with, reading _headers as the platform does: last matching detach wins. */
function cspFor(headers: string, path: string): string {
  let csp = '';
  let match = false;
  for (const line of headers.split('\n')) {
    if (line.startsWith('#') || line === '') continue;
    if (!line.startsWith(' ')) match = patternMatches(line, path);
    else if (match) {
      const t = line.trim();
      if (t === '! Content-Security-Policy') csp = '';
      else if (t.startsWith('Content-Security-Policy: ')) csp = t.slice('Content-Security-Policy: '.length);
    }
  }
  return csp;
}

describe('scanHtml', () => {
  test('the marker on <body> sets hasMeta; elsewhere it does not', () => {
    expect(scanHtml(page('fr', 'home', true), '/fr/').hasMeta).toBe(true);
    expect(scanHtml(page('fr', 'home', false), '/fr/').hasMeta).toBe(false);
    expect(scanHtml('<html lang="fr"><body><div data-meta-pixel="1"></div></body></html>', '/').hasMeta).toBe(false);
  });
});

describe('buildCsp', () => {
  test('exactly the three additions, and only when asked', () => {
    const off = buildCsp([], [], false);
    const on = buildCsp([], [], false, true);
    expect(off).not.toContain('facebook');
    expect(on).toContain(`script-src 'self' ${META_SCRIPT_ORIGIN}`);
    expect(on).toContain(`img-src 'self' ${META_PIXEL_ORIGIN}`);
    expect(on).toContain(`connect-src 'self' ${META_PIXEL_ORIGIN}`);
    expect(on.replaceAll(` ${META_SCRIPT_ORIGIN}`, '').replaceAll(` ${META_PIXEL_ORIGIN}`, '')).toBe(off);
    expect(on).not.toMatch(/unsafe-inline|nonce-/);
  });
});

describe('generated _headers', () => {
  test('without the marker: no Meta origin anywhere', () => {
    const d = site(false);
    generate(d);
    expect(readFileSync(join(d, '_headers'), 'utf8')).not.toContain('facebook');
  });
  test('with the marker: marked pages only; review, 404 and the fallback stay clean', () => {
    const d = site(true);
    generate(d);
    const h = readFileSync(join(d, '_headers'), 'utf8');
    for (const p of ['/ar/', '/ar/p/a/', '/ar/order/confirmation/']) {
      const csp = cspFor(h, p);
      expect(csp, p).toContain(META_SCRIPT_ORIGIN);
      expect(csp, p).toContain(`connect-src 'self' ${META_PIXEL_ORIGIN}`);
    }
    for (const p of ['/ar/order/review/', '/ar/404.html', '/no-such-page']) {
      expect(cspFor(h, p), p).not.toContain('facebook');
    }
  });
});
