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
  expectIssue(s, /huile-argan\.json\.images\[1\]: image of an invented product must be placeholder: true/);
  s = seed();
  product(s, 'huile-argan').placeholder = false;
  expectIssue(s, /huile-argan\.json: product 215 is not in provenance\.json, so it is invented and must be placeholder: true/);
});

const category = (s, id) => s.categories.find((c) => c.id === id);
const claim = (s, id) => (s.provenance.categories = [...(s.provenance.categories ?? []), { categoryId: id }]);

test('every category of ours is placeholder: true (F1)', () => {
  let s = seed();
  category(s, 2).placeholder = false; // top level
  expectIssue(s, /\(id 2\): category 2 is not in provenance\.json, so it is ours and must be placeholder: true/);
  s = seed();
  category(s, 21).placeholder = false; // child
  expectIssue(s, /\(id 21\): category 21 is not in provenance\.json/);
  s = seed();
  category(s, 11).placeholder = false; // holds the real packs, still ours
  expectIssue(s, /\(id 11\): category 11 is not in provenance\.json/);
  s = seed();
  for (const c of s.categories) c.placeholder = false; // all of them
  assert.equal(messages(s).filter((m) => /must be placeholder: true/.test(m) && m.startsWith('categories.json')).length, s.categories.length);
});

test('a category holding a placeholder product is placeholder: true, even if claimed as the client\'s', () => {
  const s = seed();
  claim(s, 22);
  category(s, 22).placeholder = false;
  for (const lang of ['ar', 'fr']) category(s, 22).description[lang] = category(s, 22).description[lang].replace('[PLACEHOLDER] ', '');
  const m = messages(s);
  assert.ok(m.some((x) => /\(id 22\): holds placeholder\/invented product\(s\) 201, 202 \(itself or in a sub-category\) but is placeholder: false/.test(x)), m.join('\n'));
  assert.ok(!m.some((x) => /\(id 22\): category 22 is not in provenance/.test(x)), 'claimed category is not "ours"');
  // A claimed category holding only real products may be unmarked: no issue for 11 alone.
  const t = seed();
  claim(t, 11);
  category(t, 11).placeholder = false;
  for (const lang of ['ar', 'fr']) category(t, 11).description[lang] = category(t, 11).description[lang].replace('[PLACEHOLDER] ', '');
  assert.deepEqual(messages(t).filter((x) => x.includes('(id 11)')), []);
});

test('a parent whose sub-category holds a placeholder product is placeholder: true', () => {
  const s = seed();
  claim(s, 2); // Électronique: products only in sub-categories 21/211/212/22
  category(s, 2).placeholder = false;
  for (const lang of ['ar', 'fr']) category(s, 2).description[lang] = category(s, 2).description[lang].replace('[PLACEHOLDER] ', '');
  expectIssue(s, /\(id 2\): holds placeholder\/invented product\(s\) .*201.* \(itself or in a sub-category\) but is placeholder: false/);
  const t = seed();
  claim(t, 1); // Salle de bain: its sub-category 12 holds the placeholder-priced draft components
  category(t, 1).placeholder = false;
  for (const lang of ['ar', 'fr']) category(t, 1).description[lang] = category(t, 1).description[lang].replace('[PLACEHOLDER] ', '');
  expectIssue(t, /\(id 1\): holds placeholder\/invented product\(s\) (11[1-4](, )?){4} \(itself or in a sub-category\)/);
});

test('placeholder categories carry [PLACEHOLDER] copy', () => {
  let s = seed();
  category(s, 22).description.fr = 'Audio.';
  expectIssue(s, /\(id 22\)\.description\.fr: placeholder category: description must contain "\[PLACEHOLDER\]"/);
  s = seed();
  category(s, 1).description = null;
  expectIssue(s, /\(id 1\)\.description\.ar: placeholder category: description must contain/);
});

test('no [PLACEHOLDER] text on anything marked placeholder: false', () => {
  let s = seed();
  claim(s, 11);
  category(s, 11).placeholder = false; // description still says [PLACEHOLDER]
  expectIssue(s, /\(id 11\): placeholder: false but its text contains "\[PLACEHOLDER\]"/);
  s = seed();
  product(s, 'pack-luxe-4-en-1').summary.fr += ' [PLACEHOLDER]';
  expectIssue(s, /pack-luxe-4-en-1\.json: placeholder: false but its text contains "\[PLACEHOLDER\]"/);
  s = seed();
  product(s, 'pack-luxe-4-en-1').images[0].alt.ar = '[PLACEHOLDER] ' + product(s, 'pack-luxe-4-en-1').images[0].alt.ar;
  expectIssue(s, /pack-luxe-4-en-1\.json\.images\[0\]: placeholder: false but its alt contains/);
  s = seed();
  claim(s, 99);
  expectIssue(s, /provenance\.json: category 99 does not exist/);
});

test('ids follow the README scheme', () => {
  let s = seed();
  product(s, 'puzzle-500-pieces').variants[0].id = 99901;
  expectIssue(s, /puzzle-500-pieces\.json\.variants: variant id 99901 must be 218×100 \+ n/);
  s = seed();
  product(s, 'peluche-ourson').options[0].values[0].id = 219999;
  expectIssue(s, /peluche-ourson\.json\.options: option value id 219999 must be 2191×100 \+ n/);
  s = seed();
  product(s, 'peluche-ourson').options[0].id = 2290;
  expectIssue(s, /option id 2290 must be 219×10 \+ n/);
  s = seed();
  product(s, 'huile-argan').images[0].id = 2150;
  expectIssue(s, /huile-argan\.json\.images: image id 2150 must be 215×10 \+ n/);
  s = seed();
  category(s, 211).id = 220;
  expectIssue(s, /\(id 220\)\.id: child category id must be parent×10 \+ n \(parent 21\)/);
  s = seed();
  category(s, 5).id = 10;
  expectIssue(s, /\(id 10\)\.id: top-level category id must be 1–9/);
  s = seed();
  const real = product(s, 'pack-luxe-4-en-1');
  s.provenance.products.find((x) => x.productId === 103).productId = 250;
  real.id = 250;
  expectIssue(s, /pack-luxe-4-en-1\.json\.id: real product id must be 101–199/);
});

test('real products and real images have provenance', () => {
  let s = seed();
  s.provenance.products = s.provenance.products.filter((x) => x.productId !== 103);
  expectIssue(s, /pack-luxe-4-en-1\.json: product 103 is not in provenance\.json/);
  expectIssue(s, /pack-luxe-4-en-1\.json\.images\[0\]: image of an invented product must be placeholder: true/);
  s = seed();
  s.provenance.images = s.provenance.images.filter((x) => x.imageId !== 1031);
  expectIssue(s, /provenance\.json: real image 1031 .* has no provenance entry/);
  s = seed();
  s.provenance.products.push({ productId: 999 });
  expectIssue(s, /provenance\.json: product 999 does not exist/);
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
