import { describe, expect, test } from 'vitest';
import { formatInt, latinLang, parts, t, tp } from '../lib/i18n.ts';

const fr = {
  'a.plain': 'Bonjour',
  'a.var': 'Page {n} sur {total}',
  'price.from': 'À partir de {price}',
  'n.one': '{count} produit',
  'n.other': '{count} produits',
};
const ar = {
  'n.zero': '{count} منتج',
  'n.one': 'منتج واحد',
  'n.two': 'منتجان',
  'n.few': '{count} منتجات',
  'n.many': '{count} منتجًا',
  'n.other': '{count} منتج',
};

describe('t', () => {
  test('returns the string, fills variables, leaves unknown ones', () => {
    expect(t(fr, 'a.plain')).toBe('Bonjour');
    expect(t(fr, 'a.var', { n: 2, total: 3 })).toBe('Page 2 sur 3');
    expect(t(fr, 'a.var', { n: 2 })).toBe('Page 2 sur {total}');
  });
  test('a missing key is visible, never empty', () => {
    expect(t(fr, 'nope')).toBe('⟦nope⟧');
  });
});

describe('parts', () => {
  test('splits around one variable', () => {
    expect(parts(fr, 'price.from', 'price')).toEqual({ before: 'À partir de ', after: '' });
    expect(parts(fr, 'a.plain', 'price')).toEqual({ before: 'Bonjour', after: '' });
  });
});

describe('tp (Intl.PluralRules)', () => {
  test('French one/other with a formatted count', () => {
    expect(tp(fr, 'fr', 'n', 1)).toBe('1 produit');
    expect(tp(fr, 'fr', 'n', 0)).toBe('0 produit');
    expect(tp(fr, 'fr', 'n', 1200)).toBe('1 200 produits');
  });
  test('Arabic six forms, Western digits', () => {
    expect(tp(ar, 'ar', 'n', 0)).toBe('0 منتج');
    expect(tp(ar, 'ar', 'n', 1)).toBe('منتج واحد');
    expect(tp(ar, 'ar', 'n', 2)).toBe('منتجان');
    expect(tp(ar, 'ar', 'n', 5)).toBe('5 منتجات');
    expect(tp(ar, 'ar', 'n', 11)).toBe('11 منتجًا');
    expect(tp(ar, 'ar', 'n', 100)).toBe('100 منتج');
  });
  test('falls back to .other when a form is missing', () => {
    expect(tp({ 'x.other': '{count} x' }, 'ar', 'x', 2)).toBe('2 x');
  });
});

describe('formatInt / latinLang', () => {
  test('ar-DZ uses Western digits with . grouping; fr-DZ a narrow space', () => {
    expect(formatInt('ar', 14600)).toBe('14.600');
    expect(formatInt('fr', 14600)).toBe('14 600');
  });
  test('Latin names carry lang only on Arabic pages', () => {
    expect(latinLang('ar')).toBe('fr');
    expect(latinLang('fr')).toBeUndefined();
  });
});
