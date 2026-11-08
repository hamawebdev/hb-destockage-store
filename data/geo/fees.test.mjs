// GEO-4: placeholder delivery fees. Run: node --test 'data/geo/**/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fees = JSON.parse(readFileSync(new URL('./fees.seed.json', import.meta.url), 'utf8'));
const fee = (code) => fees.find((f) => f.wilaya_code === code).fee_dzd;

test('69 entries, one per wilaya code 1-69, exact shape, all placeholders', () => {
  assert.equal(fees.length, 69);
  assert.deepEqual(fees.map((f) => f.wilaya_code), Array.from({ length: 69 }, (_, i) => i + 1));
  for (const f of fees) {
    assert.deepEqual(Object.keys(f), ['wilaya_code', 'fee_dzd', 'available', 'placeholder']);
    assert.equal(f.placeholder, true);
    assert.equal(typeof f.available, 'boolean');
    assert.ok(Number.isInteger(f.fee_dzd) && f.fee_dzd >= 300 && f.fee_dzd <= 2000 && f.fee_dzd % 50 === 0, `fee ${f.wilaya_code}`);
  }
});

test('plausible gradient: Algiers < northern Tell < highlands < Sahara < far south', () => {
  assert.ok(fee(16) < fee(31)); // Alger < Oran
  assert.ok(fee(31) < fee(17)); // Oran < Djelfa
  assert.ok(fee(17) < fee(30)); // Djelfa < Ouargla
  assert.ok(fee(30) < fee(11)); // Ouargla < Tamanrasset
  for (const code of [59, 60, 62, 63, 64, 65, 66, 67, 68, 69]) assert.equal(fee(code), 800, `new wilaya ${code} priced as highlands`);
});

test('only the two border wilayas are unavailable', () => {
  assert.deepEqual(fees.filter((f) => !f.available).map((f) => f.wilaya_code), [50, 54]);
});
