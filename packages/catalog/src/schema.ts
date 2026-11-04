/**
 * CAT-1 Valibot validator for `CatalogSnapshot`.
 *  - `CatalogSnapshotSchema`: structure (strict objects: unknown keys are errors, so typos and
 *    schema drift surface at build time, not as missing content on a page).
 *  - `checkSnapshotIntegrity`: cross-references and the product invariants from `types.ts`.
 *  - `validateSnapshot` / `parseSnapshot`: both together.
 */
import * as v from 'valibot';
import { RESERVED_SEGMENTS, SNAPSHOT_VERSION, type CatalogSnapshot, type Id } from './types.ts';

const id = v.pipe(v.number(), v.integer(), v.minValue(1));
const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));
const text = v.string();
const dzd = v.pipe(v.number(), v.integer(), v.minValue(1));
const sortKey = v.pipe(v.number(), v.integer());
const epochMs = v.pipe(v.number(), v.integer(), v.minValue(0));
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = v.pipe(
  v.string(),
  v.regex(SLUG, 'slug must be ASCII kebab-case'),
  v.check((s) => !RESERVED_SEGMENTS.includes(s), 'slug is a reserved URL segment'),
);

const langs = v.pipe(
  v.array(v.picklist(['ar', 'fr'])),
  v.check((l) => new Set(l).size === l.length, 'duplicate language'),
);
const localized = <T extends v.GenericSchema>(schema: T) => v.strictObject({ ar: schema, fr: schema });

const MetaSchema = v.strictObject({
  version: v.literal(SNAPSHOT_VERSION),
  source: v.picklist(['seed', 'd1']),
  generatedAt: epochMs,
  publishRunId: v.nullable(id),
});

const CategorySchema = v.strictObject({
  id,
  parentId: v.nullable(id),
  slug: localized(slug),
  name: localized(nonEmpty),
  description: v.nullable(localized(text)),
  sort: sortKey,
  active: v.boolean(),
  placeholder: v.boolean(),
  translationPlaceholder: langs,
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
  sku: v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'sku must be ASCII')),
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
  key: nonEmpty,
  width: v.pipe(v.number(), v.integer(), v.minValue(1)),
  height: v.pipe(v.number(), v.integer(), v.minValue(1)),
  alt: localized(text),
  position: sortKey,
  placeholder: v.boolean(),
});

const ProductSchema = v.strictObject({
  id,
  kind: v.picklist(['simple', 'variable', 'pack']),
  categoryId: id,
  slug: localized(slug),
  name: localized(nonEmpty),
  brandLatin: v.nullable(nonEmpty),
  summary: localized(text),
  description: localized(text),
  status: v.picklist(['draft', 'active', 'archived']),
  placeholder: v.boolean(),
  translationPlaceholder: langs,
  sort: sortKey,
  options: v.array(OptionSchema),
  variants: v.pipe(v.array(VariantSchema), v.minLength(1)),
  packItems: v.array(PackItemSchema),
  images: v.array(ImageSchema),
});

const linkHref = v.pipe(
  v.string(),
  v.check(
    (h) => /^\/(?!\/)/.test(h) || /^tel:\+?\d+$/.test(h) || /^https:\/\/wa\.me\/\d+$/.test(h),
    'link href must be a same-origin path, tel: or https://wa.me/',
  ),
);

const ContentBlockSchema = v.variant('type', [
  v.strictObject({ type: v.literal('h2'), text: nonEmpty }),
  v.strictObject({ type: v.literal('p'), text: nonEmpty }),
  v.strictObject({ type: v.literal('ul'), items: v.pipe(v.array(nonEmpty), v.minLength(1)) }),
  v.strictObject({ type: v.literal('ol'), items: v.pipe(v.array(nonEmpty), v.minLength(1)) }),
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
  turnstileSiteKey: v.nullable(nonEmpty),
});

const WilayaSchema = v.strictObject({
  code: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(69)),
  name: localized(nonEmpty),
  courierCode: v.nullable(nonEmpty),
});

export const CatalogSnapshotSchema = v.strictObject({
  meta: MetaSchema,
  categories: v.array(CategorySchema),
  products: v.array(ProductSchema),
  contentPages: v.array(ContentPageSchema),
  settings: SettingsSchema,
  wilayas: v.array(WilayaSchema),
});

// Compile-time guarantee: whatever the schema accepts satisfies the hand-written contract.
type Parsed = v.InferOutput<typeof CatalogSnapshotSchema>;
const _contractCheck = (p: Parsed): CatalogSnapshot => p;
void _contractCheck;

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

/** Cross-reference checks on a structurally valid snapshot. Empty array = valid. */
export function checkSnapshotIntegrity(s: CatalogSnapshot): SnapshotIssue[] {
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
  uniq('products[].images', s.products.flatMap((p) => p.images.map((x) => x.id)));
  uniq('contentPages', s.contentPages.map((c) => c.id));
  uniq('contentPages[].key', s.contentPages.map((c) => c.key));
  uniq('wilayas', s.wilayas.map((w) => w.code));

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
  const variantOwner = new Map<Id, { productId: Id; kind: string }>();
  for (const p of s.products) for (const x of p.variants) variantOwner.set(x.id, { productId: p.id, kind: p.kind });

  s.products.forEach((p, i) => {
    const at = `products[${i}]`;
    if (!catById.has(p.categoryId)) add(`${at}.categoryId`, `unknown category ${p.categoryId}`);

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
      const owner = variantOwner.get(it.variantId);
      if (!owner) add(`${at}.packItems[${j}].variantId`, `unknown variant ${it.variantId}`);
      else if (owner.kind === 'pack') add(`${at}.packItems[${j}].variantId`, 'a pack cannot contain a pack');
    });
    for (const d of duplicates(p.packItems.map((it) => it.variantId))) add(`${at}.packItems`, `variant ${d} listed twice`);

    const ownVariants = new Set(p.variants.map((x) => x.id));
    p.images.forEach((img, j) => {
      if (img.variantId !== null && !ownVariants.has(img.variantId)) add(`${at}.images[${j}].variantId`, `variant ${img.variantId} is not in this product`);
    });
    if (p.status === 'active' && !p.images.some((img) => img.variantId === null)) {
      add(`${at}.images`, 'active product needs ≥ 1 product-level image');
    }
  });

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

/** Structure + integrity. Never throws. */
export function validateSnapshot(input: unknown): SnapshotResult {
  const parsed = v.safeParse(CatalogSnapshotSchema, input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.issues.map((i) => ({ path: v.getDotPath(i) ?? '', message: i.message })),
    };
  }
  const issues = checkSnapshotIntegrity(parsed.output);
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
export function parseSnapshot(input: unknown, source?: string): CatalogSnapshot {
  const r = validateSnapshot(input);
  if (!r.ok) throw new SnapshotError(r.issues, source);
  return r.snapshot;
}
