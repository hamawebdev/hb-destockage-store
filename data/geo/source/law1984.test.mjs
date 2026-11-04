// GEO-6: the 31 wilayas whose composition dates from Law 84-09 (1984), checked against the
// hand transcription of the scanned JO and Ordinance 97-14. Run: node --test 'data/geo/**/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCommunes } from '../index.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const law84 = read('./jo/law-84-09-1984.json');
const official = read('./jo/official-lists.json');
const communes = loadCommunes();
const UNVERIFIED_BEFORE = [2, 4, 6, 9, 10, 15, 16, 18, 19, 20, 21, 22, 23, 24, 25, 27, 29, 31, 34, 35, 36, 37, 38, 40, 41, 42, 43, 44, 45, 46, 48];

test('31 transcribed 1984 lists, complete, article = code + 4', () => {
  assert.deepEqual(law84.lists.map((l) => l.code), UNVERIFIED_BEFORE);
  for (const l of law84.lists) {
    assert.equal(l.article, l.code + 4);
    assert.equal(l.items.length, l.declared, `art ${l.article}`);
    l.items.forEach((it, i) => assert.equal(it.pos, i + 1));
  }
  assert.equal(law84.lists.reduce((s, l) => s + l.items.length, 0), 1001);
});

test('Ordinance 97-14 moved exactly 24 communes to Alger (6 Boumerdès, 14 Tipaza, 4 Blida)', () => {
  const moved = law84.lists.flatMap((l) => l.items.filter((i) => i.now_wilaya === 16).map(() => l.code));
  assert.equal(moved.length, 24);
  assert.deepEqual([35, 42, 9].map((c) => moved.filter((x) => x === c).length), [6, 14, 4]);
});

test('JO lists (1984 + 1997, 2019, 2026) cover all 1,541 communes exactly once', () => {
  const ids = [
    ...law84.lists.flatMap((l) => l.items.flatMap((i) => i.ids)),
    ...official.lists.flatMap((l) => l.communes.map((c) => c.dataset_id)),
  ];
  assert.equal(ids.length, 1541);
  assert.equal(new Set(ids).size, 1541);
  assert.deepEqual([...ids].sort((a, b) => a - b), communes.map((c) => c.id));
});

test('each of the 31 wilayas holds exactly its 1984 communes, after Ordinance 97-14', () => {
  const expected = new Map(UNVERIFIED_BEFORE.map((c) => [c, []]));
  for (const l of law84.lists) for (const it of l.items) expected.get(it.now_wilaya ?? l.code).push(...it.ids);
  for (const [code, ids] of expected) {
    const actual = communes.filter((c) => c.wilaya_code === code).map((c) => c.id).sort((a, b) => a - b);
    assert.deepEqual(actual, ids.sort((a, b) => a - b), `wilaya ${code}`);
  }
  assert.equal(expected.get(16).length, 57); // Alger: 33 (1984) + 24 (1997)
});

test('the 1,541st commune: 1984 Mascara item 38 is two communes today', () => {
  const splits = law84.lists.flatMap((l) => l.items.filter((i) => i.ids.length > 1));
  assert.equal(splits.length, 1);
  assert.equal(splits[0].name, 'Guettena El Mamounia');
  assert.equal(splits[0].match, 'split');
});

test('GEO-6 name fixes are applied', () => {
  const byId = new Map(communes.map((c) => [c.id, c]));
  assert.equal(byId.get(68).name_fr, 'El Fedjoudj Boughrara Saoudi');
  assert.equal(byId.get(163).name_fr, 'Beni Maouche');
  assert.equal(byId.get(1025).name_fr, 'El Hammadia');
  assert.equal(byId.get(596).name_fr, 'Hammam Sokhna');
});
