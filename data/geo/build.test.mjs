// GEO-3: storefront geo assets. Run: node --test 'data/geo/**/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGeoAssets, communesFile } from './build.mjs';
import { loadCommunes } from './index.mjs';

const communes = loadCommunes();

for (const lang of ['ar', 'fr']) {
  test(`buildGeoAssets writes 69 sorted per-wilaya files (${lang})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'geo-'));
    try {
      const { wilayas, files } = await buildGeoAssets(dir, { lang });
      assert.equal(wilayas.length, 69);
      assert.deepEqual(wilayas.map((w) => w.code), Array.from({ length: 69 }, (_, i) => i + 1));
      assert.equal(wilayas[15].label, lang === 'ar' ? '16 - الجزائر' : '16 - Alger');
      assert.equal(files.length, 69);
      assert.equal(files[15], `geo/communes/${lang}/16.json`);
      assert.equal(files[15], communesFile(lang, 16));
      assert.equal((await readdir(join(dir, 'geo', 'communes', lang))).length, 69);

      const collator = new Intl.Collator(lang);
      const key = lang === 'ar' ? 'name_ar' : 'name_fr';
      const seen = new Set();
      for (let code = 1; code <= 69; code++) {
        const list = JSON.parse(await readFile(join(dir, communesFile(lang, code)), 'utf8'));
        const expected = communes.filter((c) => c.wilaya_code === code);
        assert.equal(list.length, expected.length, `wilaya ${code}`);
        for (let i = 0; i < list.length; i++) {
          const [id, name] = list[i];
          assert.equal(typeof id, 'number');
          assert.equal(name, communes.find((c) => c.id === id)[key]);
          assert.equal(communes.find((c) => c.id === id).wilaya_code, code);
          if (i) assert.ok(collator.compare(list[i - 1][1], name) <= 0, `sorted ${code}`);
          seen.add(id);
        }
      }
      assert.equal(seen.size, 1541);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('buildGeoAssets rejects an unknown language', async () => {
  await assert.rejects(buildGeoAssets('/nonexistent', { lang: 'en' }), TypeError);
  await assert.rejects(buildGeoAssets('/nonexistent'), TypeError);
});

test('French collation ignores diacritics: Aïn sorts with Ain', () => {
  const c = new Intl.Collator('fr');
  assert.ok(c.compare('Aïn Touta', 'Ain Yagout') < 0);
});
