/**
 * CAT-1 Valibot validator for `CatalogSnapshot`.
 *  - `CatalogSnapshotSchema`: structure (strict objects: unknown keys are errors, so typos and
 *    schema drift surface at build time, not as missing content on a page).
 *  - `checkSnapshotIntegrity`: cross-references and the product invariants from `types.ts`.
 *  - `validateSnapshot` / `parseSnapshot`: both together.
 */
import * as v from 'valibot';
import { RESERVED_ORDER_SLUGS, RESERVED_SEGMENTS, SNAPSHOT_VERSION, type CatalogSnapshot, type Id, type ProductKind, type SnapshotProduct } from './types.ts';
import { isContentLinkHref, isImageKey } from './url.ts';

const id = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * Text safety: no C0/C1 control characters and no bidi embedding/override/isolate controls
 * (U+202A–U+202E, U+2066–U+2069: they can visually reorder names, prices or refs), no U+2028/2029
 * line/paragraph separators. Newlines are allowed only in multi-line fields. ZWJ/ZWNJ and LRM/RLM
 * stay allowed (legitimate in Arabic) but a label made only of invisible characters is empty.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
// eslint-disable-next-line no-control-regex
const UNSAFE_MULTILINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** Invisible characters that do not make a label non-empty (zero-width space/joiners, word joiner, BOM, LRM/RLM, ALM). */
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff\u061c]/g;
export const isSafeLine = (s: string): boolean => !UNSAFE_LINE.test(s);
export const isSafeMultiline = (s: string): boolean => !UNSAFE_MULTILINE.test(s);
/** One-line text, may be empty. */
const line = (max: number) =>
  v.pipe(v.string(), v.maxLength(max), v.check(isSafeLine, 'control or bidi-override character in text'));
/** One-line text, non-empty after trimming. */
const label = (max = 200) => v.pipe(line(max), v.check((s) => s.replace(INVISIBLE, '').trim().length > 0, 'must not be empty'));
/** Multi-line plain text (paragraphs separated by blank lines). */
const multiline = (max: number) =>
  v.pipe(v.string(), v.maxLength(max), v.check(isSafeMultiline, 'control or bidi-override character in text'));
const nonEmpty = label();
const text = line(500);
const dzd = v.pipe(v.number(), v.integer(), v.minValue(1));
const sortKey = v.pipe(v.number(), v.integer());
const epochMs = v.pipe(v.number(), v.integer(), v.minValue(0));
/** Per-language slug: ASCII kebab-case. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = v.pipe(
  v.string(),
  v.regex(SLUG, 'slug must be ASCII kebab-case'),
  v.check((s) => !RESERVED_SEGMENTS.includes(s), 'slug is a reserved URL segment'),
);
/** Product slugs also live under /{lang}/order/<slug>/ (ORDER-STEP). */
const productSlug = v.pipe(
  slug,
  v.check((s) => !RESERVED_ORDER_SLUGS.includes(s), 'product slug collides with an /order/ route (confirmation, review)'),
);

const langs = v.pipe(
  v.array(v.picklist(['ar', 'fr'])),
  v.check((l) => new Set(l).size === l.length, 'duplicate language'),
);
const localized = <T extends v.GenericSchema>(schema: T) => v.strictObject({ ar: schema, fr: schema });

const MetaSchema = v.strictObject({
  version: v.literal(SNAPSHOT_VERSION),
  source: v.picklist(['seed', 'd1', 'fixture']),
  generatedAt: epochMs,
  publishRunId: v.nullable(id),
});

const OptionValueSchema = v.strictObject({
  id,
  value: localized(nonEmpty),
  swatchHex: v.nullable(v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/, 'swatchHex must be lowercase #rrggbb'))),
  position: sortKey,
});

const OptionSchema = v.strictObject({
  id,
  type: v.picklist(['size', 'colour', 'other']),
  name: localized(nonEmpty),
  position: sortKey,
  values: v.pipe(v.array(OptionValueSchema), v.minLength(1)),
});

const VariantSchema = v.strictObject({
  id,
  sku: v.pipe(v.string(), v.maxLength(64), v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'sku must be ASCII')),
  priceDzd: dzd,
  compareAtDzd: v.nullable(dzd),
  stock: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  weightG: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  active: v.boolean(),
  isDefault: v.boolean(),
  optionValueIds: v.array(id),
});

