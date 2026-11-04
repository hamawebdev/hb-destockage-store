// GEO-5: search normalisation shared by the commune/wilaya pickers (orderform), the product
// search page (pages) and the search index (pagedata). Dependency-free; port it line for line.
//
// Contract: build each name's key with searchKey(name) (once, at build time or on load), fold
// what the customer types with normalizeForSearch(query), and show the name when
// key.includes(query). Folding never rewrites or drops a word, so every prefix the customer
// types stays inside the key (tested for all 1,541 communes and 69 wilayas, both languages);
// spelling alternatives live only in the key. Rules are script-based: `lang` is accepted for
// API stability and unused. Parity corpus: search.corpus.json.
export function normalizeForSearch(s, lang) {
  return String(s ?? '')
    .normalize('NFD') // أ إ آ ؤ ئ → base letter + hamza/madda mark; é → e + accent
    .toLowerCase()
    .replace(/[\u0300-\u036f\u0640\u064b-\u065f\u0670]/g, '') // Latin diacritics, tatweel, tashkeel, hamza/madda marks
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/ß/g, 'ss')
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

/** Index key for a name: its folded form plus spelling alternatives, joined by "|" (never in a query). */
export function searchKey(name, lang) {
  const k = normalizeForSearch(name, lang);
  const alt = [
    k.replace(/^(el|al|ech|es|ed|er|et|ez|en) /, '$1'), // El Oued → also "eloued"
    k.replace(/^in /, 'ain '), // In Salah → also "ain salah" ("in salah" is already inside "ain salah")
    k.replace(/^\u0627\u0646 /, '\u0639\u064a\u0646 '), // إن صالح → also "عين صالح"
  ].filter((a) => a !== k);
  return [k, ...alt].join('|');
}
