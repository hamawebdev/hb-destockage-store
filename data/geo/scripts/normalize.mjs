// GEO-2: derive data/geo/wilayas.json and data/geo/communes.json from the pinned upstream
// rows (source/algeria-cities) and source/corrections.json.
// Usage: node data/geo/scripts/normalize.mjs          (writes the two files)
//        node data/geo/scripts/normalize.mjs --check  (exit 1 if the committed files differ)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const geo = new URL('../', import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, geo), 'utf8'));

const cleanFr = (s) => s.replace(/-/g, ' ').replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
// Tatweel (U+0640) is decorative stretching (22 upstream Tizi Ouzou/El Tarf names use it).
const cleanAr = (s) => s.replace(/\u0640/g, '').replace(/\s+/g, ' ').trim();

export function normalize() {
  const upstream = read('source/algeria-cities/algeria_cities.json');
  const corr = read('source/corrections.json');
  const moves = new Map(corr.commune_moves.map((m) => [m.id, m]));
  const names = new Map(corr.commune_names.map((n) => [n.id, n]));
  const wnames = new Map(corr.wilaya_names.map((w) => [w.code, w]));

  const communes = upstream
    .map((r) => {
      const id = Number(r.id);
      const m = moves.get(id);
      const n = names.get(id);
      if (m && m.from !== r.wilaya_code) throw new Error(`move ${id}: upstream code changed`);
      return {
        id,
        wilaya_code: m ? m.to : r.wilaya_code,
        name_ar: cleanAr(n?.name_ar ?? r.commune_name),
        name_fr: cleanFr(n?.name_fr ?? r.commune_name_fr),
      };
    })
    .sort((a, b) => a.id - b.id);

  const wilayas = [];
  for (const r of upstream) {
    if (wilayas[r.wilaya_code]) continue;
    // Upstream labels 11 Touggourt rows with code 30; take Ouargla's name from a row named Ouargla.
    if (r.wilaya_code === 30 && r.wilaya_name_fr !== 'Ouargla') continue;
    const o = wnames.get(r.wilaya_code);
    wilayas[r.wilaya_code] = {
      code: r.wilaya_code,
      name_ar: cleanAr(o?.name_ar ?? r.wilaya_name),
      name_fr: cleanFr(o?.name_fr ?? r.wilaya_name_fr),
    };
  }
  return { wilayas: wilayas.filter(Boolean), communes };
}

// One object per line: diff-friendly, still valid JSON.
export const serialize = (rows) => '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { wilayas, communes } = normalize();
  const out = { 'wilayas.json': serialize(wilayas), 'communes.json': serialize(communes) };
  let stale = false;
  for (const [file, text] of Object.entries(out)) {
    const url = new URL(file, geo);
    if (process.argv.includes('--check')) {
      let cur = '';
      try { cur = readFileSync(url, 'utf8'); } catch {}
      if (cur !== text) { console.error(`${file} is stale: run node data/geo/scripts/normalize.mjs`); stale = true; }
    } else writeFileSync(url, text);
  }
  if (stale) process.exit(1);
  console.log(`wilayas ${wilayas.length}, communes ${communes.length}`);
}