const PackItemSchema = v.strictObject({
  variantId: id,
  qty: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const ImageSchema = v.strictObject({
  id,
  variantId: v.nullable(id),
  optionValueId: v.exactOptional(v.nullable(id)),
  key: v.pipe(v.string(), v.check(isImageKey, 'image key must be a relative path of lowercase [a-z0-9._-] segments')),
  width: v.pipe(v.number(), v.integer(), v.minValue(1)),
  height: v.pipe(v.number(), v.integer(), v.minValue(1)),
  alt: localized(line(300)),
  position: sortKey,
  placeholder: v.boolean(),
  printedPricesDzd: v.exactOptional(v.array(v.pipe(v.number(), v.integer(), v.minValue(0)))),
});

const CategorySchema = v.strictObject({
  id,
  parentId: v.nullable(id),
  slug: localized(slug),
  name: localized(nonEmpty),
  description: v.nullable(localized(multiline(2000))),
  sort: sortKey,
  active: v.boolean(),
  placeholder: v.boolean(),
  translationPlaceholder: langs,
  image: v.exactOptional(v.nullable(ImageSchema)),
});

const ProductSchema = v.strictObject({
  id,
  kind: v.picklist(['simple', 'variable', 'pack']),
  categoryId: v.nullable(id),
  slug: localized(productSlug),
  name: localized(nonEmpty),
  brandLatin: v.nullable(nonEmpty),
  summary: localized(line(500)),
  description: localized(multiline(10_000)),
  status: v.picklist(['draft', 'active', 'archived']),
  placeholder: v.boolean(),
  translationPlaceholder: langs,
  sort: sortKey,
  options: v.array(OptionSchema),
  variants: v.pipe(v.array(VariantSchema), v.minLength(1)),
  packItems: v.array(PackItemSchema),
  images: v.array(ImageSchema),
});

/** Content links go through the shared allow-list (`url.ts`). */
const linkHref = v.pipe(v.string(), v.check(isContentLinkHref, 'link href must be a same-origin path, tel: or https://wa.me/'));

const ContentBlockSchema = v.variant('type', [
  v.strictObject({ type: v.literal('h2'), text: nonEmpty }),
  v.strictObject({ type: v.literal('p'), text: label(5000) }),
  v.strictObject({ type: v.literal('ul'), items: v.pipe(v.array(label(1000)), v.minLength(1)) }),
  v.strictObject({ type: v.literal('ol'), items: v.pipe(v.array(label(1000)), v.minLength(1)) }),
  v.strictObject({ type: v.literal('link'), text: nonEmpty, href: linkHref }),
]);

const ContentPageSchema = v.strictObject({
  id,
  key: v.picklist(['about', 'delivery', 'returns', 'contact', 'legal', 'privacy']),
  slug: localized(slug),
  title: localized(nonEmpty),
  summary: localized(text),
  body: localized(v.array(ContentBlockSchema)),
  sort: sortKey,
  active: v.boolean(),
  placeholder: v.boolean(),
  updatedAt: epochMs,
});

const SettingsSchema = v.strictObject({
  storeName: localized(nonEmpty),
  contactPhone: v.pipe(v.string(), v.regex(/^0\d{9}$/, 'contactPhone must be national format 0XXXXXXXXX')),
  whatsapp: v.pipe(v.string(), v.regex(/^213\d{9}$/, 'whatsapp must be E.164 digits without +, e.g. 213779942022')),
  contactEmail: v.nullable(v.pipe(v.string(), v.email())),
  homeFeaturedProductIds: v.array(id),
  homeHeroProductId: v.nullable(id),
  turnstileSiteKey: v.nullable(v.pipe(v.string(), v.regex(/^[0-9A-Za-z_-]{1,64}$/, 'turnstileSiteKey must be [0-9A-Za-z_-]{1,64}'))),
  cartEnabled: v.boolean('cartEnabled must be true or false'),
  metaPixel: v.nullable(
    v.strictObject({
      pixelId: v.pipe(
        v.string('metaPixelId must be a string of 15 or 16 digits'),
        v.regex(/^\d{15,16}$/, 'metaPixelId must be 15 or 16 digits (Events Manager → Data sources → the Pixel/dataset ID)'),
        v.check((s) => /[1-9]/.test(s), 'metaPixelId must not be all zeros'),
      ),
      consentRequired: v.boolean('metaConsentRequired must be true or false'),
    }),
  ),
});

const WilayaSchema = v.strictObject({
  code: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(69)),
  name: localized(nonEmpty),
  courierCode: v.nullable(v.pipe(v.string(), v.regex(/^[0-9A-Za-z_-]{1,16}$/, 'courierCode must be [0-9A-Za-z_-]{1,16}'))),
});

export const CatalogSnapshotSchema = v.strictObject({
  meta: MetaSchema,
  categories: v.array(CategorySchema),
  products: v.array(ProductSchema),
  contentPages: v.array(ContentPageSchema),
  settings: SettingsSchema,
  wilayas: v.array(WilayaSchema),
});

// Compile-time guarantee, both directions: whatever the schema accepts satisfies the hand-written
// contract, and the contract has no field or wider union the schema does not have.
type Parsed = v.InferOutput<typeof CatalogSnapshotSchema>;
type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
const _contractCheck = (p: Parsed): CatalogSnapshot => p;
const _reverseCheck = (s: CatalogSnapshot): DeepReadonly<Parsed> => s;
void _contractCheck;
void _reverseCheck;

// ---------------------------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------------------------

export interface SnapshotIssue {
  /** e.g. `products[3].variants[1].optionValueIds`. */
  readonly path: string;
  readonly message: string;
}

function duplicates<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const dup = new Set<T>();
  for (const i of items) (seen.has(i) ? dup : seen).add(i);
  return [...dup];
}

