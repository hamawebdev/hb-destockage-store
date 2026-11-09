import { describe, expect, test } from 'vitest';
import { formatInt, latinLang, parts, showDevMarkers, t, tp } from '../lib/i18n.ts';

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
  test('goes through shell\'s t(): a missing key fails the build', () => {
    expect(() => t(fr, 'nope')).toThrow(/missing UI string "nope"/);
  });
  test('HB_STRICT_COPY=1: a [PLACEHOLDER] value fails the build and dev markers are off', () => {
    const prev = process.env['HB_STRICT_COPY'];
    try {
      process.env['HB_STRICT_COPY'] = '1';
      expect(() => t({ k: 'x [PLACEHOLDER]' }, 'k')).toThrow(/placeholder/);
      expect(showDevMarkers()).toBe(false);
      delete process.env['HB_STRICT_COPY'];
      expect(t({ k: 'x [PLACEHOLDER]' }, 'k')).toBe('x [PLACEHOLDER]');
      expect(showDevMarkers()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['HB_STRICT_COPY'];
      else process.env['HB_STRICT_COPY'] = prev;
    }
  });
  test('HB_PUBLISH=1 (the deploy pipeline): dev markers are off even without strict copy', () => {
    const prev = process.env['HB_PUBLISH'];
    try {
      process.env['HB_PUBLISH'] = '1';
      expect(showDevMarkers()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['HB_PUBLISH'];
      else process.env['HB_PUBLISH'] = prev;
    }
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
