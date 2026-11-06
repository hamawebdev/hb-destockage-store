/**
 * Search folding shared by the storefront commune/wilaya picker, product search, admin customer
 * search and order dedup (task #156). Ported line for line from GEO-5 `data/geo/search.mjs`
 * @3eb06f1 (`normalizeForSearch`, `searchKey`); behaviour is identical, pinned by GEO-5's
 * 505-row parity corpus (test/fixtures/search.corpus.json).
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
    .replace(/[̀-ͯـً-ٰٟ]/g, '') // Latin diacritics, tatweel, tashkeel, hamza/madda marks
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/[ڧڨ]/g, 'ق') // Maghrebi ڨ ڧ → ق
    .replace(/ڢ/g, 'ف') // ڢ → ف
    .replace(/ک/g, 'ك') // Persian ک → ك
    .replace(/[ىی]/g, 'ي') // ى ی → ي
    .replace(/ٱ/g, 'ا') // ٱ → ا
    .replace(/ة/g, 'ه') // ة → ه
    .replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) & 15)) // Eastern Arabic / Persian digits → ASCII
    .replace(/['`’ʼ]/g, '') // apostrophes join: M'Sila ≡ Msila
    .replace(/[^a-z0-9ء-ي]+/g, ' ') // hyphens, punctuation, any other symbol → one space
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
    k.replace(/^ان /, 'عين '), // إن صالح → also "عين صالح"
  ].filter((a) => a !== k);
  return [k, ...alt].join('|');
}

/** True when `name` should be shown for what the customer typed (the picker's match rule). */
export function matchesSearch(name: string | null | undefined, query: string | null | undefined, lang?: Lang): boolean {
  return searchKey(name, lang).includes(foldForSearch(query, lang));
}
