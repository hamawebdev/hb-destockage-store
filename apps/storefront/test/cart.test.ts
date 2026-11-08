// The pure cart rules of public/js/cart.js (limits, merging lines, corrupt storage, tab sync) and the sheet's line
// model in public/js/cart-sheet.js. Plain JS served as-is, so these keep it honest against @hb/shared's limits.
import { MAX_ORDER_LINES, MAX_QTY_PER_LINE } from '@hb/shared/money';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { KEY, MAX_LINES, MAX_QTY, addLine, count, createStore, parse, removeLine, removeVariants, serialize, setQty } from '../public/js/cart.js';
import { linesTotal, matchVariant, resolveLines } from '../public/js/cart-sheet.js';
import { findPhysicalProperty, pruneCustomProperties } from '../integrations/postbuild-core.mjs';

const L = (p: number, v: number, q: number) => ({ p, v, q });

describe('limits come from @hb/shared', () => {
  it('matches the server limits', () => {
    expect(MAX_QTY).toBe(MAX_QTY_PER_LINE);
    expect(MAX_LINES).toBe(MAX_ORDER_LINES);
  });
});

describe('parse: corrupt storage never reaches the page', () => {
  const stored = (lines: unknown) => JSON.stringify({ v: 1, lines });
  it('reads a valid cart', () => expect(parse(stored([L(1, 11, 2)]))).toEqual([L(1, 11, 2)]));
  it('round-trips through serialize', () => expect(parse(serialize([L(1, 11, 2), L(2, 21, 1)]))).toEqual([L(1, 11, 2), L(2, 21, 1)]));
  it.each(['', 'not json', '{"v":2,"lines":[]}', '{"v":1}', 'null', '[]', '{"v":1,"lines":{}}'])('rejects %j', (raw) => expect(parse(raw)).toEqual([]));
  it('drops malformed lines and keeps the good ones', () => {
    expect(parse(stored([L(1, 11, 1), { p: '2', v: 21, q: 1 }, { p: 3, v: -1, q: 1 }, { p: 4, v: 41, q: 0 }, { p: 5, v: 51, q: 1.5 }, null]))).toEqual([L(1, 11, 1)]);
  });
  it('merges duplicate variants and caps quantities and lines', () => {
    expect(parse(stored([L(1, 11, 6), L(1, 11, 7)]))).toEqual([L(1, 11, 10)]);
    expect(parse(stored([L(1, 11, 99)]))).toEqual([L(1, 11, 10)]);
    const many = Array.from({ length: 12 }, (_, i) => L(i + 1, i + 100, 1));
    expect(parse(stored(many))).toHaveLength(MAX_LINES);
  });
});

describe('addLine', () => {
  it('adds a new line', () => expect(addLine([], 1, 11, 1, 5)).toEqual({ lines: [L(1, 11, 1)], status: 'ok' }));
  it('merges the same variant into one line', () => expect(addLine([L(1, 11, 2)], 1, 11, 1, 5)).toEqual({ lines: [L(1, 11, 3)], status: 'ok' }));
  it('keeps distinct variants of a product as separate lines', () => expect(addLine([L(1, 11, 1)], 1, 12, 1, 5).lines).toEqual([L(1, 11, 1), L(1, 12, 1)]));
  it('stops at the variant stock', () => expect(addLine([L(1, 11, 2)], 1, 11, 5, 3)).toEqual({ lines: [L(1, 11, 3)], status: 'qty_max' }));
  it('stops at the per-line limit even with more stock', () => expect(addLine([L(1, 11, 10)], 1, 11, 1, 50)).toEqual({ lines: [L(1, 11, 10)], status: 'qty_max' }));
  it('refuses a sold-out variant', () => expect(addLine([], 1, 11, 1, 0)).toEqual({ lines: [], status: 'qty_max' }));
  it('refuses a new line beyond the order limit but not more of an existing one', () => {
    const full = Array.from({ length: MAX_LINES }, (_, i) => L(i + 1, i + 100, 1));
    expect(addLine(full, 99, 999, 1, 5)).toEqual({ lines: full, status: 'lines_max' });
    expect(addLine(full, 1, 100, 1, 5).status).toBe('ok');
  });
});

