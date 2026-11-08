import { describe, expect, it } from 'vitest';
import { applyBulk, diffFees, parseRange, type CurrentRow, type ProposedRow } from './core.ts';

describe('parseRange', () => {
  it('codes, ranges, separators (incl. Arabic comma)', () => {
    expect([...parseRange('1-3, 31  49-50')!]).toEqual([1, 2, 3, 31, 49, 50]);
    expect([...parseRange('16،31')!]).toEqual([16, 31]);
    expect(parseRange('')!.size).toBe(0);
  });
  it.each(['0', '70', '5-2', '1-70', 'a', '1--3', '1.5', '-3'])('rejects %j', (s) => {
    expect(parseRange(s)).toBeNull();
  });
});

const cur = (code: number, feeDzd: number, over: Partial<CurrentRow> = {}): [number, CurrentRow] => [code, { code, feeDzd, available: true, placeholder: false, version: 100 + code, ...over }];
const row = (code: number, feeDzd: number | null, over: Partial<ProposedRow> = {}): ProposedRow => ({ code, feeDzd, available: true, confirm: false, version: 100 + code, ...over });

describe('diffFees', () => {
  const current = new Map([cur(16, 600), cur(31, 800, { placeholder: true }), cur(1, 1000)]);

  it('unchanged rows produce nothing; a fee change is one change', () => {
    const r = diffFees(current, [row(16, 600), row(1, 1200)]);
    expect(r).toEqual({ ok: true, changes: [expect.objectContaining({ code: 1, before: { feeDzd: 1000, available: true, placeholder: false }, after: { feeDzd: 1200, available: true, placeholder: false } })] });
  });

  it('a placeholder stays a placeholder unless confirmed (availability-only or fee-only save)', () => {
    const avail = diffFees(current, [row(31, 800, { available: false })]);
    expect(avail.ok && avail.changes[0]!.after).toEqual({ feeDzd: 800, available: false, placeholder: true });
    expect(avail.ok && avail.changes[0]!.confirmed).toBe(false);
    const confirmed = diffFees(current, [row(31, 800, { confirm: true })]);
    expect(confirmed.ok && confirmed.changes[0]).toMatchObject({ confirmed: true, after: { placeholder: false } });
  });

  it('new wilaya: blank stays not set; a fee creates a confirmed (non-placeholder) row', () => {
    expect(diffFees(current, [row(49, null)])).toEqual({ ok: true, changes: [] });
    const r = diffFees(current, [row(49, 900, { version: 0 })]);
    expect(r.ok && r.changes[0]).toMatchObject({ code: 49, before: null, after: { feeDzd: 900, placeholder: false }, version: 0 });
  });

  it('an existing fee cannot be blanked', () => {
    const r = diffFees(current, [row(16, null)]);
    expect(r.ok).toBe(false);
  });

  it('flags: to 0 (free delivery) and a rise over 3×', () => {
    const r = diffFees(current, [row(16, 0), row(1, 3001), row(31, 2400)]);
    expect(r.ok && r.changes.map((c) => [c.code, c.toZero, c.riseOver3x])).toEqual([[16, true, false], [1, false, true], [31, false, false]]);
  });
});

describe('applyBulk', () => {
  it('bulk values win for selected rows only; confirm is OR-ed', () => {
    const rows = [row(1, 500), row(2, 500), row(3, 500)];
    const out = applyBulk(rows, { codes: new Set([2, 3]), feeDzd: 700, available: false, confirm: true });
    expect(out.map((r) => [r.code, r.feeDzd, r.available, r.confirm])).toEqual([[1, 500, true, false], [2, 700, false, true], [3, 700, false, true]]);
    expect(applyBulk(rows, { codes: new Set([1]), feeDzd: null, available: null, confirm: false })[0]).toEqual(rows[0]);
  });
});