export interface ProductIntegrityContext {
  /** Kind of the product owning each variant id (pack items may only reference non-pack ones). */
  readonly variantKindById: ReadonlyMap<Id, ProductKind>;
  /** Category ids that exist. */
  readonly categoryIds: ReadonlySet<Id>;
}

/**
 * Per-product invariants (see `SnapshotProduct`). Pure, no I/O: the admin calls it before a
 * product is activated, so nothing it saves can break `validateSnapshot` at publish.
 * `at` prefixes issue paths.
 */
export function checkProductIntegrity(p: SnapshotProduct, ctx: ProductIntegrityContext, at = 'product'): SnapshotIssue[] {
  const issues: SnapshotIssue[] = [];
  const add = (path: string, message: string): void => void issues.push({ path, message });
  
  if (p.categoryId !== null && !ctx.categoryIds.has(p.categoryId)) add(`${at}.categoryId`, `unknown category ${p.categoryId}`);

  const active = p.variants.filter((x) => x.active);
  const defaults = active.filter((x) => x.isDefault);
  if (p.status === 'active' && active.length === 0) add(`${at}.variants`, 'active product has no active variant');
  if (active.length > 0 && defaults.length !== 1) add(`${at}.variants`, `expected exactly one default active variant, found ${defaults.length}`);
  if (p.variants.some((x) => x.isDefault && !x.active)) add(`${at}.variants`, 'default variant is inactive');

  p.variants.forEach((x, j) => {
    if (x.compareAtDzd !== null && x.compareAtDzd <= x.priceDzd) add(`${at}.variants[${j}].compareAtDzd`, 'must be greater than priceDzd');
  });

  if (p.kind !== 'variable') {
    if (p.variants.length !== 1) add(`${at}.variants`, `${p.kind} product must have exactly 1 variant`);
    if (p.options.length > 0) add(`${at}.options`, `${p.kind} product must have no options`);
    p.variants.forEach((x, j) => {
      if (x.optionValueIds.length > 0) add(`${at}.variants[${j}].optionValueIds`, `${p.kind} variant must have no option values`);
    });
  } else {
    if (p.options.length === 0) add(`${at}.options`, 'variable product needs ≥ 1 option');
    const valueToOption = new Map<Id, Id>();
    for (const o of p.options) for (const x of o.values) valueToOption.set(x.id, o.id);
    const combos: string[] = [];
    p.variants.forEach((x, j) => {
      const vat = `${at}.variants[${j}].optionValueIds`;
      const optionsHit = x.optionValueIds.map((vid) => valueToOption.get(vid));
      if (optionsHit.some((o) => o === undefined)) return add(vat, 'references a value not in this product');
      if (x.optionValueIds.length !== p.options.length || new Set(optionsHit).size !== p.options.length) {
        return add(vat, 'must hold exactly one value of each option');
      }
      combos.push([...x.optionValueIds].sort((a, b) => a - b).join('-'));
    });
    for (const d of duplicates(combos)) add(`${at}.variants`, `two variants share option combination ${d}`);
  }

  p.options.forEach((o, j) => {
    if (o.type !== 'colour' && o.values.some((x) => x.swatchHex !== null)) add(`${at}.options[${j}]`, 'swatchHex only on colour options');
  });

  if (p.kind === 'pack') {
    if (p.packItems.length === 0) add(`${at}.packItems`, 'pack needs ≥ 1 item');
  } else if (p.packItems.length > 0) {
    add(`${at}.packItems`, 'only packs have pack items');
  }
  p.packItems.forEach((it, j) => {
    const kind = ctx.variantKindById.get(it.variantId);
    if (kind === undefined) add(`${at}.packItems[${j}].variantId`, `unknown variant ${it.variantId}`);
    else if (kind === 'pack') add(`${at}.packItems[${j}].variantId`, 'a pack cannot contain a pack');
  });
  for (const d of duplicates(p.packItems.map((it) => it.variantId))) add(`${at}.packItems`, `variant ${d} listed twice`);

  const ownVariants = new Set(p.variants.map((x) => x.id));
  const ownValues = new Set(p.options.flatMap((o) => o.values.map((x) => x.id)));
  p.images.forEach((img, j) => {
    if (img.variantId !== null && !ownVariants.has(img.variantId)) add(`${at}.images[${j}].variantId`, `variant ${img.variantId} is not in this product`);
    const ov = img.optionValueId ?? null;
    if (ov !== null && img.variantId !== null) add(`${at}.images[${j}]`, 'an image binds to a variant or to an option value, not both');
    if (ov !== null && !ownValues.has(ov)) add(`${at}.images[${j}].optionValueId`, `option value ${ov} is not in this product`);
  });
  if (p.status === 'active' && !p.images.some((img) => img.variantId === null && (img.optionValueId ?? null) === null)) {
    add(`${at}.images`, 'active product needs ≥ 1 general image (no variant or option-value binding)');
  }
  return issues;
}

