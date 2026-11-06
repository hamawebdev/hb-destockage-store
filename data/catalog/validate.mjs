// SEED-5: validates the seed catalogue in data/catalog/ + data/photos/.
//
//   node data/catalog/validate.mjs [repoRoot]      # prints issues, exit 1 if any
//
//   import { validateSeed, loadSeed } from '<repo>/data/catalog/validate.mjs';
//   validateSeed(repoRoot) -> SeedIssue[]          (empty = valid; never throws on bad data)
//
// Two layers:
//  1. CAT-1 (`@hb/catalog/schema`): structure (strict Valibot objects; integer DZD prices ≥ 1) +
//     integrity (unique ids, SKUs and slugs per language, compare-at > price, exactly one active
//     default variant, simple/pack = 1 variant, every variable variant has exactly one value of each
//     option, no duplicate option combinations, pack items exist and are not packs, active products
//     have a product-level image). Not repeated here.
//  2. Seed-only rules below: product file named after its French slug; exactly one default variant
//     overall; every image key is a lowercase relative path to an existing JPEG/PNG ≤ 3 MB whose real
//     size matches width/height; no key twice per product; unique image positions; placeholder
//     marking — a category or product not listed in provenance.json is ours: placeholder: true
//     (a category also whenever it or a sub-category holds a placeholder product), "[PLACEHOLDER]" in the description
//     of every placeholder category and product, all images of an invented product placeholder, and
//     no "[PLACEHOLDER]" text anywhere on an entity marked placeholder: false; the README id scheme;
//     home products are active; provenance.json entries exist and cover every real image
//     (supplier renders flagged needsClientConfirmation); every real photo is listed in
//     data/photos/manifest.json with printedPrices. A photo is real iff the manifest lists its key
//     (whatever its placeholder flag): real photos may not be flagged placeholder, invented
//     products may not use them, they need provenance, and a product may only use one whose
//     printed prices are all prices of its own variants (BUG-14).
// Used by `db` (seed loader, before loading D1) and `pagedata` (fromSeed, before the build).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSnapshotIntegrity, checkSnapshotStructure } from '@hb/catalog/schema';

/** @typedef {{ path: string, message: string }} SeedIssue */

