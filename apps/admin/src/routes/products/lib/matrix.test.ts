import { describe, expect, it } from 'vitest';
import {
  generateMatrix,
  MATRIX_LIMITS,
  SKU_MAX,
  SKU_RE,
  valueCode,
  type ExistingVariant,
  type MatrixInput,
  type MatrixOption,
  type MatrixPlan,
} from './matrix.ts';

// Options: size (1) = 28 cm (11), 32 cm (12); colour (2) = Rouge (21), Noir (22), Bleu (23).
const size: MatrixOption = { id: 1, values: [{ id: 11, labelFr: '28 cm' }, { id: 12, labelFr: '32 cm' }] };
const colour: MatrixOption = { id: 2, values: [{ id: 21, labelFr: 'Rouge' }, { id: 22, labelFr: 'Noir' }, { id: 23, labelFr: 'Bleu' }] };

const variant = (id: number, links: [number, number][], extra: Partial<ExistingVariant> = {}): ExistingVariant => ({
  id,
  sku: `OLD-${id}`,
  links: links.map(([optionId, valueId]) => ({ optionId, valueId })),
  active: true,
  isDefault: false,
  referenced: false,
  ...extra,
});

function plan(input: Partial<MatrixInput> & Pick<MatrixInput, 'options'>): MatrixPlan {
  const res = generateMatrix({ existing: [], baseSku: 'HB-POELE', ...input });
  if (!res.ok) throw new Error(`unexpected errors: ${JSON.stringify(res.errors)}`);
  return res.plan;
}

const skus = (p: MatrixPlan): string[] => p.rows.flatMap((r) => (r.kind === 'create' ? [r.sku] : []));

describe('valueCode', () => {
  it('ASCII upper case, no dashes, ≤ 6 chars', () => {
    expect(valueCode('28 cm')).toBe('28CM');
    expect(valueCode('Rouge bordeaux')).toBe('ROUGEB');
    expect(valueCode('أحمر')).toBe('AHMR');
    expect(valueCode('!!!')).toBe('X');
  });
});

describe('generateMatrix: fresh product', () => {
  it('1 option × 1 value', () => {
    const p = plan({ options: [{ id: 1, values: [{ id: 11, labelFr: 'Unique' }] }] });
    expect(p.rows).toEqual([{ kind: 'create', sku: 'HB-POELE-UNIQUE', optionValueIds: [11] }]);
    expect(p.defaultVariant).toEqual({ sku: 'HB-POELE-UNIQUE' });
  });

  it('2 × 3 in option order then value order, unique valid SKUs', () => {
    const p = plan({ options: [size, colour] });
    expect(p.rows.map((r) => r.optionValueIds)).toEqual([
      [11, 21], [11, 22], [11, 23], [12, 21], [12, 22], [12, 23],
    ]);
    expect(skus(p)).toEqual([
      'HB-POELE-28CM-ROUGE', 'HB-POELE-28CM-NOIR', 'HB-POELE-28CM-BLEU',
      'HB-POELE-32CM-ROUGE', 'HB-POELE-32CM-NOIR', 'HB-POELE-32CM-BLEU',
    ]);
    for (const s of skus(p)) expect(SKU_RE.test(s)).toBe(true);
    expect(p.defaultVariant).toEqual({ sku: 'HB-POELE-28CM-ROUGE' });
  });

  it('3 options', () => {
    const other: MatrixOption = { id: 3, values: [{ id: 31, labelFr: 'Inox' }, { id: 32, labelFr: 'Fonte' }] };
    expect(plan({ options: [size, colour, other] }).rows).toHaveLength(12);
  });

  it('is deterministic', () => {
    const input = { options: [size, colour], existing: [variant(5, [[1, 12], [2, 22]])], baseSku: 'hb-poele' };
    expect(generateMatrix(input)).toEqual(generateMatrix(input));
  });
});

