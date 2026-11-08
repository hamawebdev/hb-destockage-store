// GEO-7: Arabic names checked against the Arabic JO editions. Run: node --test 'data/geo/**/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadWilayas, loadCommunes } from '../index.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const law84 = read('./jo/law-84-09-1984.json');
const ar84 = read('./jo/law-84-09-1984-ar.json');
const wilayas = loadWilayas();
const communes = loadCommunes();
const byId = new Map(communes.map((c) => [c.id, c]));

test('1984 Arabic comparison covers all 31 articles; every listed difference points at a real item', () => {
  assert.deepEqual(ar84.lists.map((l) => l.article), law84.lists.map((l) => l.article));
  for (const l of ar84.lists) {
    const items = law84.lists.find((x) => x.article === l.article).items;
    for (const d of l.differences) {
      assert.ok(d.pos >= 1 && d.pos <= items.length, `art ${l.article} pos ${d.pos}`);
      assert.deepEqual(d.ids, items[d.pos - 1].ids);
      assert.ok(Object.keys(ar84.categories).includes(d.category));
      assert.match(d.printed, /^[ء-ي ]+$/);
    }
  }
});

test('renamed communes (GEO-6) are all recorded as R in the Arabic comparison', () => {
  const renamed = law84.lists.flatMap((l) => l.items.filter((i) => i.match === 'renamed').map((i) => `${l.article}:${i.pos}`));
  const r = new Set(ar84.lists.flatMap((l) => l.differences.filter((d) => d.category === 'R').map((d) => `${l.article}:${d.pos}`)));
  for (const k of renamed) assert.ok(r.has(k), k);
});

test('GEO-7 Arabic fixes are applied', () => {
  const expect = { 169: 'سوق الإثنين', 685: 'خناق مايون', 1157: 'تريفاوي', 1143: 'ميه ونسى', 805: 'ابن باديس الهرية', 1057: 'برج بوعريريج' };
  for (const [id, ar] of Object.entries(expect)) assert.equal(byId.get(+id).name_ar, ar, id);
  assert.equal(wilayas[43].name_ar, 'عين الدفلى');
  assert.equal(wilayas[45].name_ar, 'عين تموشنت');
});

test('no known Arabic typo patterns remain', () => {
  for (const x of [...wilayas, ...communes]) {
    assert.doesNotMatch(x.name_ar, /(^| )لإ/, `${x.id ?? x.code} ${x.name_ar}`);
    assert.doesNotMatch(x.name_ar, /(^| )أبن /, `${x.id ?? x.code} ${x.name_ar}`);
  }
});

test('a wilaya and its same-named chef-lieu commune share the Arabic name (Illizi excepted: JO writes إيليزي)', () => {
  const nf = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, '');
  let checked = 0;
  for (const w of wilayas) {
    const m = communes.filter((c) => c.wilaya_code === w.code && nf(c.name_fr) === nf(w.name_fr));
    if (m.length !== 1 || w.code === 33) continue;
    assert.equal(m[0].name_ar, w.name_ar, `wilaya ${w.code}`);
    checked++;
  }
  assert.ok(checked >= 60, `checked ${checked}`);
});