/** Cross-reference checks on a structurally valid snapshot. Empty array = valid. */
export interface IntegrityOptions {
  /**
   * Require exactly the 69 wilayas, codes 1–69 (the order form's picker comes from this list).
   * Default true. False only for partial snapshots: fixtures, seed-only validation, `partial` dev
   * builds.
   */
  readonly requireAllWilayas?: boolean;
}

export const WILAYA_COUNT = 69;

export function checkSnapshotIntegrity(s: CatalogSnapshot, opts: IntegrityOptions = {}): SnapshotIssue[] {
  const issues: SnapshotIssue[] = [];
  const add = (path: string, message: string): void => void issues.push({ path, message });

  // Unique ids per table (global for child rows, like D1).
  const uniq = (path: string, ids: readonly (Id | string)[]): void => {
    for (const d of duplicates(ids)) add(path, `duplicate id ${String(d)}`);
  };
  uniq('categories', s.categories.map((c) => c.id));
  uniq('products', s.products.map((p) => p.id));
  uniq('products[].options', s.products.flatMap((p) => p.options.map((o) => o.id)));
  uniq('products[].options[].values', s.products.flatMap((p) => p.options.flatMap((o) => o.values.map((x) => x.id))));
  uniq('products[].variants', s.products.flatMap((p) => p.variants.map((x) => x.id)));
  uniq('products[].variants[].sku', s.products.flatMap((p) => p.variants.map((x) => x.sku)));
  uniq('images', [
    ...s.products.flatMap((p) => p.images.map((x) => x.id)),
    ...s.categories.flatMap((c) => (c.image ? [c.image.id] : [])),
  ]);
  s.categories.forEach((c, i) => {
    if (c.image && (c.image.variantId !== null || (c.image.optionValueId ?? null) !== null)) {
      add(`categories[${i}].image`, 'category image cannot bind to a variant or option value');
    }
  });
  uniq('contentPages', s.contentPages.map((c) => c.id));
  uniq('contentPages[].key', s.contentPages.map((c) => c.key));
  uniq('wilayas', s.wilayas.map((w) => w.code));
  if (opts.requireAllWilayas !== false) {
    const codes = new Set(s.wilayas.map((w) => w.code));
    const missing = Array.from({ length: WILAYA_COUNT }, (_, i) => i + 1).filter((c) => !codes.has(c));
    if (missing.length) add('wilayas', `missing wilaya codes ${missing.join(', ')} (all ${WILAYA_COUNT} are required)`);
  }

  // Unique slugs per entity type and language. Content slugs live at /<lang>/<slug>/ and must not
  // collide with each other; categories and products have their own prefixes.
  for (const lang of ['ar', 'fr'] as const) {
    for (const d of duplicates(s.categories.map((c) => c.slug[lang]))) add(`categories[].slug.${lang}`, `duplicate slug "${d}"`);
    for (const d of duplicates(s.products.map((p) => p.slug[lang]))) add(`products[].slug.${lang}`, `duplicate slug "${d}"`);
    for (const d of duplicates(s.contentPages.map((c) => c.slug[lang]))) add(`contentPages[].slug.${lang}`, `duplicate slug "${d}"`);
  }

  // Category tree: parents exist, no cycles.
  const catById = new Map(s.categories.map((c) => [c.id, c]));
  s.categories.forEach((c, i) => {
    if (c.parentId === null) return;
    if (!catById.has(c.parentId)) return add(`categories[${i}].parentId`, `unknown category ${c.parentId}`);
    const seen = new Set<Id>([c.id]);
    let cur = catById.get(c.parentId);
    while (cur) {
      if (seen.has(cur.id)) return add(`categories[${i}].parentId`, `cycle through category ${cur.id}`);
      seen.add(cur.id);
      cur = cur.parentId === null ? undefined : catById.get(cur.parentId);
    }
  });

  // Products.
  const variantKindById = new Map<Id, ProductKind>();
  for (const p of s.products) for (const x of p.variants) variantKindById.set(x.id, p.kind);
  const ctx: ProductIntegrityContext = { variantKindById, categoryIds: new Set(s.categories.map((c) => c.id)) };
  s.products.forEach((p, i) => issues.push(...checkProductIntegrity(p, ctx, `products[${i}]`)));

  // Settings references.
  const productIds = new Set(s.products.map((p) => p.id));
  s.settings.homeFeaturedProductIds.forEach((pid, i) => {
    if (!productIds.has(pid)) add(`settings.homeFeaturedProductIds[${i}]`, `unknown product ${pid}`);
  });
  if (s.settings.homeHeroProductId !== null && !productIds.has(s.settings.homeHeroProductId)) {
    add('settings.homeHeroProductId', `unknown product ${s.settings.homeHeroProductId}`);
  }

  return issues;
}

