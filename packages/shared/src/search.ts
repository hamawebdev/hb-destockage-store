/**
 * Search folding shared by the storefront commune/wilaya picker, product search, admin customer
 * search and order dedup (task #156). Ported line for line from GEO-5 `data/geo/search.mjs`
 * (`normalizeForSearch`, `searchKey`; last changed in GEO-5 r1 3eb06f1, identical at team/geo
 * 7c9c1c8); behaviour is identical, pinned by GEO-5's 505-row parity corpus taken from team/geo
 * 7c9c1c8 (test/fixtures/search.corpus.json).
 *
 * Contract (unchanged from GEO-5): fold each name once with `searchKey(name)` (index side), fold
 * what the customer types with `foldForSearch(query)`, and show the name when
 * `key.includes(query)`. Folding never rewrites or drops a word, so every prefix the customer
 * types stays inside the key; spelling alternatives live only in the key.
 *
 * What folding does: Unicode NFD then strip combining marks (Latin diacritics, Arabic tashkeel,
 * hamza/madda marks — so أ إ آ → ا, ؤ → و, ئ → ي), lower-case, tatweel removed, œ/æ/ß spelled
 * out, Maghrebi/Persian letter variants (ڨ ڧ → ق, ڢ → ف, ک → ك, ى ی → ي, ٱ → ا), ta marbuta
 * ة → ه, Eastern Arabic/Persian digits → ASCII, apostrophes join (M'Sila ≡ Msila), every other
 * non-letter/digit run → one space, trimmed. The Arabic article ال is kept (stripping it breaks
 * إليزي vs typed اليزي). Rules are script-based: `lang` is accepted for API stability and unused.
 *
 * Dependency-free and side-effect free; runs in Workers, Node and the browser.
 */

import type { Lang } from './lang.ts';

/** Fold a name or a query for matching. Never drops or rewrites a word. `null`/`undefined` → ''. */
export function foldForSearch(text: string | null | undefined, _lang?: Lang): string {
  return String(text ?? '')
    .normalize('NFD') // أ إ آ ؤ ئ → base letter + hamza/madda mark; é → e + accent
    .toLowerCase()
    .replace(/[\u0300-\u036f\u0640\u064b-\u065f\u0670]/g, '') // Latin diacritics, tatweel, tashkeel, hamza/madda marks
    .replace(/\u0153/g, 'oe')
    .replace(/\u00e6/g, 'ae')
    .replace(/\u00df/g, 'ss')
    .replace(/[\u06a7\u06a8]/g, '\u0642') // Maghrebi ڨ ڧ → ق
    .replace(/\u06a2/g, '\u0641') // ڢ → ف
    .replace(/\u06a9/g, '\u0643') // Persian ک → ك
    .replace(/[\u0649\u06cc]/g, '\u064a') // ى ی → ي
    .replace(/\u0671/g, '\u0627') // ٱ → ا
    .replace(/\u0629/g, '\u0647') // ة → ه
    .replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) & 15)) // Eastern Arabic / Persian digits → ASCII
    .replace(/['`\u2019\u02bc]/g, '') // apostrophes join: M'Sila ≡ Msila
    .replace(/[^a-z0-9\u0621-\u064a]+/g, ' ') // hyphens, punctuation, any other symbol → one space
    .trim();
}

/**
 * Index key for a name: its folded form plus spelling alternatives, joined by "|" (which never
 * appears in a folded query). Match with `searchKey(name).includes(foldForSearch(query))`.
 */
export function searchKey(name: string | null | undefined, lang?: Lang): string {
  const k = foldForSearch(name, lang);
  const alt = [
    k.replace(/^(el|al|ech|es|ed|er|et|ez|en) /, '$1'), // El Oued → also "eloued"
    k.replace(/^in /, 'ain '), // In Salah → also "ain salah" ("in salah" is already inside "ain salah")
    k.replace(/^\u0627\u0646 /, '\u0639\u064a\u0646 '), // إن صالح → also "عين صالح"
  ].filter((a) => a !== k);
  return [k, ...alt].join('|');
}

/** True when `name` should be shown for what the customer typed (the picker's match rule). */
export function matchesSearch(name: string | null | undefined, query: string | null | undefined, lang?: Lang): boolean {
  return searchKey(name, lang).includes(foldForSearch(query, lang));
}
