import type { OptionProps, PriceProps, VariantProps } from '@hb/catalog';
import { describe, expect, test } from 'vitest';
import { defaultVariant, pickerMode, radioName, swatchFill, variantBlocks, variantByValue } from '../lib/variants.ts';

const price = (n: number): PriceProps => ({ amountDzd: n, label: `${n} DA`, compareAtDzd: null, compareAtLabel: null, discountPercent: null, from: false });
const v = (id: number, ids: number[], stock: number | null, isDefault = false): VariantProps => ({
  id,
  sku: `S-${id}`,
  optionValueIds: ids,
  key: [...ids].sort((a, b) => a - b).join('-'),
  label: '',
  price: price(1000 + id),
  stock: { state: stock === 0 ? 'out_of_stock' : stock !== null && stock <= 3 ? 'low_stock' : 'in_stock', qty: stock },
  imageIndex: null,
  imageIndexes: [],
  isDefault,
  available: stock !== 0,
  maxQty: stock === null ? 10 : Math.min(stock, 10),
});
const size: OptionProps = { id: 1, type: 'size', name: 'Taille', values: [{ id: 11, label: 'M', swatchHex: null, available: true, imageIndexes: [] }, { id: 12, label: 'L', swatchHex: null, available: true, imageIndexes: [] }, { id: 13, label: 'XL', swatchHex: null, available: false, imageIndexes: [] }] };
const colour: OptionProps = { id: 2, type: 'colour', name: 'Couleur', values: [{ id: 21, label: 'Rouge', swatchHex: '#B3261E', available: true, imageIndexes: [] }] };

describe('pickerMode', () => {
  test('one variant ⇒ none', () => expect(pickerMode({ options: [], variants: [v(1, [], 5, true)] })).toBe('none'));
  test('one option ⇒ single, radios named variantId', () => {
    expect(pickerMode({ options: [size], variants: [v(1, [11], 5, true), v(2, [12], 0)] })).toBe('single');
    expect(radioName('single', 1)).toBe('variantId');
  });
  test('two options ⇒ multi, radios named opt.<id>', () => {
    expect(pickerMode({ options: [size, colour], variants: [v(1, [11, 21], 5, true), v(2, [12, 21], 2)] })).toBe('multi');
    expect(radioName('multi', 2)).toBe('opt.2');
  });
});

describe('variantBlocks', () => {
  test('single: one block per value in radio order, undefined where no variant (positional CSS)', () => {
    const vs = [v(2, [12], 0), v(1, [11], 5, true)];
    expect(variantBlocks({ options: [size], variants: vs }).map((b) => b?.id)).toEqual([1, 2, undefined]);
  });
  test('multi: the variants as given', () => {
    const vs = [v(1, [11, 21], 5, true), v(2, [12, 21], 2)];
    expect(variantBlocks({ options: [size, colour], variants: vs })).toEqual(vs);
  });
});

describe('helpers', () => {
  test('defaultVariant prefers isDefault, else the first', () => {
    expect(defaultVariant([v(1, [], 1), v(2, [], 1, true)])?.id).toBe(2);
    expect(defaultVariant([v(1, [], 1)])?.id).toBe(1);
  });
  test('variantByValue maps value ids', () => {
    expect(variantByValue([v(1, [11], 1), v(2, [12], 1)]).get(12)?.id).toBe(2);
  });
  test('swatchFill accepts #rrggbb only (presentation attribute, nothing else interpolated)', () => {
    expect(swatchFill('#B3261E')).toBe('#b3261e');
    expect(swatchFill('red')).toBeNull();
    expect(swatchFill('#fff')).toBeNull();
    expect(swatchFill('#000000"/><script>')).toBeNull();
    expect(swatchFill(null)).toBeNull();
  });
});