export type SnapshotResult =
  | { readonly ok: true; readonly snapshot: CatalogSnapshot }
  | { readonly ok: false; readonly issues: readonly SnapshotIssue[] };

/**
 * Structure only (the Valibot schema, no cross-references). For callers that assemble a partial
 * snapshot themselves (seed's validate.mjs) without importing Valibot. Empty array = valid.
 */
export function checkSnapshotStructure(input: unknown): SnapshotIssue[] {
  const parsed = v.safeParse(CatalogSnapshotSchema, input);
  return parsed.success ? [] : parsed.issues.map((i) => ({ path: v.getDotPath(i) ?? '', message: i.message }));
}

/** Structure + integrity. Never throws. */
export function validateSnapshot(input: unknown, opts: IntegrityOptions = {}): SnapshotResult {
  const parsed = v.safeParse(CatalogSnapshotSchema, input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.issues.map((i) => ({ path: v.getDotPath(i) ?? '', message: i.message })),
    };
  }
  const issues = checkSnapshotIntegrity(parsed.output, opts);
  return issues.length ? { ok: false, issues } : { ok: true, snapshot: parsed.output };
}

export class SnapshotError extends Error {
  readonly issues: readonly SnapshotIssue[];
  constructor(issues: readonly SnapshotIssue[], source = 'snapshot') {
    super(
      `${source}: ${issues.length} issue(s)\n` +
        issues.slice(0, 50).map((i) => `  ${i.path}: ${i.message}`).join('\n'),
    );
    this.name = 'SnapshotError';
    this.issues = issues;
  }
}

/** Structure + integrity; throws `SnapshotError` listing every issue. */
export function parseSnapshot(input: unknown, source?: string, opts: IntegrityOptions = {}): CatalogSnapshot {
  const r = validateSnapshot(input, opts);
  if (!r.ok) throw new SnapshotError(r.issues, source);
  return r.snapshot;
}
