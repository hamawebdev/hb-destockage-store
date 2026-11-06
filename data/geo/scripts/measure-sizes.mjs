// GEO-3: measure the per-wilaya commune files (raw / gzip -9 / brotli q11 and q5) and compare
// with the single-file-both-names alternative. Usage: node data/geo/scripts/measure-sizes.mjs <out.md>
import { writeFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { geoAssets } from '../build.mjs';
import { loadWilayas, loadCommunes } from '../index.mjs';

const br = (b, q) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: q } }).length;
const size = (s) => { const b = Buffer.from(s); return [b.length, gzipSync(b, { level: 9 }).length, br(b, 11), br(b, 5)]; };
const add = (a, b) => a.map((v, i) => v + b[i]);
const fmt = (r) => r.map((v) => v.toLocaleString('en')).join(' | ');
const out = [];
const per = {};
for (const lang of ['ar', 'fr']) {
  per[lang] = geoAssets(lang).communes.map(({ code, list }) => ({ code, n: list.length, s: size(JSON.stringify(list)) }));
}
const wilayas = loadWilayas();
const communes = loadCommunes();
const ca = new Intl.Collator('ar');
const both = wilayas.map((w) => size(JSON.stringify(communes.filter((c) => c.wilaya_code === w.code).sort((a, b) => ca.compare(a.name_ar, b.name_ar)).map((c) => [c.id, c.name_ar, c.name_fr]))));
const total = (rows) => rows.reduce((a, r) => add(a, r), [0, 0, 0, 0]);
const max = (rows, i) => Math.max(...rows.map((r) => r[i]));
const inline = {};
for (const lang of ['ar', 'fr']) inline[lang] = size(JSON.stringify(geoAssets(lang).wilayas));

out.push('# GEO-3 — commune data sizes', '', `Measured ${new Date().toISOString().slice(0, 10)} with \`node data/geo/scripts/measure-sizes.mjs\` (Node ${process.version}, zlib). Bytes. gzip = level 9; br11 = brotli quality 11 (what a pre-compressed asset gets); br5 = brotli quality 5 (closer to on-the-fly edge compression). One file is fetched per wilaya choice, after LCP.`, '');
out.push('## Summary', '', '| Layout | Files | Total raw | gzip | br11 | br5 | Largest file br11 | Mean file br11 |', '|---|---|---|---|---|---|---|---|');
for (const lang of ['ar', 'fr']) {
  const rows = per[lang].map((r) => r.s); const t = total(rows);
  out.push(`| **Chosen:** per language \`geo/communes/${lang}/{code}.json\` = \`[[id,"name"],…]\` | 69 | ${fmt(t)} | ${max(rows, 2)} | ${Math.round(t[2] / 69)} |`);
}
{ const t = total(both); out.push(`| Alternative: one file per wilaya with both names \`[[id,"ar","fr"],…]\` | 69 | ${fmt(t)} | ${max(both, 2)} | ${Math.round(t[2] / 69)} |`); }
out.push('', 'A visitor only ever needs one language, so the per-language files cost 41–44 % fewer brotli bytes per fetch than the both-names file, and need no client-side re-sort for French.', '');
out.push('## Wilaya options (inlined in the order form)', '', '| Lang | raw | gzip | br11 | br5 |', '|---|---|---|---|---|');
for (const lang of ['ar', 'fr']) out.push(`| ${lang} | ${fmt(inline[lang])} |`);
out.push('', 'Inlined in the HTML document these bytes are compressed together with the page, so the marginal cost is lower than the standalone figure.', '');
out.push('## Per file', '', '| Code | Wilaya | Communes | ar raw | ar gzip | ar br11 | ar br5 | fr raw | fr gzip | fr br11 | fr br5 |', '|---|---|---|---|---|---|---|---|---|---|---|');
for (let i = 0; i < 69; i++) out.push(`| ${i + 1} | ${wilayas[i].name_fr} | ${per.ar[i].n} | ${fmt(per.ar[i].s)} | ${fmt(per.fr[i].s)} |`);
writeFileSync(process.argv[2], out.join('\n') + '\n');
console.log(out.slice(0, 12).join('\n'));
