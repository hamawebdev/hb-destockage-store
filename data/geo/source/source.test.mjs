// GEO-1: the pinned upstream dataset and its reconciliation with the Journal officiel.
// Run: node --test data/geo/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const here = (p) => new URL(p, import.meta.url);
const rawBytes = readFileSync(here('./algeria-cities/algeria_cities.json'));
const upstream = JSON.parse(rawBytes.toString('utf8'));
const official = JSON.parse(readFileSync(here('./jo/official-lists.json'), 'utf8'));
const corrections = JSON.parse(readFileSync(here('./corrections.json'), 'utf8'));
const byId = new Map(upstream.map((r) => [Number(r.id), r]));

test('upstream file is the pinned one', () => {
  const sha = createHash('sha256').update(rawBytes).digest('hex');
  assert.equal(sha, '7930b4e467a4ca948e6afae7cf7b0fdb3c677acf0fedbee9a407cb925863b255');
});

test('upstream: 1,541 communes, 69 wilayas, unique ids, both names present', () => {
  assert.equal(upstream.length, 1541);
  assert.equal(byId.size, 1541);
  const codes = new Set(upstream.map((r) => r.wilaya_code));
  assert.deepEqual([...codes].sort((a, b) => a - b), Array.from({ length: 69 }, (_, i) => i + 1));
  for (const r of upstream) {
    assert.ok(r.commune_name?.trim(), `ar name ${r.id}`);
    assert.ok(r.commune_name_fr?.trim(), `fr name ${r.id}`);
    assert.ok(r.wilaya_name?.trim() && r.wilaya_name_fr?.trim(), `wilaya names ${r.id}`);
  }
});

test('JO totals are 69 wilayas / 1,541 communes', () => {
  assert.equal(official.totals.wilayas, 69);
  assert.equal(official.totals.communes, 1541);
});

test('JO lists: complete, mapped one-to-one to upstream rows', () => {
  assert.equal(official.lists.length, 38);
  const seen = new Set();
  for (const l of official.lists) {
    assert.equal(l.communes.length, l.declared, `wilaya ${l.code} declared count`);
    for (const c of l.communes) {
      assert.ok(byId.has(c.dataset_id), `id ${c.dataset_id} exists`);
      assert.ok(!seen.has(c.dataset_id), `id ${c.dataset_id} listed once`);
      seen.add(c.dataset_id);
      assert.ok(c.fr && c.ar);
    }
  }
  assert.equal(seen.size, 539);
});

test('new wilayas 59-69: 11 lists from Law 26-06 totalling 108 communes, names from Decree 26-206', () => {
  const lists = official.lists.filter((l) => l.code >= 59);
  assert.deepEqual(lists.map((l) => l.code), [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
  assert.equal(lists.reduce((s, l) => s + l.communes.length, 0), 108);
  assert.equal(official.wilaya_names_59_69.length, 11);
});

test('after the recorded moves, every JO-listed wilaya has exactly its JO composition', () => {
  const code = new Map(upstream.map((r) => [Number(r.id), r.wilaya_code]));
  for (const m of corrections.commune_moves) {
    assert.equal(code.get(m.id), m.from, `move ${m.id} starts from upstream code`);
    code.set(m.id, m.to);
  }
  for (const l of official.lists) {
    const actual = [...code].filter(([, w]) => w === l.code).map(([id]) => id).sort((a, b) => a - b);
    const expected = l.communes.map((c) => c.dataset_id).sort((a, b) => a - b);
    assert.deepEqual(actual, expected, `wilaya ${l.code}`);
  }
  // Every move is justified by a JO list
  const listed = new Map(official.lists.flatMap((l) => l.communes.map((c) => [c.dataset_id, l.code])));
  for (const m of corrections.commune_moves) assert.equal(listed.get(m.id), m.to);
});
