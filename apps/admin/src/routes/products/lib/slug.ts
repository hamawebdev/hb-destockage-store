/**
 * Slugs for categories, products and content pages (ACAT-0 plan §2, §2.1).
 *
 * Contract (DB-1 CHECK + CAT-1 `SLUG`): ASCII kebab-case in both languages, Arabic transliterated,
 * not a reserved first URL segment. Validity is decided by `@hb/catalog` (imported, not copied);
 * this module only adds the length cap and the suggestion helpers. Pure, no I/O.
 */
import { RESERVED_SEGMENTS, SLUG } from '@hb/catalog';

export const SLUG_MAX = 80;

export type SlugError = 'required' | 'too_long' | 'format' | 'reserved';

export function checkSlug(input: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: SlugError } {
  const value = input.trim().toLowerCase();
  if (value === '') return { ok: false, error: 'required' };
  if (value.length > SLUG_MAX) return { ok: false, error: 'too_long' };
  if (!SLUG.test(value)) return { ok: false, error: 'format' };
  if (RESERVED_SEGMENTS.includes(value)) return { ok: false, error: 'reserved' };
  return { ok: true, value };
}

/**
 * Arabic → Latin, Algerian-French convention (ACAT-0 §2.1). Short vowels are not written in
 * Arabic, so the result is a suggestion the editor can change.
 */
const AR_TO_LATIN: Readonly<Record<string, string>> = {
  'ا': 'a', 'أ': 'a', 'إ': 'i', 'آ': 'a', 'ء': '', 'ئ': 'i', 'ؤ': 'ou', 'ٱ': 'a',
  'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'dj', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'dh',
  'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'ch', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'dh',
  'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n',
  'ه': 'h', 'ة': 'a', 'ى': 'a', 'و': 'ou', 'ي': 'i',
  // Algerian letters.
  'ڨ': 'g', 'ڢ': 'v', 'ڤ': 'v', 'ڧ': 'q', 'پ': 'p', 'چ': 'tch', 'گ': 'g',
};

/** Harakat, superscript alef, tatweel: dropped. */
const AR_MARKS = /[ً-ٰٟـ]/gu;
const AR_DIGITS = /[٠-٩۰-۹]/gu;

function arabicDigitToAscii(d: string): string {
  const cp = d.codePointAt(0) ?? 0;
  return String(cp >= 0x06f0 ? cp - 0x06f0 : cp - 0x0660);
}

function transliterateArabicWord(word: string): string {
  // Definite article at word start: «ال» → "el-".
  let prefix = '';
  let w = word;
  if (w.length > 2 && w.startsWith('ال')) {
    prefix = 'el-';
    w = w.slice(2);
  }
  let out = '';
  for (const [i, ch] of [...w].entries()) {
    if (ch === 'و' && i === 0) out += 'w';
    else if (ch === 'ي' && i === 0) out += 'y';
    else out += AR_TO_LATIN[ch] ?? ch;
  }
  return prefix + out;
}

/** Lower-case ASCII kebab-case from any text (French, Arabic, mixed). May return ''. */
export function slugify(text: string): string {
  const arabicDone = text
    .normalize('NFC')
    .replace(AR_MARKS, '')
    .replace(AR_DIGITS, arabicDigitToAscii)
    .split(/(\s+)/u)
    .map((part) => (/[؀-ۿ]/u.test(part) ? transliterateArabicWord(part) : part))
    .join('');
  const ascii = arabicDone
    .replace(/œ/g, 'oe').replace(/Œ/g, 'oe').replace(/æ/g, 'ae').replace(/Æ/g, 'ae').replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length <= SLUG_MAX) return ascii;
  const cut = ascii.slice(0, SLUG_MAX);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

/**
 * Suggests a free slug: `base`, then `base-2`, `base-3`… `isTaken` reports collisions for the
 * entity type and language (the unique index stays the final arbiter). Reserved or empty bases
 * get a `-1` style suffix so the result is always valid.
 */
export function suggestSlug(text: string, isTaken: (slug: string) => boolean, fallback = 'item'): string {
  let base = slugify(text);
  if (base === '') base = fallback;
  if (RESERVED_SEGMENTS.includes(base)) base = `${base}-1`;
  const fit = (s: string, suffix: string): string => {
    const room = SLUG_MAX - suffix.length;
    return (s.length > room ? s.slice(0, room).replace(/-+$/, '') : s) + suffix;
  };
  if (!isTaken(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const candidate = fit(base, `-${n}`);
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error('suggestSlug: no free slug');
}
