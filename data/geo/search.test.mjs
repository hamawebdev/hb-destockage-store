// GEO-5: normalizeForSearch. Run: node --test 'data/geo/**/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeForSearch as n } from './search.mjs';
import { loadWilayas, loadCommunes } from './index.mjs';
import { corpus } from './scripts/make-search-corpus.mjs';

const same = (...xs) => { const k = n(xs[0]); for (const x of xs) assert.equal(n(x), k, `${x} → ${n(x)} ≠ ${k}`); return k; };

test('French: case, diacritics, hyphens, apostrophes, leading article, In/Ain', () => {
  assert.equal(same('El Oued', 'El-Oued', 'el oued', 'EL OUED', 'Al Oued'), 'oued');
  assert.equal(same("M'Sila", 'M’Sila', 'Msila', 'MSILA'), 'msila');
  assert.equal(same('In Salah', 'Ain Salah', 'Aïn Salah', 'ayn salah'), 'ain salah');
  assert.equal(same('Béjaïa', 'Bejaia', 'BÉJAÏA'), 'bejaia');
  assert.equal(same('Ech Chorfa', 'Chorfa'), 'chorfa');
  assert.equal(same('Bou Saâda', 'bou saada'), 'bou saada');
  assert.equal(n('Tizi-Ouzou'), 'tizi ouzou');
  assert.equal(n('  Bordj — Bou  Arreridj !! '), 'bordj bou arreridj');
  assert.equal(n('Sidi Bel Abbès'), 'sidi bel abbes');
  // an article alone is kept, so typing "el" still narrows the list
  assert.equal(n('el'), 'el');
  assert.equal(n('el '), 'el');
  assert.equal(n('el o'), 'o');
});

test('Arabic: tashkeel, tatweel, alef/hamza, ى, ة, ؤ, ئ, ٱ, إن ≡ عين', () => {
  assert.equal(same('مُسْتَغَانِم', 'مستغانم'), 'مستغانم');
  assert.equal(same('قسنطينـــة', 'قسنطينة', 'قسنطينه'), 'قسنطينه');
  assert.equal(same('أفلو', 'آفلو', 'افلو'), 'افلو');
  assert.equal(same('إليزي', 'اليزي'), 'اليزي');
  assert.equal(same('الأغواط', 'الاغواط'), 'الاغواط');
  assert.equal(same('سيدى بلعباس', 'سيدي بلعباس'), 'سيدي بلعباس');
  assert.equal(n('مؤسسة'), 'موسسه');
  assert.equal(same('بئر العاتر', 'بير العاتر'), 'بير العاتر');
  assert.equal(same('ٱلجزائر', 'الجزائر', 'الجزاير'), 'الجزاير');
  assert.equal(same('إن صالح', 'ان صالح', 'عين صالح'), 'عين صالح');
  // the article is kept; substring matching finds وادي in الوادي
  assert.ok(n('الوادي').includes(n('وادي')));
});

test('digits, empty input, lang is optional', () => {
  assert.equal(n('٠١٦'), '016');
  assert.equal(n('۱۶'), '16');
  assert.equal(n('16 - الجزائر', 'ar'), '16 الجزاير');
  assert.equal(n(''), '');
  assert.equal(n('   '), '');
  assert.equal(n(undefined), '');
  assert.equal(n('Oran', 'fr'), n('Oran', 'ar'));
});

test('every wilaya name is findable and its key is unique per language', () => {
  const wilayas = loadWilayas();
  for (const key of ['name_ar', 'name_fr']) {
    const keys = wilayas.map((w) => n(w[key]));
    assert.equal(new Set(keys).size, 69, key);
    for (const k of keys) assert.ok(k.length > 1);
  }
});

test('commune keys stay distinct within each wilaya (the picker never shows two identical keys)', () => {
  const communes = loadCommunes();
  for (const key of ['name_ar', 'name_fr']) {
    const seen = new Map();
    for (const c of communes) {
      const k = `${c.wilaya_code}|${n(c[key])}`;
      assert.ok(!seen.has(k), `${key} ${c.id} collides with ${seen.get(k)}: ${k}`);
      seen.set(k, c.id);
    }
  }
});

test('search.corpus.json is current (parity corpus for ports)', () => {
  const committed = JSON.parse(readFileSync(new URL('./search.corpus.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, corpus());
  for (const row of committed) assert.equal(n(row.in, row.lang), row.out);
});
