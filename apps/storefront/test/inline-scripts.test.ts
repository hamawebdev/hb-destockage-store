// The constant inline scripts, executed in a sandbox with fake browser globals.
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { LOADER, SPECULATION_RULES } from '../src/lib/inline-scripts.mjs';

function sandbox(nav: Record<string, unknown>, lcp: number | null, opts: { sendBeacon?: boolean } = {}) {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const beacons: { url: string; body: string }[] = [];
  const imports: string[] = [];
  const doc = {
    documentElement: { lang: 'ar', dataset: { tpl: 'product' } },
    visibilityState: 'visible',
    querySelectorAll: () => [{ dataset: { js: '/js/order.js?v=ab12 https://evil.example/x.js' } }],
  };
  const ctx: Record<string, unknown> = {
    document: doc,
    location: { pathname: '/ar/p/x/', search: '?ref=HB-1' },
    navigator: { ...(opts.sendBeacon === false ? {} : { sendBeacon: (url: string, body: string) => (beacons.push({ url, body }), true) }), connection: { effectiveType: '4g' } },
    performance: { getEntriesByType: () => [nav] },
    PerformanceObserver: class {
      constructor(private cb: (l: { getEntries: () => { startTime: number }[] }) => void) {}
      observe() {
        if (lcp !== null) this.cb({ getEntries: () => [{ startTime: 10 }, { startTime: lcp }] });
      }
    },
    addEventListener: (t: string, f: () => void) => (listeners[t] ??= []).push(f),
    removeEventListener: () => {},
    setTimeout: (f: () => void) => f(),
    import: (u: string) => imports.push(u),
  };
  ctx['window'] = ctx;
  // `import(u)` is syntax in the script; give the sandbox a callable named import via a rewrite.
  runInNewContext(LOADER.replace(/import\(u\)/g, '__import(u)'), { ...ctx, __import: (u: string) => imports.push(u) });
  const fire = (t: string) => (listeners[t] ?? []).forEach((f) => f());
  return { fire, beacons, imports, doc };
}

const nav = { type: 'navigate', responseStart: 212.4, domainLookupStart: 5, domainLookupEnd: 40, connectStart: 40, connectEnd: 120, secureConnectionStart: 70, nextHopProtocol: 'h3', activationStart: 0 };

describe('RUM beacon', () => {
  test('one beacon on hide with the agreed payload, path without query', () => {
    const s = sandbox(nav, 812.6);
    s.fire('load');
    expect(s.beacons).toEqual([]);
    s.doc.visibilityState = 'hidden';
    s.fire('visibilitychange');
    s.fire('pagehide');
    expect(s.beacons).toHaveLength(1);
    expect(s.beacons[0]?.url).toBe('/api/rum');
    expect(JSON.parse(s.beacons[0]?.body ?? '{}')).toEqual({
      v: 1, lang: 'ar', tpl: 'product', path: '/ar/p/x/', navType: 'navigate', prerendered: false,
      ttfb: 212, dns: 35, connect: 80, tls: 50, proto: 'h3', lcp: 813, effectiveType: '4g',
    });
    expect((s.beacons[0]?.body ?? '').length).toBeLessThan(1024);
  });
  test('prerendered pages report activationStart; values are clamped to 60 s', () => {
    const s = sandbox({ ...nav, type: 'prerender', activationStart: 1500, responseStart: 90_000 }, null);
    s.fire('load');
    s.fire('pagehide');
    const b = JSON.parse(s.beacons[0]?.body ?? '{}');
    expect(b).toMatchObject({ navType: 'prerender', prerendered: true, activationStart: 1500, ttfb: 60_000 });
    expect(b.lcp).toBeUndefined();
  });
  test('no sendBeacon: nothing sent, no error', () => {
    const s = sandbox(nav, 500, { sendBeacon: false });
    s.fire('load');
    expect(() => s.fire('pagehide')).not.toThrow();
    expect(s.beacons).toEqual([]);
  });
});

describe('loader', () => {
  test('imports only same-origin /js/ modules, once, at load', () => {
    const s = sandbox(nav, 1);
    s.fire('load');
    s.fire('focusin');
    expect(s.imports).toEqual(['/js/order.js?v=ab12']);
  });
});

describe('speculation rules', () => {
  const r = JSON.parse(SPECULATION_RULES);
  test('moderate prefetch site-wide, excluding API, order steps and opt-outs', () => {
    expect(r.prefetch[0].eagerness).toBe('moderate');
    expect(JSON.stringify(r.prefetch[0].where)).toContain('/api/*');
    expect(JSON.stringify(r.prefetch[0].where)).toContain('/*/order/*');
    expect(JSON.stringify(r.prefetch[0].where)).toContain('[data-no-prefetch]');
  });
  test('prerender only product pages, moderate; nothing eager', () => {
    expect(r.prerender).toEqual([{ where: { and: [{ href_matches: '/*/p/*' }, { not: { selector_matches: '[data-no-prefetch]' } }] }, eagerness: 'moderate' }]);
    expect(SPECULATION_RULES).not.toMatch(/eager"|immediate/);
  });
});