describe('setQty and removal', () => {
  it('stays within 1..max', () => {
    expect(setQty([L(1, 11, 2)], 11, 0, 5).lines).toEqual([L(1, 11, 1)]);
    const r = setQty([L(1, 11, 2)], 11, 9, 5);
    expect(r).toEqual({ lines: [L(1, 11, 5)], status: 'qty_max' });
  });
  it('removes one line', () => expect(removeLine([L(1, 11, 1), L(2, 21, 1)], 11)).toEqual([L(2, 21, 1)]));
  it('removes only what was ordered', () => expect(removeVariants([L(1, 11, 1), L(2, 21, 1), L(3, 31, 1)], [11, 21])).toEqual([L(3, 31, 1)]));
  it('counts units', () => expect(count([L(1, 11, 2), L(2, 21, 3)])).toBe(5));
});

describe('createStore', () => {
  const memoryStorage = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  it('writes hb.cart.v1 in the agreed shape', () => {
    const s = memoryStorage();
    createStore(() => s as unknown as Storage).write([L(1, 11, 2)]);
    expect(JSON.parse(s.m.get(KEY)!)).toEqual({ v: 1, lines: [L(1, 11, 2)] });
  });
  it('keeps working in memory when storage throws', () => {
    const store = createStore(() => {
      throw new Error('denied');
    });
    expect(store.lines()).toEqual([]);
    store.write([L(1, 11, 1)]);
    expect(store.lines()).toEqual([L(1, 11, 1)]);
  });
  it('falls back to memory when a write fails (quota)', () => {
    const s = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    const store = createStore(() => s as unknown as Storage);
    store.write([L(1, 11, 1)]);
    expect(store.lines()).toEqual([L(1, 11, 1)]);
  });
  it('tab sync: a storage event for the cart notifies, re-reading what the other tab wrote', () => {
    const s = memoryStorage();
    const store = createStore(() => s as unknown as Storage);
    const seen = vi.fn();
    store.sub(() => seen(store.lines()));
    s.m.set(KEY, serialize([L(9, 91, 3)]));
    store.onStorage({ key: KEY } as StorageEvent);
    store.onStorage({ key: 'other' } as StorageEvent);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0]).toEqual([L(9, 91, 3)]);
    store.onStorage({ key: null } as StorageEvent); // clear()
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe('sheet line model', () => {
  const product = { id: 1, name: 'A', variants: [{ id: 11, label: 'M', price: 1000, max: 3, ok: true, ovs: [100, 200] }, { id: 12, label: 'L', price: 1200, max: 0, ok: false, ovs: [101, 200] }] };
  it('clamps quantity to stock and sums only sellable lines', () => {
    const r = resolveLines([L(1, 11, 5), L(1, 12, 1), L(2, 21, 1)], [product, product, null]);
    expect(r.map((x: { state: string }) => x.state)).toEqual(['ok', 'unavailable', 'unavailable']);
    expect(r[0]).toMatchObject({ q: 3 });
    expect(linesTotal(r)).toBe(3000);
  });
  it('marks a failed fetch as an error, not a missing product', () => expect(resolveLines([L(1, 11, 1)], ['err'])[0]!.state).toBe('error'));
  it('matches a complete option choice only', () => {
    expect(matchVariant(product.variants, [100, 200])?.id).toBe(11);
    expect(matchVariant(product.variants, [100, 0])).toBeUndefined();
    expect(matchVariant(product.variants, [101, 201])).toBeUndefined();
  });
});

describe('the sheet CSS (not inlined, D-008)', () => {
  const js = readFileSync(new URL('../public/js/cart-sheet.js', import.meta.url), 'utf8');
  const css = js.slice(js.indexOf('const CSS = `'), js.indexOf('`;'));
  const tokens = readFileSync(new URL('../../../packages/ui-tokens/tokens.css', import.meta.url), 'utf8');
  it('uses logical properties only', () => expect(findPhysicalProperty(css)).toBeNull());
  it('uses only existing tokens', () => {
    const missing = [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!).filter((v) => v !== '--cs-d' && !tokens.includes(`${v}:`));
    expect(missing).toEqual([]);
  });
  it('has no raw colours and no letter-spacing', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css).not.toMatch(/letter-spacing/);
  });
  it('sets customer text with textContent only', () => {
    expect(js).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe('token pruning keeps what the client JS reads', () => {
  it('keeps a token used only in JS text', () => {
    const css = ':root{--a:1;--b:2}.x{color:var(--a)}';
    expect(pruneCustomProperties(css)).not.toContain('--b');
    expect(pruneCustomProperties(css, 'x var(--b)')).toContain('--b:2');
  });
});
