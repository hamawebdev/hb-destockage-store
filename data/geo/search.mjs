// GEO-5: search normalisation shared by the commune/wilaya pickers (orderform), the product
// search page (pages) and the search index (pagedata). Dependency-free; port it line for line.
// Rules are script-based, so a Latin query on /ar/ behaves like one on /fr/; `lang` is accepted
// for API stability and currently unused. Parity corpus: search.corpus.json.
// Match with key.includes(query): the Arabic article ال is kept (stripping it would turn the
// query اليزي into يزي while the key for إليزي stays اليزي), and substring matching already finds
// وادي inside الوادي.
export function normalizeForSearch(s, lang) {
  return String(s ?? '')
    .normalize('NFD') // أ إ آ ؤ ئ → base letter + hamza/madda mark; é → e + accent
    .toLowerCase()
    .replace(/[\u0300-\u036f\u0640\u064b-\u065f\u0670]/g, '') // Latin diacritics, tatweel, tashkeel, hamza/madda marks
    .replace(/\u0671/g, '\u0627') // ٱ → ا
    .replace(/\u0649/g, '\u064a') // ى → ي
    .replace(/\u0629/g, '\u0647') // ة → ه
    .replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (d) => d.charCodeAt(0) & 15) // Eastern Arabic / Persian digits → ASCII
    .replace(/['`\u2019\u02bc]/g, '') // apostrophes join: M'Sila ≡ Msila
    .replace(/[^a-z0-9\u0621-\u064a]+/g, ' ') // hyphens, punctuation, any other symbol → one space
    .trim()
    .replace(/^(el|al|ech|es|ed|er|et|ez|en) (?=.)/, '') // El Oued ≡ Oued (first word, only if another follows)
    .replace(/^(in|ayn) (?=.)/, 'ain ') // In Salah ≡ Ain Salah
    .replace(/^\u0627\u0646 (?=.)/, '\u0639\u064a\u0646 '); // إن صالح ≡ عين صالح
}