describe('generateMatrix: existing variants', () => {
  const full = [
    variant(1, [[1, 11], [2, 21]], { isDefault: true, sku: 'A' }),
    variant(2, [[1, 11], [2, 22]], { sku: 'B' }),
    variant(3, [[1, 12], [2, 21]], { sku: 'C' }),
    variant(4, [[1, 12], [2, 22]], { sku: 'D', active: false }),
  ];
  const twoColours: MatrixOption = { id: 2, values: [{ id: 21, labelFr: 'Rouge' }, { id: 22, labelFr: 'Noir' }] };

  it('keeps matching combinations untouched; reordering values creates nothing', () => {
    const reordered: MatrixOption = { id: 2, values: [{ id: 22, labelFr: 'Noir' }, { id: 21, labelFr: 'Rouge' }] };
    const p = plan({ options: [size, reordered], existing: full });
    expect(p.rows.every((r) => r.kind === 'keep')).toBe(true);
    expect(p.rows.map((r) => (r.kind === 'keep' ? r.variantId : 0))).toEqual([2, 1, 4, 3]);
    expect(p.deleteVariantIds).toEqual([]);
    expect(p.addLinks).toEqual([]);
    expect(p.defaultVariant).toEqual({ variantId: 1 });
  });

  it('adding a value creates only the missing combinations', () => {
    const p = plan({ options: [size, colour], existing: full });
    expect(skus(p)).toEqual(['HB-POELE-28CM-BLEU', 'HB-POELE-32CM-BLEU']);
    expect(p.rows.filter((r) => r.kind === 'keep')).toHaveLength(4);
  });

  it('removing a value deletes its unreferenced variants (and never re-fills them)', () => {
    const onlyRouge: MatrixOption = { id: 2, values: [{ id: 21, labelFr: 'Rouge' }] };
    const p = plan({ options: [size, onlyRouge], existing: full });
    expect(p.deleteVariantIds).toEqual([2, 4]);
    expect(p.rows).toEqual([
      { kind: 'keep', variantId: 1, optionValueIds: [11, 21] },
      { kind: 'keep', variantId: 3, optionValueIds: [12, 21] },
    ]);
  });

  it('removing a value used by a referenced variant is refused', () => {
    const existing = full.map((v) => (v.id === 2 ? { ...v, referenced: true } : v));
    const onlyRouge: MatrixOption = { id: 2, values: [{ id: 21, labelFr: 'Rouge' }] };
    expect(generateMatrix({ options: [size, onlyRouge], existing, baseSku: 'HB-POELE' })).toEqual({
      ok: false,
      errors: [{ code: 'referenced_conflict', variantIds: [2] }],
    });
  });

  it('adding an option: existing variants take the fill value (default: first value)', () => {
    const colourOnly = [variant(1, [[2, 21]], { isDefault: true }), variant(2, [[2, 22]])];
    const p = plan({ options: [size, twoColours], existing: colourOnly });
    expect(p.addLinks).toEqual([{ variantId: 1, optionValueIds: [11] }, { variantId: 2, optionValueIds: [11] }]);
    expect(skus(p)).toEqual(['HB-POELE-32CM-ROUGE', 'HB-POELE-32CM-NOIR']);
    const p2 = plan({ options: [size, twoColours], existing: colourOnly, fill: { 1: 12 } });
    expect(p2.addLinks).toEqual([{ variantId: 1, optionValueIds: [12] }, { variantId: 2, optionValueIds: [12] }]);
    expect(skus(p2)).toEqual(['HB-POELE-28CM-ROUGE', 'HB-POELE-28CM-NOIR']);
  });

  it('simple → variable: the single variant becomes the first combination', () => {
    const p = plan({ options: [size], existing: [variant(9, [], { isDefault: true, sku: 'HB-POELE' })] });
    expect(p.rows[0]).toEqual({ kind: 'keep', variantId: 9, optionValueIds: [11] });
    expect(p.addLinks).toEqual([{ variantId: 9, optionValueIds: [11] }]);
    expect(skus(p)).toEqual(['HB-POELE-32CM']);
    expect(p.defaultVariant).toEqual({ variantId: 9 });
  });

  it('removing an option drops links; collisions keep the best variant and delete the rest', () => {
    const p = plan({ options: [twoColours], existing: full });
    // 1 (default) and 3 both become Rouge; 2 (active) and 4 (inactive) both become Noir.
    expect(p.rows).toEqual([
      { kind: 'keep', variantId: 1, optionValueIds: [21] },
      { kind: 'keep', variantId: 2, optionValueIds: [22] },
    ]);
    expect(p.deleteVariantIds).toEqual([3, 4]);
    expect(p.dropLinks).toEqual([{ variantId: 1, optionValueIds: [11] }, { variantId: 2, optionValueIds: [11] }]);
  });

  it('a referenced variant wins a collision; two referenced ones conflict', () => {
    const ref3 = full.map((v) => (v.id === 3 ? { ...v, referenced: true } : v));
    const p = plan({ options: [twoColours], existing: ref3 });
    expect(p.rows[0]).toEqual({ kind: 'keep', variantId: 3, optionValueIds: [21] });
    expect(p.deleteVariantIds).toEqual([1, 4]);
    expect(p.defaultVariant).toEqual({ variantId: 3 }); // old default 1 was deleted
    const both = ref3.map((v) => (v.id === 1 ? { ...v, referenced: true } : v));
    const res = generateMatrix({ options: [twoColours], existing: both, baseSku: 'HB-POELE' });
    expect(res).toEqual({ ok: false, errors: [{ code: 'referenced_conflict', variantIds: [3] }] }); // 1 (default) is kept, 3 cannot be deleted
  });

  it('corrupt data (two values of one option) is deleted, or refused when referenced', () => {
    const bad = variant(7, [[2, 21], [2, 22]]);
    expect(plan({ options: [twoColours], existing: [bad] }).deleteVariantIds).toEqual([7]);
    const res = generateMatrix({ options: [twoColours], existing: [{ ...bad, referenced: true }], baseSku: 'X' });
    expect(res.ok).toBe(false);
  });

  it('default: inactive current default is replaced by the first active kept variant', () => {
    const existing = [variant(1, [[2, 21]], { isDefault: true, active: false }), variant(2, [[2, 22]])];
    expect(plan({ options: [twoColours], existing }).defaultVariant).toEqual({ variantId: 2 });
  });

  it('default: none when no variant would be active', () => {
    const existing = [variant(1, [[2, 21]], { active: false }), variant(2, [[2, 22]], { active: false })];
    expect(plan({ options: [twoColours], existing }).defaultVariant).toBeNull();
  });
});

