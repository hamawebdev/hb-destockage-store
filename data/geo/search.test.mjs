// GEO-5: normalizeForSearch + searchKey. Run: node --test 'data/geo/**/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeForSearch as n, searchKey } from './search.mjs';
import { loadWilayas, loadCommunes } from './index.mjs';
import { corpus } from './scripts/make-search-corpus.mjs';

const same = (...xs) => { const k = n(xs[0]); for (const x of xs) assert.equal(n(x), k, `${x} → ${n(x)} ≠ ${k}`); return k; };
const finds = (name, query) => searchKey(name).includes(n(query));
const names = [...loadWilayas(), ...loadCommunes()];

test('French folding: case, diacritics, hyphens, apostrophes, ligatures; no word dropped', () => {
  assert.equal(same('El Oued', 'El-Oued', 'el oued', 'EL OUED'), 'el oued');
  assert.equal(same("M'Sila", 'M’Sila', 'Msila', 'MSILA'), 'msila');
  assert.equal(same('Béjaïa', 'Bejaia', 'BÉJAÏA'), 'bejaia');
  assert.equal(same('Aïn Salah', 'Ain Salah'), 'ain salah');
  assert.equal(n('Tizi-Ouzou'), 'tizi ouzou');
  assert.equal(n('  Bordj — Bou  Arreridj !! '), 'bordj bou arreridj');
  assert.equal(same('Cuiseur à œufs', 'cuiseur a oeufs'), 'cuiseur a oeufs');
  assert.equal(n('Æ ß'), 'ae ss');
});

test('Arabic folding: tashkeel, tatweel, alef/hamza, ى/ی, ة, ؤ, ئ, ٱ, ڨ/ڧ/ڢ, ک', () => {
  assert.equal(same('مُسْتَغَانِم', 'مستغانم'), 'مستغانم');
  assert.equal(same('قسنطينـــة', 'قسنطينة', 'قسنطينه'), 'قسنطينه');
  assert.equal(same('أفلو', 'آفلو', 'افلو'), 'افلو');
  assert.equal(same('إليزي', 'اليزي'), 'اليزي');
  assert.equal(same('سيدى بلعباس', 'سيدي بلعباس', 'سیدی بلعباس'), 'سيدي بلعباس');
  assert.equal(n('مؤسسة'), 'موسسه');
  assert.equal(same('ٱلجزائر', 'الجزائر', 'الجزاير'), 'الجزاير');
  assert.equal(same('ورڨلة', 'ورقلة'), 'ورقله');
  assert.equal(same('بسکرة', 'بسكرة'), 'بسكره');
  assert.equal(n('ڢ'), 'ف');
});

test('digits, empty input, lang is optional, port-safe (no numbers returned)', () => {
  assert.equal(n('٠١٦'), '016');
  assert.equal(n('۱۶'), '16');
  assert.equal(n('16 - الجزائر', 'ar'), '16 الجزاير');
  assert.equal(n(''), '');
  assert.equal(n('   '), '');
  assert.equal(n(undefined), '');
  assert.equal(n('Oran', 'fr'), n('Oran', 'ar'));
  assert.equal(typeof n('٣'), 'string');
});

test('searchKey: spelling alternatives (article glued, In ≡ Ain, إن ≡ عين); "|" never appears in a query', () => {
  assert.ok(finds('El Oued', 'eloued'));
  assert.ok(finds('El Oued', 'oued'));
  assert.ok(finds('In Salah', 'Ain Salah'));
  assert.ok(finds('In Salah', 'Aïn Sal'));
  assert.ok(finds('Ain Salah', 'In Salah'));
  assert.ok(finds('إن صالح', 'عين صالح'));
  assert.ok(finds('الوادي', 'وادي'));
  assert.ok(!finds('Oran', 'alger'));
  assert.ok(!n('a|b').includes('|'));
});

test('typing any prefix of any wilaya or commune name keeps that name selected (both languages)', () => {
  for (const key of ['name_fr', 'name_ar']) {
    for (const r of names) {
      const name = r[key];
      const k = searchKey(name);
      const chars = [...name];
      for (let i = 1; i <= chars.length; i++) {
        const p = chars.slice(0, i).join('');
        assert.ok(k.includes(n(p)), `${key} ${r.id ?? 'w' + r.code} "${name}" lost at "${p}" (${n(p)} ∉ ${k})`);
      }
    }
  }
});

test('every wilaya key is distinct per language; commune keys distinct within each wilaya', () => {
  for (const key of ['name_ar', 'name_fr']) {
    assert.equal(new Set(loadWilayas().map((w) => n(w[key]))).size, 69, key);
    const seen = new Map();
    for (const c of loadCommunes()) {
      const k = `${c.wilaya_code}|${n(c[key])}`;
      assert.ok(!seen.has(k), `${key} ${c.id} collides with ${seen.get(k)}: ${k}`);
      seen.set(k, c.id);
    }
  }
});

test('search.corpus.json is current (parity corpus for ports)', () => {
  const committed = JSON.parse(readFileSync(new URL('./search.corpus.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, corpus());
  for (const row of committed) {
    assert.equal(n(row.in, row.lang), row.out);
    assert.equal(searchKey(row.in, row.lang), row.key);
  }
});
