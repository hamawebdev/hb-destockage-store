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
//     marking (a product not listed in provenance.json is invented: placeholder: true and all its
//     images placeholder; "[PLACEHOLDER]" in placeholder descriptions); home products are active;
//     provenance.json entries exist and cover every real image (supplier renders flagged
//     needsClientConfirmation).
// Used by `db` (seed loader, before loading D1) and `pagedata` (fromSeed, before the build).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { CatalogSnapshotSchema, checkSnapshotIntegrity } from '@hb/catalog/schema';

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
  const parsed = v.safeParse(CatalogSnapshotSchema, snapshot);
  if (!parsed.success) {
    for (const i of parsed.issues) add(where(v.getDotPath(i) ?? ''), i.message);
    return issues;
  }
  // CAT-1 integrity.
  for (const i of checkSnapshotIntegrity(parsed.output, { requireAllWilayas: false })) add(where(i.path), i.message);

  // A product is *real* (the client's) iff provenance.json lists it; everything else is invented.
  // Categories are all ours (the client had only "Non classé"), so they say nothing about realness.
  const provProducts = new Set((seed.provenance?.products ?? []).map((x) => x.productId));

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
    // Invented products have invented photos (a real component with a placeholder price may show a
    // real photo).
    if (!isReal) p.images.forEach((img, j) => {
      if (!img.placeholder) add(`${at}.images[${j}]`, 'image of an invented product must be placeholder: true');
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
      if (!img.placeholder && !provImages.has(id)) add('provenance.json', `real image ${id} (${img.key}) has no provenance entry`);
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
