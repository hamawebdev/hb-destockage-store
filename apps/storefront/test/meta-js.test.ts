// The pure rules of public/js/meta.js (META-5; contract §3, §5, §6, §8). Plain JS served as-is, so
// these hold it to @hb/shared's rules and to the consent and Purchase behaviour.
import { META_ID_RE as SHARED_META_ID_RE, META_PIXEL_ID_RE as SHARED_META_PIXEL_ID_RE } from '@hb/shared/meta';
import { ORDER_REF_RE } from '@hb/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { metaUiJson } from '../src/lib/meta-data.ts';
import {
  META_ID_RE,
  REF_RE,
  addedLines,
  clearChoice,
  clearPending,
  cookieExpiries,
  purchaseFor,
  readChoice,
  readCookie,
  saveChoice,
  savePending,
  signals,
  takePending,
  whenActive,
  whenRows,
  whenLcp,
} from '../public/js/meta-full.js';

function storage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  } as unknown as Storage;
}
const thrower = () => {
  throw new Error('storage disabled');
};

const CHOICE_KEY = 'hb.meta.consent.v1';
const PENDING_KEY = 'hb.meta.purchase';

describe('parity with @hb/shared', () => {
  it('fbp/fbc pattern', () => expect(META_ID_RE.source).toBe(SHARED_META_ID_RE.source));
  it('order ref pattern', () => expect(REF_RE.source).toBe(ORDER_REF_RE.source));
});

describe('the stored choice', () => {
  it('round-trips and ignores anything else', () => {
    const s = storage();
    expect(readChoice(() => s)).toBeNull();
    saveChoice('granted', () => s);
    expect(s.getItem(CHOICE_KEY)).toBe('granted');
    expect(readChoice(() => s)).toBe('granted');
    s.setItem(CHOICE_KEY, 'maybe');
    expect(readChoice(() => s)).toBeNull();
  });
  it('holds for this page view when storage is unavailable', () => {
    expect(readChoice(thrower)).toBeNull();
    saveChoice('denied', thrower);
    expect(readChoice(thrower)).toBe('denied');
    clearChoice(thrower);
    expect(readChoice(thrower)).toBeNull();
  });
});

describe('signals', () => {
  const PIXEL = '100000000000001';
  const fbp = 'fb.1.1596403881668.1116446470';
  it('reads only well-formed browser ids', () => {
    expect(signals(`a=b; _fbp=${fbp}; _fbc=not-an-id`, PIXEL)).toEqual({ consent: true, pixel: PIXEL, fbp });
  });
  it('drops 4,000-character cookies before they reach the order body', () => {
    const long = `fb.1.1596403881668.${'a'.repeat(4000)}`;
    expect(signals(`_fbp=${long}; _fbc=${long}`, PIXEL)).toEqual({ consent: true, pixel: PIXEL });
  });
  it('never invents an id', () => expect(signals('', PIXEL)).toEqual({ consent: true, pixel: PIXEL }));
  it('carries the page Pixel ID, which the server must find stored in D1 (MSET-3)', () => {
    const body = signals('', PIXEL);
    expect(body.pixel).toBe(PIXEL);
    expect(SHARED_META_PIXEL_ID_RE.test(body.pixel)).toBe(true);
  });
  it('readCookie matches the exact name', () => {
    expect(readCookie('x_fbp=1; _fbp=2', '_fbp')).toBe('2');
    expect(readCookie('', '_fbp')).toBeNull();
  });
});

describe('withdrawal expires the cookies on every domain form', () => {
  /** A jar with RFC 6265 domain matching, because localhost cannot prove this in a browser. */
  function jar(host: string) {
    const cookies = new Map<string, { value: string; domain: string | null }>();
    return {
      set(line: string) {
        const [pair, ...attrs] = line.split(';').map((x) => x.trim());
        const [name, value] = pair!.split('=');
        const domain = attrs.find((a) => a.toLowerCase().startsWith('domain='))?.slice(7).replace(/^\./, '') ?? null;
        if (domain !== null && host !== domain && !host.endsWith(`.${domain}`)) return;
        const key = `${name}|${domain}`;
        if (attrs.some((a) => a === 'Max-Age=0')) cookies.delete(key);
        else cookies.set(key, { value: value!, domain });
      },
      size: () => cookies.size,
    };
  }
  it.each(['comptoirdeluxe.com', 'www.comptoirdeluxe.com'])('on %s', (host) => {
    const j = jar(host);
    j.set('_fbp=fb.1.1.1; path=/');
    j.set('_fbp=fb.1.1.2; path=/; domain=.comptoirdeluxe.com');
    j.set('_fbc=fb.1.1.3; path=/; domain=comptoirdeluxe.com');
    expect(j.size()).toBeGreaterThan(0);
    for (const name of ['_fbp', '_fbc']) for (const c of cookieExpiries(name, host)) j.set(c);
    expect(j.size()).toBe(0);
  });
  it('a single-label host gets only the host-only form', () => {
    expect(cookieExpiries('_fbp', 'localhost')).toEqual(['_fbp=; Max-Age=0; path=/']);
  });
});