export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const IMAGE_KEY = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\.(jpg|jpeg|png|webp|avif)$/;
const PLACEHOLDER_TAG = '[PLACEHOLDER]';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * Reads the seed files. Throws only if a file is missing or is not JSON (that is not "data with
 * issues", it is a broken checkout).
 */
export function loadSeed(repoRoot) {
  const dir = join(repoRoot, 'data', 'catalog');
  const productFiles = readdirSync(join(dir, 'products')).filter((f) => f.endsWith('.json')).sort();
  return {
    categories: readJson(join(dir, 'categories.json')),
    settings: readJson(join(dir, 'settings.json')),
    products: productFiles.map((f) => ({ file: f, product: readJson(join(dir, 'products', f)) })),
    provenance: existsSync(join(dir, 'provenance.json')) ? readJson(join(dir, 'provenance.json')) : null,
    photosDir: join(repoRoot, 'data', 'photos'),
    photoManifest: existsSync(join(repoRoot, 'data', 'photos', 'manifest.json'))
      ? readJson(join(repoRoot, 'data', 'photos', 'manifest.json')) : null,
  };
}

/** The seed as a `CatalogSnapshot` (wilayas and content pages are owned by geo/brand: left empty). */
export function toSnapshot(seed) {
  return {
    meta: { version: 1, source: 'seed', generatedAt: 0, publishRunId: null },
    categories: seed.categories,
    products: seed.products.map((p) => p.product),
    contentPages: [],
    settings: seed.settings,
    wilayas: [],
  };
}

/** Width/height from a JPEG or PNG header; null if the format is not recognised. */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** All rules over an already-loaded seed. Pure except for reading image files under `seed.photosDir`. */
export function validateLoadedSeed(seed) {
  /** @type {SeedIssue[]} */
  const issues = [];
  const add = (path, message) => void issues.push({ path, message });

  // Point product issues at their file, which is what a person edits.
  const where = (path) => {
    const m = /^products(?:\[(\d+)\]|\.(\d+))(.*)$/.exec(path);
    return m ? `products/${seed.products[Number(m[1] ?? m[2])]?.file ?? '?'}${m[3]}` : path;
  };

  // 1. CAT-1 structure. If it fails, stop: the rules below assume well-formed data.
  const snapshot = toSnapshot(seed);
  const structure = checkSnapshotStructure(snapshot);
  if (structure.length) {
    for (const i of structure) add(where(i.path), i.message);
    return issues;
  }
  // CAT-1 integrity (the seed snapshot carries no wilayas: geo owns them).
  for (const i of checkSnapshotIntegrity(snapshot, { requireAllWilayas: false })) add(where(i.path), i.message);

  // An entity is *real* (the client's) iff provenance.json lists it; everything else is ours and
  // must be marked. Today provenance lists no category (the client only had "Non classé").
  const provProducts = new Set((seed.provenance?.products ?? []).map((x) => x.productId));
  const provCategories = new Set((seed.provenance?.categories ?? []).map((x) => x.categoryId));
  const tagged = (loc) => loc != null && (loc.ar.includes(PLACEHOLDER_TAG) || loc.fr.includes(PLACEHOLDER_TAG));

  // 2a. Categories: placeholder marking and the id scheme.
  // A placeholder product marks its category *and every ancestor* (the whole subtree holds it).
  const parentOf = new Map(seed.categories.map((c) => [c.id, c.parentId]));
  const placeholderProductsByCat = new Map();
  for (const { product: p } of seed.products) {
    if (!(p.placeholder || !provProducts.has(p.id))) continue;
    const seen = new Set();
    for (let id = p.categoryId; id != null && !seen.has(id); id = parentOf.get(id)) {
      seen.add(id); // guards against a cycle (CAT-1 reports it)
      placeholderProductsByCat.set(id, [...(placeholderProductsByCat.get(id) ?? []), p.id]);
    }
  }
  seed.categories.forEach((c, i) => {
    const at = `categories.json[${i}](id ${c.id})`;
    if (!provCategories.has(c.id) && !c.placeholder) {
      add(at, `category ${c.id} is not in provenance.json, so it is ours and must be placeholder: true`);
    }
    const holds = placeholderProductsByCat.get(c.id);
    if (holds && !c.placeholder) add(at, `holds placeholder/invented product(s) ${holds.join(', ')} (itself or in a sub-category) but is placeholder: false`);
    if (c.placeholder) {
      for (const lang of ['ar', 'fr']) {
        if (!c.description?.[lang]?.includes(PLACEHOLDER_TAG)) add(`${at}.description.${lang}`, `placeholder category: description must contain "${PLACEHOLDER_TAG}"`);
      }
    } else if (tagged(c.name) || tagged(c.description)) {
      add(at, `placeholder: false but its text contains "${PLACEHOLDER_TAG}"`);
    }
    // Ids (README "Ids"): top level 1–9, child = parent×10 + n.
    if (c.parentId === null ? !(c.id >= 1 && c.id <= 9) : !(Math.floor(c.id / 10) === c.parentId && c.id % 10 >= 1)) {
      add(`${at}.id`, c.parentId === null ? 'top-level category id must be 1–9' : `child category id must be parent×10 + n (parent ${c.parentId})`);
    }
  });

  // 2a'. Photo manifest: every real photo file with the prices printed in it.
  const photoByKey = new Map();
  if (!seed.photoManifest) add('data/photos/manifest.json', 'missing');
  else {
    seed.photoManifest.photos.forEach((ph, i) => {
      const at = `data/photos/manifest.json photos[${i}] (${ph.key})`;
      if (photoByKey.has(ph.key)) add(at, 'key listed twice');
      photoByKey.set(ph.key, ph);
      if (typeof ph.key !== 'string' || ph.key.startsWith('/') || ph.key.split('/').includes('..') || !existsSync(join(seed.photosDir, ph.key))) {
        add(at, 'file does not exist under data/photos/');
      }
      if (!Array.isArray(ph.printedPrices) || !ph.printedPrices.every((x) => Number.isSafeInteger(x) && x > 0)) {
        add(at, 'printedPrices must be an array of integer DZD amounts > 0 ([] when the photo prints no price)');
      }
    });
  }

  // 2b. Products.
  for (const { file, product: p } of seed.products) {
    const at = `products/${file}`;
    if (file !== `${p.slug.fr}.json`) add(at, `file name must be "${p.slug.fr}.json" (the French slug)`);

    // CAT-1 counts defaults among active variants only; the seed has exactly one, full stop.
    const defaults = p.variants.filter((x) => x.isDefault);
    if (defaults.length !== 1) add(`${at}.variants`, `expected exactly one default variant, found ${defaults.length}`);

    // Placeholder marking (CLAUDE.md: every placeholder is marked).
    const isReal = provProducts.has(p.id);
    if (!isReal && !p.placeholder) add(at, `product ${p.id} is not in provenance.json, so it is invented and must be placeholder: true`);
    if (p.placeholder) {
      for (const lang of ['ar', 'fr']) {
        if (!p.description[lang].includes(PLACEHOLDER_TAG)) add(`${at}.description.${lang}`, `placeholder product: description must contain "${PLACEHOLDER_TAG}"`);
      }
    }
    if (!p.placeholder) {
      const texts = [p.name, p.summary, p.description, ...p.options.flatMap((o) => [o.name, ...o.values.map((x) => x.value)])];
      if (texts.some(tagged)) add(at, `placeholder: false but its text contains "${PLACEHOLDER_TAG}"`);
    }
    p.images.forEach((img, j) => {
      if (!img.placeholder && tagged(img.alt)) add(`${at}.images[${j}]`, `placeholder: false but its alt contains "${PLACEHOLDER_TAG}"`);
    });

    // Ids (README "Ids"): real products 101–199, invented 201–999; variant = product×100 + n;
    // option = product×10 + n; option value = option×100 + n; image = product×10 + n.
    const child = (id, parent, k) => Math.floor(id / k) === parent && id % k >= 1;
    if (isReal ? !(p.id >= 101 && p.id <= 199) : !(p.id >= 201 && p.id <= 999)) {
      add(`${at}.id`, isReal ? 'real product id must be 101–199' : 'invented product id must be 201–999');
    }
    for (const x of p.variants) if (!child(x.id, p.id, 100)) add(`${at}.variants`, `variant id ${x.id} must be ${p.id}×100 + n`);
    for (const o of p.options) {
      if (!child(o.id, p.id, 10)) add(`${at}.options`, `option id ${o.id} must be ${p.id}×10 + n`);
      for (const x of o.values) if (!child(x.id, o.id, 100)) add(`${at}.options`, `option value id ${x.id} must be ${o.id}×100 + n`);
    }
    for (const img of p.images) if (!child(img.id, p.id, 10)) add(`${at}.images`, `image id ${img.id} must be ${p.id}×10 + n`);

    // A photo is *real* iff data/photos/manifest.json lists its key (BUG-14 r1): the hand-set
    // `placeholder` flag must agree with that, never decide it. Invented products show only
    // generated placeholders (a real component with a placeholder price may show a real photo).
    p.images.forEach((img, j) => {
      const real = photoByKey.has(img.key);
      if (real && img.placeholder) add(`${at}.images[${j}]`, `${img.key} is a real photo (data/photos/manifest.json): placeholder: true is not allowed`);
      if (!isReal && real) add(`${at}.images[${j}]`, `invented product ${p.id} may not use the real photo ${img.key}`);
      if (!isReal && !img.placeholder) add(`${at}.images[${j}]`, 'image of an invented product must be placeholder: true');
    });

    // Images: keys, files, sizes.
    const keys = new Set();
    p.images.forEach((img, j) => {
      const iat = `${at}.images[${j}]`;
      if (!IMAGE_KEY.test(img.key)) return add(iat, `key "${img.key}" must be a lowercase relative path under data/photos/`);
      if (keys.has(img.key)) add(iat, `key "${img.key}" used twice in this product`);
      keys.add(img.key);
      const file = join(seed.photosDir, img.key);
      if (!existsSync(file)) return add(iat, `file data/photos/${img.key} does not exist`);
      const bytes = statSync(file).size;
      if (bytes > MAX_PHOTO_BYTES) add(iat, `data/photos/${img.key} is ${bytes} bytes (max ${MAX_PHOTO_BYTES})`);
      const size = imageSize(readFileSync(file));
      if (!size) add(iat, `data/photos/${img.key}: not a readable JPEG/PNG`);
      else if (size.width !== img.width || size.height !== img.height) {
        add(iat, `width/height ${img.width}×${img.height} but the file is ${size.width}×${size.height}`);
      }
    });
    // Printed prices (BUG-14): a real photo may only print prices this product actually sells at,
    // in any gallery position — a stale or foreign price misleads wherever it appears.
    const prices = new Set(p.variants.map((x) => x.priceDzd));
    p.images.forEach((img, j) => {
      const entry = photoByKey.get(img.key);
      if (!entry) {
        // Not a real photo: it must be a generated placeholder (they print no price).
        if (!img.placeholder) add(`${at}.images[${j}]`, `real photo ${img.key} has no data/photos/manifest.json entry (printedPrices)`);
        return;
      }
      // Checked whatever the image's placeholder flag says.
      const wrong = entry.printedPrices.filter((x) => !prices.has(x));
      if (wrong.length) {
        add(`${at}.images[${j}]`, `photo ${img.key} prints ${wrong.join(' / ')} DZD, but product ${p.id} sells at ${[...prices].join(' / ')} DZD`);
      }
    });
    const positions = p.images.map((img) => img.position);
    if (new Set(positions).size !== positions.length) add(`${at}.images`, 'duplicate image position');
  }

  // 2c. Settings: home products must be published.
  const productById = new Map(seed.products.map(({ product }) => [product.id, product]));
  for (const pid of [...seed.settings.homeFeaturedProductIds, seed.settings.homeHeroProductId]) {
    if (pid !== null && productById.get(pid) && productById.get(pid).status !== 'active') {
      add('settings', `home product ${pid} is not active`);
    }
  }

  // 2d. Provenance: every real product (and real image) says where it comes from.
  const prov = seed.provenance;
  if (!prov) {
    add('provenance.json', 'missing');
  } else {
    for (const x of prov.products ?? []) if (!productById.has(x.productId)) add('provenance.json', `product ${x.productId} does not exist`);
    const categoryIds = new Set(seed.categories.map((c) => c.id));
    for (const x of prov.categories ?? []) if (!categoryIds.has(x.categoryId)) add('provenance.json', `category ${x.categoryId} does not exist`);
    const imageById = new Map();
    for (const { product } of seed.products) for (const img of product.images) imageById.set(img.id, img);
    const provImages = new Map((prov.images ?? []).map((x) => [x.imageId, x]));
    for (const x of prov.images ?? []) {
      const img = imageById.get(x.imageId);
      if (!img) add('provenance.json', `image ${x.imageId} does not exist`);
      else if (img.key !== x.key) add('provenance.json', `image ${x.imageId}: key "${x.key}" ≠ catalogue key "${img.key}"`);
      if (!['client_own', 'supplier_render'].includes(x.source)) add('provenance.json', `image ${x.imageId}: source must be client_own or supplier_render`);
      if (x.source === 'supplier_render' && x.needsClientConfirmation !== true) add('provenance.json', `image ${x.imageId}: supplier_render needs needsClientConfirmation: true`);
    }
    for (const [id, img] of imageById) {
      // Real = manifest key or flagged real, whatever the flag says (BUG-14 r1).
      const real = photoByKey.has(img.key) || !img.placeholder;
      if (real && !provImages.has(id)) add('provenance.json', `real image ${id} (${img.key}) has no provenance entry`);
    }
  }

  return issues;
}

/** Loads and validates the seed under `repoRoot`. */
export function validateSeed(repoRoot) {
  return validateLoadedSeed(loadSeed(repoRoot));
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const issues = validateSeed(root);
  if (issues.length) {
    console.error(`seed catalogue: ${issues.length} issue(s)`);
    for (const i of issues) console.error(`  ${i.path}: ${i.message}`);
    process.exit(1);
  }
  const seed = loadSeed(root);
  console.log(`seed catalogue OK: ${seed.categories.length} categories, ${seed.products.length} products, ` +
    `${seed.products.reduce((n, p) => n + p.product.variants.length, 0)} variants, ` +
    `${seed.products.reduce((n, p) => n + p.product.images.length, 0)} images`);
}
