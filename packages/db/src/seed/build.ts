// DB-3: turn the repo's seed data into idempotent SQL statements for local D1.
//
// Pure (no I/O): the CLI loads the data and runs the statements; tests run them on SQLite.
// Every row is an UPSERT on its primary key (or `email` for admin users), so a re-run updates
// rows in place and never touches orders, customers, events or the audit log. Link tables
// (variant_option_values, pack_items) are replaced per parent row.
//
// The input types are the CatalogSnapshot shapes from CAT-1 (`packages/catalog/src/types.ts`),
// restated structurally here so this module does not depend on the catalog package's build.

export type Localized<T> = { readonly ar: T; readonly fr: T };
type Lang = 'ar' | 'fr';

export interface SeedImage {
  readonly id: number;
  readonly variantId: number | null;
  /** CAT-1 @3dfd9a0: optional; absent = null. Exclusive with variantId. */
  readonly optionValueId?: number | null;
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly alt: Localized<string>;
  readonly position: number;
  readonly placeholder: boolean;
}

export interface SeedCategory {
  readonly id: number;
  readonly parentId: number | null;
  readonly slug: Localized<string>;
  readonly name: Localized<string>;
  readonly description: Localized<string> | null;
  readonly sort: number;
  readonly active: boolean;
  readonly placeholder: boolean;
  readonly translationPlaceholder?: readonly Lang[];
  readonly image?: SeedImage | null;
}

export interface SeedProduct {
  readonly id: number;
  readonly kind: 'simple' | 'variable' | 'pack';
  readonly categoryId: number;
  readonly slug: Localized<string>;
  readonly name: Localized<string>;
  readonly brandLatin: string | null;
  readonly summary: Localized<string>;
  readonly description: Localized<string>;
  readonly status: 'draft' | 'active' | 'archived';
  readonly placeholder: boolean;
  readonly sort: number;
  readonly translationPlaceholder?: readonly Lang[];
  readonly options: readonly {
    readonly id: number;
    readonly type: 'size' | 'colour' | 'other';
    readonly name: Localized<string>;
    readonly position: number;
    readonly values: readonly {
      readonly id: number;
      readonly value: Localized<string>;
      readonly swatchHex: string | null;
      readonly position: number;
    }[];
  }[];
  readonly variants: readonly {
    readonly id: number;
    readonly sku: string;
    readonly priceDzd: number;
    readonly compareAtDzd: number | null;
    readonly stock: number | null;
    readonly weightG: number | null;
    readonly active: boolean;
    readonly isDefault: boolean;
    readonly optionValueIds: readonly number[];
  }[];
  readonly packItems: readonly { readonly variantId: number; readonly qty: number }[];
  readonly images: readonly SeedImage[];
}

export interface SeedContentPage {
  readonly id: number;
  readonly key: string;
  readonly slug: Localized<string>;
  readonly title: Localized<string>;
  readonly summary: Localized<string>;
  readonly body: Localized<readonly unknown[]>;
  readonly sort: number;
  readonly active: boolean;
  readonly placeholder: boolean;
  readonly updatedAt?: number;
}

export interface SeedWilaya {
  readonly code: number;
  readonly name_fr: string;
  readonly name_ar: string;
  readonly courier_code?: string | null;
}
export interface SeedCommune {
  readonly id: number;
  readonly wilaya_code: number;
  readonly name_fr: string;
  readonly name_ar: string;
  readonly postal_code?: string | null;
}
export interface SeedFee {
  readonly wilaya_code: number;
  readonly fee_dzd: number;
  readonly available: boolean;
  /** Seed fees are invented unless the data says otherwise. */
  readonly placeholder?: boolean;
}
export interface SeedAdminUser {
  readonly email: string;
  readonly name: string;
  readonly role: 'owner' | 'confirmer' | 'logistics' | 'content';
  readonly active: boolean;
}

