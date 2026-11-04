// GEO-2: normalised wilaya and commune data. Run: node --test 'data/geo/**/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadWilayas, loadCommunes } from './index.mjs';
import { normalize, serialize } from './scripts/normalize.mjs';

const wilayas = loadWilayas();
const communes = loadCommunes();
const official = JSON.parse(readFileSync(new URL('./source/jo/official-lists.json', import.meta.url), 'utf8'));

const ARABIC = /^[ء-غف-ي]+(?:[ ()]+[ء-غف-ي]+)*\)?$/;
const LATIN = /^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[ '()]+[A-Za-zÀ-ÖØ-öø-ÿ]+)*\)?$/;
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-zء-ي]+/g, ' ').trim();

test('committed files equal the generator output', () => {
  const { wilayas: w, communes: c } = normalize();
  assert.equal(readFileSync(new URL('./wilayas.json', import.meta.url), 'utf8'), serialize(w));
  assert.equal(readFileSync(new URL('./communes.json', import.meta.url), 'utf8'), serialize(c));
});

test('69 wilayas with codes 1-69 in order', () => {
  assert.equal(wilayas.length, 69);
  wilayas.forEach((w, i) => assert.equal(w.code, i + 1));
  for (const w of wilayas) assert.deepEqual(Object.keys(w), ['code', 'name_ar', 'name_fr']);
});

test('1,541 communes with unique integer ids', () => {
  assert.equal(communes.length, 1541);
  assert.equal(new Set(communes.map((c) => c.id)).size, 1541);
  for (const c of communes) {
    assert.ok(Number.isInteger(c.id) && c.id > 0);
    assert.deepEqual(Object.keys(c), ['id', 'wilaya_code', 'name_ar', 'name_fr']);
  }
});

test('every commune belongs to an existing wilaya, and every wilaya has communes', () => {
  const codes = new Set(wilayas.map((w) => w.code));
  for (const c of communes) assert.ok(codes.has(c.wilaya_code), `commune ${c.id}`);
  for (const w of wilayas) assert.ok(communes.some((c) => c.wilaya_code === w.code), `wilaya ${w.code} empty`);
});

test('no empty names; Arabic names in Arabic script, French names in Latin script', () => {
  for (const x of [...wilayas, ...communes]) {
    const tag = x.id ?? `w${x.code}`;
    assert.match(x.name_ar, ARABIC, `ar ${tag}: ${x.name_ar}`);
    assert.match(x.name_fr, LATIN, `fr ${tag}: ${x.name_fr}`);
  }
});

test('no duplicate names within a wilaya (after folding case and diacritics)', () => {
  for (const w of wilayas) {
    const list = communes.filter((c) => c.wilaya_code === w.code);
    for (const key of ['name_ar', 'name_fr']) {
      const seen = new Map();
      for (const c of list) {
        const k = fold(c[key]);
        assert.ok(!seen.has(k), `wilaya ${w.code}: ${c[key]} (ids ${seen.get(k)}, ${c.id})`);
        seen.set(k, c.id);
      }
    }
  }
  const wf = new Set(wilayas.map((w) => fold(w.name_fr)));
  const wa = new Set(wilayas.map((w) => fold(w.name_ar)));
  assert.equal(wf.size, 69);
  assert.equal(wa.size, 69);
});

test('composition matches the Journal officiel lists (38 wilayas, 539 communes)', () => {
  for (const l of official.lists) {
    const actual = communes.filter((c) => c.wilaya_code === l.code).map((c) => c.id).sort((a, b) => a - b);
    assert.deepEqual(actual, l.communes.map((c) => c.dataset_id).sort((a, b) => a - b), `wilaya ${l.code}`);
  }
});

test('reform spot checks', () => {
  const byId = new Map(communes.map((c) => [c.id, c]));
  const w = (code) => wilayas[code - 1];
  assert.equal(w(59).name_fr, 'Aflou');
  assert.equal(w(68).name_fr, 'Bou Saâda');
  assert.equal(w(68).name_ar, 'بوسعادة');
  assert.equal(w(69).name_fr, 'El Abiodh Sidi Cheikh');
  assert.equal(communes.filter((c) => c.wilaya_code === 55).length, 14); // Touggourt (Law 19-12 art. 52 bis 6)
  assert.equal(communes.filter((c) => c.wilaya_code === 30).length, 7); // Ouargla
  assert.equal(byId.get(978).wilaya_code, 55); // El Borma → Touggourt
  assert.equal(byId.get(233).wilaya_code, 52); // Tabelbala → Béni Abbès
  assert.equal(byId.get(1405).name_fr, 'Besbes');
  assert.equal(communes.filter((c) => c.wilaya_code >= 59).length, 108);
});
