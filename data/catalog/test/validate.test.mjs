// node --test data/catalog/test/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { imageSize, loadSeed, validateLoadedSeed, validateSeed } from '../validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const base = loadSeed(ROOT);
/** A deep copy of the committed seed to mutate. */
const seed = () => ({ ...structuredClone({ ...base, photosDir: undefined }), photosDir: base.photosDir });
const product = (s, frSlug) => s.products.find((p) => p.product.slug.fr === frSlug).product;
const messages = (s) => validateLoadedSeed(s).map((i) => `${i.path}: ${i.message}`);
const expectIssue = (s, re) => {
  const m = messages(s);
  assert.ok(m.some((x) => re.test(x)), `expected an issue matching ${re}, got:\n${m.join('\n') || '(none)'}`);
};

test('the committed seed is valid', () => {
  assert.deepEqual(validateSeed(ROOT), []);
});

test('the seed covers what SEED-4 promises', () => {
  const ps = base.products.map((p) => p.product);
  const stocks = ps.flatMap((p) => p.variants.map((v) => v.stock));
  assert.ok(stocks.includes(0), 'an out-of-stock variant');
  assert.ok(stocks.some((x) => x !== null && x > 0 && x <= 5), 'a low-stock variant');
  assert.ok(stocks.includes(null), 'an untracked variant');
  assert.ok(ps.some((p) => p.kind === 'pack' && p.placeholder), 'a placeholder pack');
  assert.ok(ps.some((p) => p.options.length >= 2), 'a size × colour matrix');
  const cats = new Map(base.categories.map((c) => [c.id, c]));
  const depth = (c) => (c.parentId === null ? 1 : 1 + depth(cats.get(c.parentId)));
  assert.ok(base.categories.some((c) => depth(c) >= 3), 'sub-categories at ≥ 2 levels');
  assert.ok(base.categories.filter((c) => c.parentId === null && c.placeholder).length >= 4, '≥ 4 placeholder top-level categories');
});

test('slugs are unique per language', () => {
  const s = seed();
  product(s, 'puzzle-500-pieces').slug.ar = product(s, 'peluche-ourson').slug.ar;
  expectIssue(s, /slug\.ar: duplicate slug "dabdub-mahshu"/);
});

test('prices are integers > 0', () => {
  let s = seed();
  product(s, 'puzzle-500-pieces').variants[0].priceDzd = 1300.5;
  expectIssue(s, /puzzle-500-pieces\.json\.variants\.0\.priceDzd/);
  s = seed();
  product(s, 'puzzle-500-pieces').variants[0].priceDzd = 0;
  expectIssue(s, /puzzle-500-pieces\.json\.variants\.0\.priceDzd/);
});

test('exactly one default variant per product', () => {
  let s = seed();
  product(s, 'peluche-ourson').variants[1].isDefault = true;
  expectIssue(s, /peluche-ourson\.json\.variants: expected exactly one default/);
  s = seed();
  const teddy = product(s, 'peluche-ourson');
  teddy.variants[0].isDefault = false;
  teddy.variants[2].isDefault = true;
  teddy.variants[2].active = false; // an inactive default: CAT-1 sees 0 active defaults
  expectIssue(s, /peluche-ourson\.json\.variants: expected exactly one default active variant, found 0/);
});

test('every pack item exists', () => {
  const s = seed();
  product(s, 'coffret-soin-visage').packItems.push({ variantId: 99999, qty: 1 });
  expectIssue(s, /coffret-soin-visage\.json\.packItems\[3\]\.variantId: unknown variant 99999/);
});

test('every variant of a variable product has a value for each option', () => {
  const s = seed();
  product(s, 't-shirt-coton-homme').variants[0].optionValueIds.pop();
  expectIssue(s, /t-shirt-coton-homme\.json\.variants\[0\]\.optionValueIds: must hold exactly one value of each option/);
});

test('no duplicate option combinations', () => {
  const s = seed();
  const t = product(s, 't-shirt-coton-homme');
  t.variants[1].optionValueIds = [...t.variants[0].optionValueIds];
  expectIssue(s, /t-shirt-coton-homme\.json\.variants: two variants share option combination/);
});

test('every image file exists and has the stated size', () => {
  let s = seed();
  product(s, 'huile-argan').images[0].key = 'huile-argan/9.jpg';
  expectIssue(s, /huile-argan\.json\.images\[0\]: file data\/photos\/huile-argan\/9\.jpg does not exist/);
  s = seed();
  product(s, 'huile-argan').images[0].width = 1000;
  expectIssue(s, /huile-argan\.json\.images\[0\]: width\/height 1000×1200 but the file is 1200×1200/);
  s = seed();
  product(s, 'huile-argan').images[0].key = '../huile-argan/1.jpg';
  expectIssue(s, /must be a lowercase relative path/);
});

test('placeholders are marked', () => {
  let s = seed();
  const p = product(s, 'huile-argan');
  p.description.fr = p.description.fr.replace('[PLACEHOLDER]', '');
  expectIssue(s, /huile-argan\.json\.description\.fr: placeholder product: description must contain/);
  s = seed();
  product(s, 'huile-argan').images[1].placeholder = false;
  expectIssue(s, /huile-argan\.json\.images\[1\]: image of a placeholder product must be placeholder: true/);
  s = seed();
  product(s, 'huile-argan').placeholder = false;
  expectIssue(s, /huile-argan\.json\.categoryId: real product in placeholder category 42/);
});

test('real products and real images have provenance', () => {
  let s = seed();
  s.provenance.products = s.provenance.products.filter((x) => x.productId !== 103);
  expectIssue(s, /pack-luxe-4-en-1\.json: real product 103 has no provenance\.json entry/);
  s = seed();
  s.provenance.images = s.provenance.images.filter((x) => x.imageId !== 1031);
  expectIssue(s, /provenance\.json: real image 1031 .* has no provenance entry/);
  s = seed();
  s.provenance.images.find((x) => x.source === 'supplier_render').needsClientConfirmation = false;
  expectIssue(s, /supplier_render needs needsClientConfirmation: true/);
});

test('file name follows the French slug', () => {
  const s = seed();
  s.products.find((p) => p.product.slug.fr === 'huile-argan').file = 'argan.json';
  expectIssue(s, /products\/argan\.json: file name must be "huile-argan\.json"/);
});

test('a structural error stops early and names the file', () => {
  const s = seed();
  product(s, 'huile-argan').colour = 'red'; // unknown key in a strict object
  const m = messages(s);
  assert.equal(m.length, 1);
  assert.match(m[0], /^products\/huile-argan\.json/);
});

test('imageSize reads JPEG and PNG headers', () => {
  assert.deepEqual(imageSize(readFileSync(join(ROOT, 'data/photos/pack-luxe-4-en-1/1.jpg'))), { width: 1284, height: 1533 });
  const png = Buffer.alloc(32);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(imageSize(png), { width: 640, height: 480 });
  assert.equal(imageSize(Buffer.from('not an image')), null);
});
