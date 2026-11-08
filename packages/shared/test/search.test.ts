/**
 * #156 — foldForSearch / searchKey, ported from GEO-5 data/geo/search.test.mjs (3eb06f1).
 * Fixtures, both from team/geo 7c9c1c8: search.corpus.json = GEO-5's 505-row parity corpus
 * (verbatim); geo-names.json = the 69 wilaya and 1,541 commune names in both languages.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { foldForSearch as n, matchesSearch, searchKey } from '../src/search.ts';

const load = <T>(f: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')) as T;
type Row = { in: string; lang: 'ar' | 'fr'; out: string; key: string };
type Names = {
  wilayas: { code: number; name_fr: string; name_ar: string }[];
  communes: { id: number; wilaya_code: number; name_fr: string; name_ar: string }[];
};
const corpus = load<Row[]>('search.corpus.json');
const geo = load<Names>('geo-names.json');

const same = (...xs: string[]): string => {
  const k = n(xs[0]);
  for (const x of xs) expect(n(x), `${x} → ${n(x)} ≠ ${k}`).toBe(k);
  return k;
};
const finds = (name: string, query: string): boolean => matchesSearch(name, query);

test('French folding: case, diacritics, hyphens, apostrophes, ligatures; no word dropped', () => {
  expect(same('El Oued', 'El-Oued', 'el oued', 'EL OUED')).toBe('el oued');
  expect(same("M'Sila", 'M’Sila', 'Msila', 'MSILA')).toBe('msila');
  expect(same('Béjaïa', 'Bejaia', 'BÉJAÏA')).toBe('bejaia');
  expect(same('Aïn Salah', 'Ain Salah')).toBe('ain salah');
  expect(n('Tizi-Ouzou')).toBe('tizi ouzou');
  expect(n('  Bordj — Bou  Arreridj !! ')).toBe('bordj bou arreridj');
  expect(same('Cuiseur à œufs', 'cuiseur a oeufs')).toBe('cuiseur a oeufs');
  expect(n('Æ ß')).toBe('ae ss');
});

test('Arabic folding: tashkeel, tatweel, alef/hamza, ى/ی, ة, ؤ, ئ, ٱ, ڨ/ڧ/ڢ, ک', () => {
  expect(same('مُسْتَغَانِم', 'مستغانم')).toBe('مستغانم');
  expect(same('قسنطينـــة', 'قسنطينة', 'قسنطينه')).toBe('قسنطينه');
  expect(same('أفلو', 'آفلو', 'افلو')).toBe('افلو');
  expect(same('إليزي', 'اليزي')).toBe('اليزي');
  expect(same('سيدى بلعباس', 'سيدي بلعباس', 'سیدی بلعباس')).toBe('سيدي بلعباس');
  expect(n('مؤسسة')).toBe('موسسه');
  expect(same('ٱلجزائر', 'الجزائر', 'الجزاير')).toBe('الجزاير');
  expect(same('ورڨلة', 'ورقلة')).toBe('ورقله');
  expect(same('بسکرة', 'بسكرة')).toBe('بسكره');
  expect(n('ڢ')).toBe('ف');
});

test('digits, empty input, lang is optional and unused, always a string', () => {
  expect(n('٠١٦')).toBe('016');
  expect(n('۱۶')).toBe('16');
  expect(n('16 - الجزائر', 'ar')).toBe('16 الجزاير');
  expect(n('')).toBe('');
  expect(n('   ')).toBe('');
  expect(n(undefined)).toBe('');
  expect(n(null)).toBe('');
  expect(n('Oran', 'fr')).toBe(n('Oran', 'ar'));
  expect(typeof n('٣')).toBe('string');
});

test('searchKey: spelling alternatives (article glued, In ≡ Ain, إن ≡ عين); "|" never appears in a query', () => {
  expect(finds('El Oued', 'eloued')).toBe(true);
  expect(finds('El Oued', 'oued')).toBe(true);
  expect(finds('In Salah', 'Ain Salah')).toBe(true);
  expect(finds('In Salah', 'Aïn Sal')).toBe(true);
  expect(finds('Ain Salah', 'In Salah')).toBe(true);
  expect(finds('إن صالح', 'عين صالح')).toBe(true);
  expect(finds('الوادي', 'وادي')).toBe(true);
  expect(finds('Oran', 'alger')).toBe(false);
  expect(n('a|b')).not.toContain('|');
});

describe('GEO-5 parity corpus (505 rows, verbatim)', () => {
  test('size', () => expect(corpus).toHaveLength(505));
  test.each(corpus.map((r) => [JSON.stringify(r.in), r] as const))('%s', (_label, r) => {
    expect(n(r.in, r.lang)).toBe(r.out);
    expect(searchKey(r.in, r.lang)).toBe(r.key);
  });
});

describe('geo names (team/geo 7c9c1c8)', () => {
  const names = [...geo.wilayas, ...geo.communes];
  test('fixture is complete', () => {
    expect(geo.wilayas).toHaveLength(69);
    expect(geo.communes).toHaveLength(1541);
  });

  test('typing any prefix of any wilaya or commune name keeps that name selected (both languages)', () => {
    let checked = 0;
    for (const key of ['name_fr', 'name_ar'] as const) {
      for (const r of names) {
        const name = r[key];
        const k = searchKey(name);
        const chars = [...name];
        for (let i = 1; i <= chars.length; i++) {
          const p = chars.slice(0, i).join('');
          if (!k.includes(n(p))) expect.fail(`${key} "${name}" lost at "${p}" (${n(p)} ∉ ${k})`);
          checked++;
        }
      }
    }
    expect(checked).toBe(28_002); // every prefix of every name, both languages (fixture is pinned)
  });

  test('every wilaya key is distinct per language; commune keys distinct within each wilaya', () => {
    for (const key of ['name_ar', 'name_fr'] as const) {
      expect(new Set(geo.wilayas.map((w) => n(w[key]))).size, key).toBe(69);
      const seen = new Map<string, number>();
      for (const c of geo.communes) {
        const k = `${c.wilaya_code}|${n(c[key])}`;
        if (seen.has(k)) expect.fail(`${key} ${c.id} collides with ${seen.get(k)}: ${k}`);
        seen.set(k, c.id);
      }
    }
  });
});

test('customer-search and dedup use: same person typed differently folds to one key', () => {
  // Names as typed into the order form, compared by admin search / dedup.
  expect(same('محمد أمين', 'محمد امين', 'مُحمّد  أمين', 'محمـــد امين')).toBe('محمد امين');
  expect(same('Amine Benali', 'amine  benali', 'AMINE BENALI', 'Amine Bénali')).toBe('amine benali');
  expect(same('فاطمة الزهراء', 'فاطمه الزهراء')).toBe('فاطمه الزهراء');
});