describe('the pending Purchase', () => {
  const p = { ref: 'HB-7K2Q9', value: 15200, contents: [{ id: '11', quantity: 1 }] };
  it('can be used once: a reload finds nothing', () => {
    const s = storage();
    savePending(p, () => s);
    expect(takePending(() => s)).toEqual(p);
    expect(takePending(() => s)).toBeNull();
    expect(s.getItem(PENDING_KEY)).toBeNull();
  });
  it('fires only for the ref in the URL', () => {
    expect(purchaseFor('HB-7K2Q9', p)).toBe(p);
    expect(purchaseFor('HB-OTHER', p)).toBeNull();
    expect(purchaseFor('HB-7K2Q9', null)).toBeNull();
    expect(purchaseFor(null, p)).toBeNull();
    expect(purchaseFor('not-a-ref', { ...p, ref: 'not-a-ref' })).toBeNull();
  });
  it('is cleared, and clearing never throws', () => {
    const s = storage();
    savePending(p, () => s);
    clearPending(() => s);
    expect(s.getItem(PENDING_KEY)).toBeNull();
    expect(() => clearPending(thrower)).not.toThrow();
    expect(takePending(thrower)).toBeNull();
  });
});

describe('addedLines', () => {
  const L = (p: number, v: number, q: number) => ({ p, v, q });
  it('a new line counts in full', () => expect(addedLines([], [L(1, 11, 2)])).toEqual([L(1, 11, 2)]));
  it('raising 1 → 2 gives the delta', () => expect(addedLines([L(1, 11, 1)], [L(1, 11, 2)])).toEqual([L(1, 11, 1)]));
  it('lowering or removing adds nothing', () => {
    expect(addedLines([L(1, 11, 3)], [L(1, 11, 2)])).toEqual([]);
    expect(addedLines([L(1, 11, 1)], [])).toEqual([]);
  });
});

describe('whenActive', () => {
  function env(init: { prerendering?: boolean; readyState?: string; idle?: boolean }) {
    const dl = new Map<string, () => void>();
    const wl = new Map<string, () => void>();
    const d = { prerendering: init.prerendering ?? false, readyState: init.readyState ?? 'complete', addEventListener: (e: string, f: () => void) => void dl.set(e, f) };
    const idle = vi.fn((f: () => void) => f());
    const w = {
      addEventListener: (e: string, f: () => void) => void wl.set(e, f),
      setTimeout: (f: () => void) => f(),
      ...(init.idle === false ? {} : { requestIdleCallback: idle }),
    };
    return { d, w, dl, wl, idle };
  }
  const settled = async (p: Promise<unknown>) => {
    let done = false;
    void p.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 5));
    return done;
  };

  it('does nothing during a prerender until activation', async () => {
    const x = env({ prerendering: true });
    const p = whenActive(x.d, x.w);
    expect(await settled(p)).toBe(false);
    expect(x.idle).not.toHaveBeenCalled();
    x.d.prerendering = false;
    x.dl.get('prerenderingchange')!();
    expect(await settled(p)).toBe(true);
  });
  it('waits for load, then idle', async () => {
    const x = env({ readyState: 'interactive' });
    const p = whenActive(x.d, x.w);
    expect(await settled(p)).toBe(false);
    x.wl.get('load')!();
    expect(await settled(p)).toBe(true);
    expect(x.idle).toHaveBeenCalledTimes(1);
  });
  it('falls back without requestIdleCallback', async () => {
    const x = env({ idle: false });
    expect(await settled(whenActive(x.d, x.w))).toBe(true);
  });
});

