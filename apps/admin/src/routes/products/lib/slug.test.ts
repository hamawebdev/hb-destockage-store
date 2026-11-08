import { describe, expect, it } from 'vitest';
import { RESERVED_SEGMENTS, SLUG } from '@hb/catalog';
import { checkSlug, slugify, suggestSlug, SLUG_MAX } from './slug.ts';
import { cleanText } from './text.ts';

describe('slugify', () => {
  it('French: strips accents and ligatures, kebab-cases', () => {
    expect(slugify('Poêle à frire 28 cm')).toBe('poele-a-frire-28-cm');
    expect(slugify('  Œuvre — Cœur & Æther  ')).toBe('oeuvre-coeur-aether');
    expect(slugify('Pack 3 en 1 : Colonne piano LED')).toBe('pack-3-en-1-colonne-piano-led');
  });

  it('Arabic: transliterates with the Algerian-French convention', () => {
    expect(slugify('مطبخ')).toBe('mtbkh');
    expect(slugify('الحمام')).toBe('el-hmam');
    expect(slugify('شوكولاطة')).toBe('choukoulata');
    expect(slugify('ڨرنينة')).toBe('grnina');
    expect(slugify('وسادة')).toBe('wsada');
  });

  it('Arabic: drops harakat and tatweel, converts Arabic-Indic digits', () => {
    expect(slugify('مَطْبَـــخ ٣')).toBe('mtbkh-3');
    expect(slugify('طقم ۴ قطع')).toBe('tqm-4-qta');
  });

  it('mixed Arabic + Latin brand', () => {
    expect(slugify('مكنسة Philips')).toBe('mknsa-philips');
  });

  it('always yields a string matching the CAT-1 SLUG pattern or empty', () => {
    for (const s of ['', '---', '!!!', '../../etc/passwd', '%2F', 'a\\b', '.hidden', 'x\u0000y', 'نص', 'Ünïcödé']) {
      const out = slugify(s);
      expect(out === '' || SLUG.test(out)).toBe(true);
    }
    expect(slugify('../../x')).toBe('x');
  });

  it('caps length at a dash boundary', () => {
    const out = slugify('mot '.repeat(40));
    expect(out.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(SLUG.test(out)).toBe(true);
  });
});

describe('checkSlug', () => {
  it('accepts kebab-case, lower-cases input', () => {
    expect(checkSlug(' Poele-28 ')).toEqual({ ok: true, value: 'poele-28' });
  });
  it.each([
    ['', 'required'],
    ['a'.repeat(SLUG_MAX + 1), 'too_long'],
    ['a--b', 'format'],
    ['-a', 'format'],
    ['a/b', 'format'],
    ['../x', 'format'],
    ['%2f', 'format'],
    ['.x', 'format'],
    ['مطبخ', 'format'],
    ['a b', 'format'],
  ])('rejects %j (%s)', (input, error) => {
    expect(checkSlug(input)).toEqual({ ok: false, error });
  });
  it('rejects every reserved segment', () => {
    for (const r of RESERVED_SEGMENTS) {
      const res = checkSlug(r);
      expect(res.ok).toBe(false);
    }
  });
});

describe('suggestSlug', () => {
  it('returns the base when free, else the first free -n', () => {
    const taken = new Set(['poele', 'poele-2']);
    expect(suggestSlug('Poêle', (s) => taken.has(s))).toBe('poele-3');
    expect(suggestSlug('Casserole', (s) => taken.has(s))).toBe('casserole');
  });
  it('never returns a reserved or empty slug', () => {
    expect(suggestSlug('Search', () => false)).toBe('search-1');
    expect(suggestSlug('!!!', () => false, 'categorie')).toBe('categorie');
  });
  it('keeps the suffix within the length cap', () => {
    const long = 'a'.repeat(SLUG_MAX);
    const out = suggestSlug(long, (s) => s === long);
    expect(out.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(out.endsWith('-2')).toBe(true);
    expect(SLUG.test(out)).toBe(true);
  });
});

describe('cleanText', () => {
  it('normalises to NFC, trims, converts CRLF', () => {
    expect(cleanText('  Café ')).toEqual({ ok: true, value: 'Café' });
    expect(cleanText('a\r\nb\rc', { multiline: true })).toEqual({ ok: true, value: 'a\nb\nc' });
  });
  it('rejects bidi controls (RLO, isolates)', () => {
    expect(cleanText('abc‮def')).toEqual({ ok: false, error: 'unsafe_char' });
    expect(cleanText('⁧x⁩')).toEqual({ ok: false, error: 'unsafe_char' });
  });
  it('rejects control characters; newline only when multiline', () => {
    expect(cleanText('a\u0000b')).toEqual({ ok: false, error: 'unsafe_char' });
    expect(cleanText('a\nb')).toEqual({ ok: false, error: 'unsafe_char' });
    expect(cleanText('a\nb', { multiline: true })).toEqual({ ok: true, value: 'a\nb' });
    expect(cleanText('a\u0085b', { multiline: true })).toEqual({ ok: false, error: 'unsafe_char' });
  });
  it('keeps Arabic text and ZWNJ/ZWJ untouched', () => {
    expect(cleanText('مطبخ عصري')).toEqual({ ok: true, value: 'مطبخ عصري' });
  });
});
