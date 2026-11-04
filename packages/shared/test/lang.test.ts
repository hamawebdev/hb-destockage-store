import { describe, expect, test } from 'vitest';
import { DEFAULT_LANG, LANGS, dirOf, intlLocale, isLang, localizedFromRow, pick } from '../src/lang.ts';

describe('lang', () => {
  test('languages, default and direction', () => {
    expect(LANGS).toEqual(['ar', 'fr']);
    expect(DEFAULT_LANG).toBe('ar');
    expect(dirOf('ar')).toBe('rtl');
    expect(dirOf('fr')).toBe('ltr');
    expect(intlLocale('ar')).toBe('ar-DZ');
    expect(intlLocale('fr')).toBe('fr-DZ');
  });

  test('isLang', () => {
    expect(isLang('ar')).toBe(true);
    expect(isLang('fr')).toBe(true);
    for (const x of ['en', 'AR', '', null, undefined, 1]) expect(isLang(x)).toBe(false);
  });

  test('pick and localizedFromRow', () => {
    const row = { id: 1, name_ar: 'طقم أواني', name_fr: 'Batterie de cuisine' };
    const name = localizedFromRow(row, 'name');
    expect(name).toEqual({ ar: 'طقم أواني', fr: 'Batterie de cuisine' });
    expect(pick(name, 'ar')).toBe('طقم أواني');
    expect(pick(name, 'fr')).toBe('Batterie de cuisine');
  });
});