describe('whenLcp', () => {
  const settled = async (p: Promise<unknown>, ms = 5) => {
    let done = false;
    void p.then(() => (done = true));
    await new Promise((r) => setTimeout(r, ms));
    return done;
  };
  function env(supported = true) {
    let cb: ((l: { getEntries: () => unknown[] }) => void) | undefined;
    class PO {
      static supportedEntryTypes = supported ? ['largest-contentful-paint'] : [];
      constructor(f: typeof cb) {
        cb = f;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    const listeners = new Set<() => void>();
    const d = {
      visibilityState: 'visible',
      addEventListener: (_e: string, f: () => void) => void listeners.add(f),
      removeEventListener: (_e: string, f: () => void) => void listeners.delete(f),
    };
    const caps: number[] = [];
    const w = {
      PerformanceObserver: PO,
      document: d,
      // The cap never fires by itself here; a quiet window is real time.
      setTimeout: (f: () => void, ms: number) => {
        if (ms === 5000) caps.push(ms);
        return setTimeout(f, ms === 5000 ? 1_000_000 : ms);
      },
      clearTimeout,
    };
    return {
      w,
      d,
      caps,
      emit: (n: number) => cb?.({ getEntries: () => Array(n).fill({}) }),
      show: () => {
        d.visibilityState = 'visible';
        for (const f of [...listeners]) f();
      },
    };
  }
  const QUICK = { quiet: 20 };

  it('waits for an entry, then for it to stay the last one', async () => {
    const x = env();
    const p = whenLcp(x.w, QUICK);
    expect(await settled(p)).toBe(false);
    x.emit(0);
    expect(await settled(p)).toBe(false);
    x.emit(1);
    expect(await settled(p, 60)).toBe(true);
  });
  it('a later, larger entry restarts the quiet window', async () => {
    const x = env();
    const p = whenLcp(x.w, { quiet: 80 });
    x.emit(1);
    await new Promise((r) => setTimeout(r, 50));
    x.emit(1); // the checkout rows paint
    expect(await settled(p, 50)).toBe(false);
    expect(await settled(p, 100)).toBe(true);
  });
  it('hidden tab: the cap is not armed and an entry does not end the wait while hidden', async () => {
    const x = env();
    x.d.visibilityState = 'hidden';
    const p = whenLcp(x.w, QUICK);
    x.emit(1);
    expect(await settled(p, 60)).toBe(false);
    expect(x.caps).toEqual([]);
    x.show();
    expect(x.caps).toEqual([5000]);
    expect(await settled(p, 60)).toBe(true); // the entry seen while hidden counts once the tab is visible
  });
  it('hidden then visible with no entry: waits for the entry, cap counted from visible', async () => {
    const x = env();
    x.d.visibilityState = 'hidden';
    const p = whenLcp(x.w, QUICK);
    expect(await settled(p)).toBe(false);
    x.show();
    expect(x.caps).toEqual([5000]);
    expect(await settled(p)).toBe(false);
    x.emit(1);
    expect(await settled(p, 60)).toBe(true);
  });
  it('does not wait where the API is missing', async () => {
    expect(await settled(whenLcp(env(false).w))).toBe(true);
    expect(await settled(whenLcp({}))).toBe(true);
  });
  it('gives up after the cap on a page with no LCP candidate', async () => {
    const x = env();
    x.w.setTimeout = (f: () => void) => setTimeout(f, 0);
    expect(await settled(whenLcp(x.w, { cap: 1 }), 20)).toBe(true);
  });
});

describe('whenRows', () => {
  const page = (rows: number, emptyHidden: boolean) => ({
    getElementById: (id: string) => (id === 'of-rows' ? { children: { length: rows } } : id === 'of-empty' ? { hidden: emptyHidden } : null),
  });
  const w = { setTimeout: (f: () => void) => setTimeout(f, 1) };
  it('rows drawn', async () => expect(await whenRows(page(2, true), w)).toBeUndefined());
  it('empty cart shown', async () => expect(await whenRows(page(0, false), w)).toBeUndefined());
  it('still neither: bounded', async () => expect(await whenRows(page(0, true), w, 5)).toBeUndefined());
});

describe('the stub (meta.js)', () => {
  const stub = readFileSync(join(import.meta.dirname, '../public/js/meta.js'), 'utf8');
  it('no choice is offered on the order pages', () => expect(stub).toContain('^(order-step|checkout)$'));
  it('names the full file, so the budget tool can reach it', () => expect(stub).toContain("'./meta-full.js'"));
  it('carries no Pixel code', () => expect(stub).not.toMatch(/fbq|fbevents|facebook/));
});

describe('metaUiJson', () => {
  const strings = { 'consent.text': 't', 'consent.accept': 'a', 'consent.decline': 'd', 'consent.more': 'm' };
  it('carries the privacy link when the page exists', () => {
    const j = JSON.parse(metaUiJson({ strings, footerLinks: [{ key: 'privacy', label: 'x', href: '/fr/confidentialite/' }] }));
    expect(j).toEqual({ text: 't', accept: 'a', decline: 'd', more: 'm', privacy: '/fr/confidentialite/' });
  });
  it('no privacy page: no link, and no failure', () => {
    expect(JSON.parse(metaUiJson({ strings, footerLinks: [] })).privacy).toBeNull();
  });
  it('a missing string fails the build', () => {
    expect(() => metaUiJson({ strings: {}, footerLinks: [] })).toThrow(/consent.text/);
  });
});
