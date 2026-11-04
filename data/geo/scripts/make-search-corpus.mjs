// GEO-5: regenerate data/geo/search.corpus.json (golden input → {out: normalizeForSearch,
// key: searchKey} for ports). Usage: node data/geo/scripts/make-search-corpus.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeForSearch, searchKey } from '../search.mjs';
import { loadWilayas, loadCommunes } from '../index.mjs';

export const EDGE_CASES = [
  ['El-Oued', 'fr'], ['el oued', 'fr'], ['EL OUED', 'fr'], ['eloued', 'fr'], ['el', 'fr'], ['el ', 'fr'], ['el o', 'fr'],
  ['In Salah', 'fr'], ['Ain Salah', 'fr'], ['Aïn Salah', 'fr'], ['ayn salah', 'fr'], ['in', 'fr'],
  ["M'Sila", 'fr'], ['M’Sila', 'fr'], ['Msila', 'fr'], ["L'Arbaa", 'fr'], ['Ech Chorfa', 'fr'], ['Es Senia', 'fr'],
  ['Béjaïa', 'fr'], ['BÉJAÏA', 'fr'], ['Tizi-Ouzou', 'fr'], ['  Bordj — Bou  Arreridj !! ', 'fr'], ['Œuvre', 'fr'],
  ['الوادي', 'ar'], ['وادي', 'ar'], ['الو', 'ar'], ['ال', 'ar'], ['ٱلجزائر', 'ar'], ['الجزائر', 'ar'], ['الجزاير', 'ar'],
  ['إن صالح', 'ar'], ['ان صالح', 'ar'], ['عين صالح', 'ar'], ['أولاد جلال', 'ar'], ['اولاد جلال', 'ar'],
  ['مُسْتَغَانِم', 'ar'], ['قسنطينـــة', 'ar'], ['قسنطينة', 'ar'], ['قسنطينه', 'ar'], ['سيدى بلعباس', 'ar'], ['سيدي بلعباس', 'ar'],
  ['مؤسسة', 'ar'], ['بئر العاتر', 'ar'], ['آفلو', 'ar'], ['أفلو', 'ar'], ['إليزي', 'ar'],
  ['٠١٦', 'ar'], ['۱۶', 'ar'], ['16 - الجزائر', 'ar'], ['16 - Alger', 'fr'], ['', 'fr'], ['   ', 'ar'],
  ['Cuiseur à œufs', 'fr'], ['Æ', 'fr'], ['ß', 'fr'], ['ورڨلة', 'ar'], ['ڢ', 'ar'], ['بسکرة', 'ar'], ['سیدی', 'ar'],
];

export function corpus() {
  const out = [];
  const add = (input, lang) => out.push({ in: input, lang, out: normalizeForSearch(input, lang), key: searchKey(input, lang) });
  for (const [s, l] of EDGE_CASES) add(s, l);
  for (const w of loadWilayas()) { add(w.name_ar, 'ar'); add(w.name_fr, 'fr'); }
  // Every 10th commune: a spread over all wilayas and spelling styles.
  for (const c of loadCommunes().filter((c) => c.id % 10 === 0)) { add(c.name_ar, 'ar'); add(c.name_fr, 'fr'); }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = corpus();
  writeFileSync(new URL('../search.corpus.json', import.meta.url), '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n');
  console.log(`${rows.length} cases`);
}