export interface SeedInput {
  readonly wilayas: readonly SeedWilaya[];
  readonly communes: readonly SeedCommune[];
  readonly fees: readonly SeedFee[];
  readonly categories: readonly SeedCategory[];
  readonly products: readonly SeedProduct[];
  readonly contentPages: readonly SeedContentPage[];
  readonly settings: Readonly<Record<string, unknown>>;
  /** Dev only. Production gets admin users from the owner, never from a migration or seed. */
  readonly adminUsers: readonly SeedAdminUser[];
  /**
   * Prices printed on each real photo, by image key (data/photos/manifest.json, seed BUG-14). A key
   * absent here (a generated placeholder photo) prints none: [].
   */
  readonly printedPrices?: Readonly<Record<string, readonly number[]>>;
}

export interface Statement {
  readonly sql: string;
  readonly params: readonly (string | number | null)[];
}

const b = (v: boolean): number => (v ? 1 : 0);
const json = (v: unknown): string => JSON.stringify(v);

/** `INSERT … ON CONFLICT(<key>) DO UPDATE SET <every other column> = excluded.<column>`. */
function upsert(table: string, key: readonly string[], row: Record<string, string | number | null>): Statement {
  const cols = Object.keys(row);
  const set = cols.filter((c) => !key.includes(c)).map((c) => `"${c}" = excluded."${c}"`);
  const sql =
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})` +
    ` ON CONFLICT(${key.map((c) => `"${c}"`).join(', ')}) DO ${set.length ? `UPDATE SET ${set.join(', ')}` : 'NOTHING'}`;
  return { sql, params: cols.map((c) => row[c] ?? null) };
}

/** Parents before children, so the self-referencing FK holds on every insert. */
export function categoriesInTreeOrder(categories: readonly SeedCategory[]): SeedCategory[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const depth = (c: SeedCategory, seen = new Set<number>()): number => {
    if (c.parentId === null) return 0;
    if (seen.has(c.id)) throw new Error(`category cycle at ${c.id}`);
    seen.add(c.id);
    const parent = byId.get(c.parentId);
    if (!parent) throw new Error(`category ${c.id}: unknown parent ${c.parentId}`);
    return 1 + depth(parent, seen);
  };
  const depths = new Map(categories.map((c) => [c.id, depth(c)])); // validates every row, even a lone one
  return [...categories].sort((a, z) => depths.get(a.id)! - depths.get(z.id)! || a.id - z.id);
}

function imageRow(img: SeedImage, owner: { productId: number } | { categoryId: number }, printed: Readonly<Record<string, readonly number[]>>) {
  return upsert('images', ['id'], {
    id: img.id,
    product_id: 'productId' in owner ? owner.productId : null,
    category_id: 'categoryId' in owner ? owner.categoryId : null,
    variant_id: img.variantId,
    option_value_id: img.optionValueId ?? null,
    r2_key: img.key,
    width: img.width,
    height: img.height,
    alt_fr: img.alt.fr,
    alt_ar: img.alt.ar,
    position: img.position,
    placeholder: b(img.placeholder),
    printed_prices_dzd: json(printed[img.key] ?? []),
  });
}

/** All statements, in foreign-key order: reference data, then the catalogue. */
export function buildSeedStatements(input: SeedInput): Statement[] {
  return [...buildReferenceStatements(input), ...buildCatalogueStatements(input)];
}

/**
 * Reference data: wilayas, communes, fees, dev admin users. Plain idempotent upserts, safe to run in
 * any number of batches (1,541 communes make one D1 batch too large for the local proxy's RPC).
 */
export function buildReferenceStatements(input: SeedInput): Statement[] {
  const out: Statement[] = [];

  for (const w of input.wilayas) {
    out.push(upsert('wilayas', ['code'], { code: w.code, name_fr: w.name_fr, name_ar: w.name_ar, courier_code: w.courier_code ?? null }));
  }
  for (const c of input.communes) {
    out.push(
      upsert('communes', ['id'], { id: c.id, wilaya_code: c.wilaya_code, name_fr: c.name_fr, name_ar: c.name_ar, postal_code: c.postal_code ?? null }),
    );
  }
  for (const f of input.fees) {
    out.push(upsert('delivery_fees', ['wilaya_code'], { wilaya_code: f.wilaya_code, fee_dzd: f.fee_dzd, available: b(f.available), placeholder: b(f.placeholder ?? true) }));
  }
  for (const u of input.adminUsers) {
    out.push(upsert('admin_users', ['email'], { email: u.email.toLowerCase(), name: u.name, role: u.role, active: b(u.active) }));
  }
  return out;
}

/**
 * The catalogue (categories, products and their children, content pages, settings), converging to
 * data/. Run as ONE batch: it deletes rows that left data/ and must apply completely or not at all.
 */
export function buildCatalogueStatements(input: SeedInput): Statement[] {
  const out: Statement[] = [];

  for (const c of categoriesInTreeOrder(input.categories)) {
    out.push(
      upsert('categories', ['id'], {
        id: c.id,
        parent_id: c.parentId,
        slug_fr: c.slug.fr,
        slug_ar: c.slug.ar,
        name_fr: c.name.fr,
        name_ar: c.name.ar,
        description_fr: c.description?.fr ?? null,
        description_ar: c.description?.ar ?? null,
        sort: c.sort,
        active: b(c.active),
        placeholder: b(c.placeholder),
        translation_placeholder: json(c.translationPlaceholder ?? []),
      }),
    );
  }

  for (const p of input.products) {
    out.push(
      upsert('products', ['id'], {
        id: p.id,
        kind: p.kind,
        category_id: p.categoryId,
        slug_fr: p.slug.fr,
        slug_ar: p.slug.ar,
        name_fr: p.name.fr,
        name_ar: p.name.ar,
        brand_latin: p.brandLatin,
        summary_fr: p.summary.fr,
        summary_ar: p.summary.ar,
        description_fr: p.description.fr,
        description_ar: p.description.ar,
        status: p.status,
        sort: p.sort,
        placeholder: b(p.placeholder),
        translation_placeholder: json(p.translationPlaceholder ?? []),
      }),
    );
  }

  // Convergence (DB-3 r3): a re-run makes every seeded product's child rows equal data/. Rows of a
  // seeded product that are no longer in data/ are deleted BEFORE the upserts (this also frees a SKU
  // when a variant id is renamed). Pack contents of every seeded pack go first, so a dropped variant
  // is no longer referenced by them. A variant still referenced by an order line (or by a pack that
  // is not in data/) is protected by its FK (RESTRICT): the batch aborts. The CLI refuses earlier
  // with a report (blockedVariantDeletions). Orders, customers, events and audit are never touched.
  for (const p of input.products) out.push({ sql: 'DELETE FROM "pack_items" WHERE "pack_product_id" = ?', params: [p.id] });
  for (const p of input.products) {
    out.push(notIn('DELETE FROM "images" WHERE "product_id" = ?', [p.id], 'id', p.images.map((i) => i.id)));
    out.push(notIn('DELETE FROM "variants" WHERE "product_id" = ?', [p.id], 'id', p.variants.map((v) => v.id)));
    out.push(
      notIn(
        'DELETE FROM "option_values" WHERE "option_id" IN (SELECT "id" FROM "product_options" WHERE "product_id" = ?)',
        [p.id],
        'id',
        p.options.flatMap((o) => o.values.map((v) => v.id)),
      ),
    );
    out.push(notIn('DELETE FROM "product_options" WHERE "product_id" = ?', [p.id], 'id', p.options.map((o) => o.id)));
  }
  for (const c of input.categories) {
    out.push(notIn('DELETE FROM "images" WHERE "category_id" = ?', [c.id], 'id', c.image ? [c.image.id] : []));
  }

  for (const p of input.products) {
    for (const o of p.options) {
      out.push(upsert('product_options', ['id'], { id: o.id, product_id: p.id, kind: o.type, name_fr: o.name.fr, name_ar: o.name.ar, position: o.position }));
      for (const v of o.values) {
        out.push(
          upsert('option_values', ['id'], { id: v.id, option_id: o.id, value_fr: v.value.fr, value_ar: v.value.ar, swatch_hex: v.swatchHex, position: v.position }),
        );
      }
    }
    // Clear the default first so moving it to another variant never trips the one-default index.
    out.push({ sql: 'UPDATE "variants" SET "is_default" = 0 WHERE "product_id" = ? AND "is_default" = 1', params: [p.id] });
    p.variants.forEach((v, i) => {
      out.push(
        upsert('variants', ['id'], {
          id: v.id,
          product_id: p.id,
          sku: v.sku,
          price_dzd: v.priceDzd,
          compare_at_dzd: v.compareAtDzd,
          stock: v.stock,
          weight_g: v.weightG,
          active: b(v.active),
          is_default: b(v.isDefault),
          position: i,
        }),
      );
      out.push({ sql: 'DELETE FROM "variant_option_values" WHERE "variant_id" = ?', params: [v.id] });
      for (const ov of v.optionValueIds) {
        out.push({ sql: 'INSERT INTO "variant_option_values" ("variant_id", "option_value_id") VALUES (?, ?)', params: [v.id, ov] });
      }
    });
  }

  // Pack contents and images after every variant exists (a pack may list a later product's variant).
  for (const p of input.products) {
    p.packItems.forEach((it, i) => {
      out.push({ sql: 'INSERT INTO "pack_items" ("pack_product_id", "variant_id", "qty", "position") VALUES (?, ?, ?, ?)', params: [p.id, it.variantId, it.qty, i] });
    });
    for (const img of p.images) out.push(imageRow(img, { productId: p.id }, input.printedPrices ?? {}));
  }
  for (const c of input.categories) {
    if (c.image) out.push(imageRow(c.image, { categoryId: c.id }, input.printedPrices ?? {}));
  }

  for (const cp of input.contentPages) {
    out.push(
      upsert('content_pages', ['id'], {
        id: cp.id,
        key: cp.key,
        slug_fr: cp.slug.fr,
        slug_ar: cp.slug.ar,
        title_fr: cp.title.fr,
        title_ar: cp.title.ar,
        summary_fr: cp.summary.fr,
        summary_ar: cp.summary.ar,
        body_fr: json(cp.body.fr),
        body_ar: json(cp.body.ar),
        sort: cp.sort,
        active: b(cp.active),
        placeholder: b(cp.placeholder),
        ...(cp.updatedAt === undefined ? {} : { updated_at: cp.updatedAt }),
      }),
    );
  }

  for (const [key, value] of Object.entries(input.settings)) {
    out.push(upsert('settings', ['key'], { key, value: json(value ?? null) }));
  }
  return out;
}

/**
 * `<base> AND "<col>" NOT IN (keep)`. The keep-list travels as ONE JSON parameter (json_each), so the
 * statement stays under D1's 100-bound-parameter limit however large the catalogue grows.
 */
function notIn(base: string, params: readonly number[], col: string, keep: readonly number[]): Statement {
  return { sql: `${base} AND "${col}" NOT IN (SELECT value FROM json_each(?))`, params: [...params, JSON.stringify(keep)] };
}

/**
 * Read-only check run BEFORE seeding: variants the seed would delete (dropped from data/) that an
 * order line or a pack outside data/ still references. Non-empty ⇒ the seed must refuse.
 */
export function blockedVariantDeletionsQuery(input: Pick<SeedInput, 'products'>): Statement[] {
  const packs = JSON.stringify(input.products.map((p) => p.id));
  return input.products.map((p) => ({
    sql:
      `SELECT v."id" AS id, v."sku" AS sku, ` +
      `(SELECT count(*) FROM "order_items" oi WHERE oi."variant_id" = v."id") AS order_lines, ` +
      `(SELECT count(*) FROM "pack_items" pi WHERE pi."variant_id" = v."id" AND pi."pack_product_id" NOT IN (SELECT value FROM json_each(?))) AS other_packs ` +
      `FROM "variants" v WHERE v."product_id" = ? AND v."id" NOT IN (SELECT value FROM json_each(?)) ` +
      `AND (order_lines > 0 OR other_packs > 0)`,
    params: [packs, p.id, JSON.stringify(p.variants.map((v) => v.id))],
  }));
}

/** Distinct R2 keys referenced by image rows (what the seed uploads to local R2). */
export function referencedImageKeys(input: Pick<SeedInput, 'products' | 'categories'>): string[] {
  const keys = new Set<string>();
  for (const p of input.products) for (const i of p.images) keys.add(i.key);
  for (const c of input.categories) if (c.image) keys.add(c.image.key);
  return [...keys].sort();
}