describe('generateMatrix: SKUs', () => {
  it('suffixes collisions with own and catalogue SKUs', () => {
    const existing = [variant(1, [[1, 11]], { sku: 'HB-POELE-32CM' })];
    const p = plan({
      options: [{ id: 1, values: [{ id: 11, labelFr: '28 cm' }, { id: 12, labelFr: '32 cm' }, { id: 13, labelFr: '36 cm' }] }],
      existing,
      isSkuTaken: (s) => s === 'HB-POELE-36CM' || s === 'HB-POELE-36CM-2',
    });
    expect(skus(p)).toEqual(['HB-POELE-32CM-2', 'HB-POELE-36CM-3']);
  });

  it('values with the same code get distinct SKUs', () => {
    const o: MatrixOption = { id: 1, values: [{ id: 11, labelFr: 'Rouge clair' }, { id: 12, labelFr: 'Rouge-clair!' }] };
    expect(skus(plan({ options: [o] }))).toEqual(['HB-POELE-ROUGEC', 'HB-POELE-ROUGEC-2']);
  });

  it('caps SKU length and keeps the charset', () => {
    const p = plan({ options: [size, colour], baseSku: 'HB-' + 'X'.repeat(36) });
    for (const s of skus(p)) {
      expect(s.length).toBeLessThanOrEqual(SKU_MAX);
      expect(SKU_RE.test(s)).toBe(true);
    }
    expect(new Set(skus(p)).size).toBe(6);
  });
});

describe('generateMatrix: errors', () => {
  const errs = (input: Partial<MatrixInput> & Pick<MatrixInput, 'options'>) => {
    const res = generateMatrix({ existing: [], baseSku: 'HB-POELE', ...input });
    return res.ok ? [] : res.errors.map((e) => e.code);
  };
  it('no options / empty option / bad base SKU / bad fill', () => {
    expect(errs({ options: [] })).toEqual(['no_options']);
    expect(errs({ options: [{ id: 1, values: [] }] })).toEqual(['empty_option']);
    expect(errs({ options: [size], baseSku: 'hb poele' })).toEqual(['bad_base_sku']);
    expect(errs({ options: [size], fill: { 1: 99 } })).toEqual(['bad_fill']);
  });
  it('limits: options, values per option, combinations', () => {
    const o = (id: number, n: number): MatrixOption => ({
      id,
      values: Array.from({ length: n }, (_, i) => ({ id: id * 100 + i, labelFr: `v${i}` })),
    });
    expect(errs({ options: [o(1, 2), o(2, 2), o(3, 2), o(4, 2)] })).toContain('too_many_options');
    expect(errs({ options: [o(1, MATRIX_LIMITS.maxValuesPerOption + 1)] })).toContain('too_many_values');
    expect(errs({ options: [o(1, 11), o(2, 10)] })).toEqual(['too_many_combinations']);
    expect(errs({ options: [o(1, 10), o(2, 10)] })).toEqual([]);
  });
});
