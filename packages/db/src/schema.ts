// DB-1 — Drizzle schema contract for the single D1 database (SQLite, location hint `weur`).
//
// Conventions (binding for every consumer):
// - Money: integer DZD, column suffix `_dzd`. Never REAL.
// - Content: bilingual pairs `*_fr` / `*_ar`; per-language slugs; `brand_latin` for Latin names.
// - Time: integer Unix epoch milliseconds (`*_at`), JS `number`. SQL default = now (ms).
// - Enums: TEXT with a CHECK constraint listing the values (see ./enums.ts).
// - Booleans: INTEGER 0/1 with a CHECK; JS `boolean`.
// - JSON: TEXT with a `json_valid()` CHECK; JS type given by `$type<>()`.
// - `placeholder` (boolean) marks seed content that is not the client's real data.
// - D1 enforces foreign keys. Rows referenced by orders are never deleted: products and variants
//   are archived/deactivated instead (ON DELETE RESTRICT on order references).
// - D1 is never read while a visitor waits for a page (CLAUDE.md). Only `/api/quote`, `/api/order`,
//   `/api/rum`, the admin and jobs touch it.

import { relations, sql, type SQL } from 'drizzle-orm';
import type { OrderFlag } from '@hb/shared';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import {
  ACTOR_TYPES,
  ADMIN_ROLES,
  CONTENT_PAGE_KEYS,
  COURIER_CHECK_RESULTS,
  COURIER_DIRECTORY_KINDS,
  DELIVERY_EXCEPTION_KINDS,
  DELIVERY_EXCEPTION_STATES,
  DELIVERY_STATUSES,
  DELIVERY_TYPES,
  type DbLang,
  type ContentBlockJson,
  LANGS,
  OPTION_KINDS,
  ORDER_EVENT_TYPES,
  ORDER_STATUSES,
  PRODUCT_KINDS,
  PRODUCT_STATUSES,
  PUBLISH_STATUSES,
  RUM_METRICS,
  RUM_RATINGS,
  SHEETS_CONNECTION_STATUSES,
  SHIPMENT_COURIER_STATUSES,
  SHIPMENT_EVENT_SOURCES,
  SHIPMENT_EVENT_STATES,
  SHIPMENT_STATES,
  TURNSTILE_RESULTS,
  WEBHOOK_INBOX_STATES,
} from './enums.ts';

// ---------------------------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------------------------

/** Current time as integer epoch ms, evaluated by SQLite (D1 and better-sqlite3 both ≥ 3.42). */
export const NOW_MS: SQL = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

const createdAt = () => integer('created_at').notNull().default(NOW_MS);
const updatedAt = () =>
  integer('updated_at')
    .notNull()
    .default(NOW_MS)
    .$onUpdateFn(() => Date.now());
const bool = (name: string, def: boolean) =>
  integer(name, { mode: 'boolean' }).notNull().default(def);

/**
 * Bare column identifier for CHECK / partial-index SQL. Drizzle would otherwise emit
 * `"table"."col"`, which breaks when drizzle-kit rebuilds a table as `__new_<table>`.
 */
const c = (col: AnySQLiteColumn): SQL => sql`${sql.identifier(col.name)}`;
/** `col IN ('a','b',…)` for a CHECK constraint. Values are compile-time constants. */
const oneOf = (col: AnySQLiteColumn, values: readonly string[]): SQL =>
  sql`${c(col)} in (${sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', '))})`;
/** ASCII kebab-case: `^[a-z0-9]+(-[a-z0-9]+)*$` (Arabic slugs are transliterated). */
const slugCheck = (col: AnySQLiteColumn): SQL =>
  sql`${c(col)} <> '' and ${c(col)} not glob '*[^a-z0-9-]*' and ${c(col)} not glob '-*' and ${c(col)} not glob '*-' and ${c(col)} not glob '*--*'`;
const isBool = (col: AnySQLiteColumn): SQL => sql`${c(col)} in (0, 1)`;
const nonNeg = (col: AnySQLiteColumn): SQL => sql`${c(col)} >= 0`;
const nullOrNonNeg = (col: AnySQLiteColumn): SQL => sql`${c(col)} is null or ${c(col)} >= 0`;
const isJson = (col: AnySQLiteColumn): SQL => sql`json_valid(${c(col)})`;
/** Algerian mobile in E.164: `+213` + 9 digits starting 5, 6 or 7 (full rule lives in @hb/shared). */
const phoneCheck = (col: AnySQLiteColumn): SQL =>
  sql`length(${c(col)}) = 13 and ${c(col)} glob '+213[567][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'`;
const nullOrJson = (col: AnySQLiteColumn): SQL => sql`${c(col)} is null or json_valid(${c(col)})`;

/** JSON array of languages whose text is our translation, not the client's (CAT-1). */
const translationPlaceholder = () =>
  text('translation_placeholder', { mode: 'json' }).$type<DbLang[]>().notNull().default(sql`'[]'`);
/**
 * CHECK: a JSON array of distinct 'ar' / 'fr'. SQLite forbids subqueries in CHECK, so the allowed
 * serialisations (JSON.stringify output, no spaces) are listed.
 */
const langArray = (col: AnySQLiteColumn): SQL =>
  sql`${c(col)} in ('[]', '["ar"]', '["fr"]', '["ar","fr"]', '["fr","ar"]')`;

// ---------------------------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------------------------

export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    parentId: integer('parent_id').references((): AnySQLiteColumn => categories.id, {
      onDelete: 'restrict',
    }),
    slugFr: text('slug_fr').notNull(),
    slugAr: text('slug_ar').notNull(),
    nameFr: text('name_fr').notNull(),
    nameAr: text('name_ar').notNull(),
    descriptionFr: text('description_fr'),
    descriptionAr: text('description_ar'),
    sort: integer('sort').notNull().default(0),
    active: bool('active', true),
    placeholder: bool('placeholder', false),
    translationPlaceholder: translationPlaceholder(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('categories_translation_placeholder', langArray(t.translationPlaceholder)),
    uniqueIndex('categories_slug_fr_uq').on(t.slugFr),
    uniqueIndex('categories_slug_ar_uq').on(t.slugAr),
    index('categories_parent_idx').on(t.parentId, t.sort),
    check('categories_slug_fr_fmt', slugCheck(t.slugFr)),
    check('categories_slug_ar_fmt', slugCheck(t.slugAr)),
    check('categories_active_bool', isBool(t.active)),
    check('categories_placeholder_bool', isBool(t.placeholder)),
    check('categories_not_own_parent', sql`${c(t.parentId)} is null or ${c(t.parentId)} <> ${c(t.id)}`),
  ],
);

export const products = sqliteTable(
  'products',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: PRODUCT_KINDS }).notNull().default('simple'),
    /** NULL = no category: the product is sold (home, search, own page) but listed under no category. */
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'restrict' }),
    slugFr: text('slug_fr').notNull(),
    slugAr: text('slug_ar').notNull(),
    nameFr: text('name_fr').notNull(),
    nameAr: text('name_ar').notNull(),
    /** Latin brand / model name shown inside `<bdi>` on Arabic pages. */
    brandLatin: text('brand_latin'),
    /** One or two sentences, plain text (cards, meta description). */
    summaryFr: text('summary_fr').notNull().default(''),
    summaryAr: text('summary_ar').notNull().default(''),
    /** Plain-text paragraphs separated by blank lines. No HTML, no Markdown. */
    descriptionFr: text('description_fr').notNull().default(''),
    descriptionAr: text('description_ar').notNull().default(''),
    status: text('status', { enum: PRODUCT_STATUSES }).notNull().default('draft'),
    sort: integer('sort').notNull().default(0),
    placeholder: bool('placeholder', false),
    translationPlaceholder: translationPlaceholder(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('products_translation_placeholder', langArray(t.translationPlaceholder)),
    uniqueIndex('products_slug_fr_uq').on(t.slugFr),
    uniqueIndex('products_slug_ar_uq').on(t.slugAr),
    index('products_category_idx').on(t.categoryId, t.status, t.sort),
    check('products_slug_fr_fmt', slugCheck(t.slugFr)),
    check('products_slug_ar_fmt', slugCheck(t.slugAr)),
    check('products_kind_enum', oneOf(t.kind, PRODUCT_KINDS)),
    check('products_status_enum', oneOf(t.status, PRODUCT_STATUSES)),
    check('products_placeholder_bool', isBool(t.placeholder)),
  ],
);

export const productOptions = sqliteTable(
  'product_options',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: OPTION_KINDS }).notNull(),
    nameFr: text('name_fr').notNull(),
    nameAr: text('name_ar').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    index('product_options_product_idx').on(t.productId, t.position),
    check('product_options_kind_enum', oneOf(t.kind, OPTION_KINDS)),
  ],
);

export const optionValues = sqliteTable(
  'option_values',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    optionId: integer('option_id')
      .notNull()
      .references(() => productOptions.id, { onDelete: 'cascade' }),
    valueFr: text('value_fr').notNull(),
    valueAr: text('value_ar').notNull(),
    /** `#rrggbb` (lower case) for colour options, else NULL. */
    swatchHex: text('swatch_hex'),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    index('option_values_option_idx').on(t.optionId, t.position),
    check(
      'option_values_swatch_hex',
      sql`${c(t.swatchHex)} is null or (length(${c(t.swatchHex)}) = 7 and ${c(t.swatchHex)} glob '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')`,
    ),
  ],
);

/** Every product has ≥ 1 variant; order lines always reference a variant. */
export const variants = sqliteTable(
  'variants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    sku: text('sku').notNull(),
    priceDzd: integer('price_dzd').notNull(),
    /** "Was" price shown struck through; NULL when there is none, else > price_dzd. */
    compareAtDzd: integer('compare_at_dzd'),
    /** NULL = stock not tracked. Decremented atomically on order creation. */
    stock: integer('stock'),
    weightG: integer('weight_g'),
    active: bool('active', true),
    isDefault: bool('is_default', false),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('variants_sku_uq').on(t.sku),
    index('variants_product_idx').on(t.productId, t.position),
    /** At most one default variant per product. */
    uniqueIndex('variants_one_default_uq').on(t.productId).where(sql`${c(t.isDefault)} = 1`),
    check('variants_price_nonneg', nonNeg(t.priceDzd)),
    check(
      'variants_compare_at_gt_price',
      sql`${c(t.compareAtDzd)} is null or ${c(t.compareAtDzd)} > ${c(t.priceDzd)}`,
    ),
    check('variants_stock_nonneg', nullOrNonNeg(t.stock)),
    check('variants_weight_nonneg', nullOrNonNeg(t.weightG)),
    check('variants_active_bool', isBool(t.active)),
    check('variants_is_default_bool', isBool(t.isDefault)),
  ],
);

export const variantOptionValues = sqliteTable(
  'variant_option_values',
  {
    variantId: integer('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    optionValueId: integer('option_value_id')
      .notNull()
      .references(() => optionValues.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.variantId, t.optionValueId] }),
    index('variant_option_values_value_idx').on(t.optionValueId),
  ],
);

/** Contents of a pack product (`products.kind = 'pack'`). The pack sells through its own variant. */
export const packItems = sqliteTable(
  'pack_items',
  {
    packProductId: integer('pack_product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    variantId: integer('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'restrict' }),
    qty: integer('qty').notNull().default(1),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.packProductId, t.variantId] }),
    index('pack_items_variant_idx').on(t.variantId),
    check('pack_items_qty_pos', sql`${c(t.qty)} > 0`),
  ],
);

export const images = sqliteTable(
  'images',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Exactly one of `product_id` / `category_id` is set. */
    productId: integer('product_id').references(() => products.id, { onDelete: 'cascade' }),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'cascade' }),
    /** Set when the photo shows one specific variant. Product images only. */
    variantId: integer('variant_id').references(() => variants.id, { onDelete: 'set null' }),
    /**
     * Set when the photo shows one option value (e.g. the red colour, for every red variant).
     * Never together with `variant_id` (trigger in 0003; added after DB-1, so no CHECK rebuild).
     */
    optionValueId: integer('option_value_id').references(() => optionValues.id, { onDelete: 'set null' }),
    /**
     * Key of the original in R2 = its path relative to `data/photos/` for seeded photos. Not unique:
     * two products may show the same photo; delete the R2 object only when no row references it.
     */
    r2Key: text('r2_key').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    altFr: text('alt_fr').notNull(),
    altAr: text('alt_ar').notNull(),
    position: integer('position').notNull().default(0),
    placeholder: bool('placeholder', false),
    createdAt: createdAt(),
    /**
     * Prices (integer DZD) printed on the photo, [] = none (DB-8). The admin refuses to activate a
     * product whose photo prints a price none of its variants has (BUG-14). Guarded by triggers
     * (0008): a JSON array of non-negative integers.
     */
    printedPricesDzd: text('printed_prices_dzd', { mode: 'json' }).$type<number[]>().notNull().default(sql`'[]'`),
  },
  (t) => [
    index('images_r2_key_idx').on(t.r2Key),
    index('images_product_idx').on(t.productId, t.position),
    index('images_category_idx').on(t.categoryId, t.position),
    index('images_variant_idx').on(t.variantId),
    index('images_option_value_idx').on(t.optionValueId),
    check('images_one_owner', sql`(${c(t.productId)} is null) <> (${c(t.categoryId)} is null)`),
    check('images_variant_needs_product', sql`${c(t.variantId)} is null or ${c(t.productId)} is not null`),
    check('images_dims_pos', sql`${c(t.width)} > 0 and ${c(t.height)} > 0`),
    check('images_placeholder_bool', isBool(t.placeholder)),
  ],
);

// ---------------------------------------------------------------------------------------------
// Geography and delivery
// ---------------------------------------------------------------------------------------------

/**
 * 69 wilayas (Law 26-06). `courier_code` = the courier's own wilaya code (58-wilaya scheme until
 * the transfer completes), NULL until the courier integration fills it (DECISIONS D-001).
 */
export const wilayas = sqliteTable(
  'wilayas',
  {
    code: integer('code').primaryKey(),
    nameFr: text('name_fr').notNull(),
    nameAr: text('name_ar').notNull(),
    courierCode: text('courier_code'),
  },
  (t) => [
    check('wilayas_code_range', sql`${c(t.code)} between 1 and 69`),
  ],
);

/** 1,541 communes. `id` is the dataset's stable commune id (supplied by `data/geo`). */
export const communes = sqliteTable(
  'communes',
  {
    id: integer('id').primaryKey(),
    wilayaCode: integer('wilaya_code')
      .notNull()
      .references(() => wilayas.code, { onDelete: 'restrict' }),
    nameFr: text('name_fr').notNull(),
    nameAr: text('name_ar').notNull(),
    /** Text: Algerian postal codes have a leading zero (e.g. "01000"). */
    postalCode: text('postal_code'),
  },
  (t) => [index('communes_wilaya_idx').on(t.wilayaCode)],
);

/** Admin-set home-delivery fee per wilaya (today's FeeProvider source). */
export const deliveryFees = sqliteTable(
  'delivery_fees',
  {
    wilayaCode: integer('wilaya_code')
      .primaryKey()
      .references(() => wilayas.code, { onDelete: 'restrict' }),
    feeDzd: integer('fee_dzd').notNull(),
    available: bool('available', true),
    /**
     * True for invented seed fees (data/geo/fees.seed.json). Only the local seed writes true; a fee
     * saved by the owner in the admin is real (false). Production never runs the seed.
     */
    placeholder: bool('placeholder', false),
    updatedBy: integer('updated_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('delivery_fees_fee_nonneg', nonNeg(t.feeDzd)),
    check('delivery_fees_available_bool', isBool(t.available)),
  ],
);

// ---------------------------------------------------------------------------------------------
// Customers and orders
// ---------------------------------------------------------------------------------------------

export const customers = sqliteTable(
  'customers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** `+2135XXXXXXXX` etc., produced by `@hb/shared` normalizePhone. */
    phoneE164: text('phone_e164').notNull(),
    /** Latest name given on an order. */
    name: text('name').notNull(),
    orderCount: integer('order_count').notNull().default(0),
    deliveredCount: integer('delivered_count').notNull().default(0),
    returnedCount: integer('returned_count').notNull().default(0),
    cancelledCount: integer('cancelled_count').notNull().default(0),
    /** JSON array of flag strings, e.g. ["frequent_returns"]. */
    flags: text('flags', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    blocked: bool('blocked', false),
    notes: text('notes'),
    lastOrderAt: integer('last_order_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('customers_phone_uq').on(t.phoneE164),
    check('customers_phone_e164', phoneCheck(t.phoneE164)),
    check(
      'customers_counts_nonneg',
      sql`${c(t.orderCount)} >= 0 and ${c(t.deliveredCount)} >= 0 and ${c(t.returnedCount)} >= 0 and ${c(t.cancelledCount)} >= 0`,
    ),
    check('customers_flags_json', isJson(t.flags)),
    check('customers_blocked_bool', isBool(t.blocked)),
  ],
);

export const orders = sqliteTable(
  'orders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Public reference, e.g. `HB-7K2Q9`. Shown to the customer inside `<bdi>`. */
    ref: text('ref').notNull(),
    /** UUID made at form render; a repeat submit returns the original order. */
    idempotencyKey: text('idempotency_key').notNull(),
    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    phoneE164: text('phone_e164').notNull(),
    wilayaCode: integer('wilaya_code')
      .notNull()
      .references(() => wilayas.code, { onDelete: 'restrict' }),
    communeId: integer('commune_id')
      .notNull()
      .references(() => communes.id, { onDelete: 'restrict' }),
    /** Street address, completed by the confirmer during the call (not on the form). */
    address: text('address'),
    lang: text('lang', { enum: LANGS }).notNull(),
    status: text('status', { enum: ORDER_STATUSES }).notNull().default('new'),
    callAttempts: integer('call_attempts').notNull().default(0),
    subtotalDzd: integer('subtotal_dzd').notNull(),
    feeDzd: integer('fee_dzd').notNull(),
    totalDzd: integer('total_dzd').notNull(),
    /** Which FeeProvider priced the delivery (`@hb/shared` FeeSource, e.g. `table`). */
    feeSource: text('fee_source').notNull(),
    /** JSON array of flag strings (`@hb/shared` ORDER_FLAGS). Non-empty ⇒ review before shipping. */
    flags: text('flags', { mode: 'json' }).$type<OrderFlag[]>().notNull().default(sql`'[]'`),
    turnstile: text('turnstile', { enum: TURNSTILE_RESULTS }),
    /** Form fill time in ms (render → submit), for the minimum-fill-time rule. */
    fillMs: integer('fill_ms'),
    /** 0–100 heuristic score; NULL when not computed. */
    riskScore: integer('risk_score'),
    /** Salted hash of the client IP (never the IP itself). Secondary rate-limit key. */
    ipHash: text('ip_hash'),
    courierName: text('courier_name'),
    courierTracking: text('courier_tracking'),
    /** When the confirmer should call again (unreachable / called). */
    nextCallAt: integer('next_call_at'),
    /** Soft lock: the confirmer working this order, until `claimed_until`. */
    claimedByUserId: integer('claimed_by_user_id').references(() => adminUsers.id, {
      onDelete: 'restrict',
    }),
    claimedUntil: integer('claimed_until'),
    /** Set once stock was given back (cancelled/returned); guards against a double restore. */
    stockRestoredAt: integer('stock_restored_at'),
    /** Optimistic-concurrency counter, bumped on every update. */
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('orders_ref_uq').on(t.ref),
    uniqueIndex('orders_idempotency_key_uq').on(t.idempotencyKey),
    // Admin list/filter indexes (AORD-0 plan §10) and the dedup lookup (phone + recent).
    index('orders_created_idx').on(t.createdAt, t.id),
    index('orders_status_created_idx').on(t.status, t.createdAt, t.id),
    index('orders_status_next_call_idx').on(t.status, t.nextCallAt),
    index('orders_wilaya_created_idx').on(t.wilayaCode, t.createdAt),
    index('orders_phone_created_idx').on(t.phoneE164, t.createdAt),
    index('orders_customer_created_idx').on(t.customerId, t.createdAt),
    index('orders_commune_idx').on(t.communeId),
    index('orders_flagged_created_idx').on(t.createdAt, t.id).where(sql`${c(t.flags)} <> '[]'`),
    // Sheets' per-minute change gate reads MAX(updated_at) from the index alone (SHEET-0).
    index('orders_updated_at_idx').on(t.updatedAt),
    check('orders_phone_e164', phoneCheck(t.phoneE164)),
    check('orders_lang_enum', oneOf(t.lang, LANGS)),
    check('orders_status_enum', oneOf(t.status, ORDER_STATUSES)),
    check('orders_turnstile_enum', sql`${c(t.turnstile)} is null or ${oneOf(t.turnstile, TURNSTILE_RESULTS)}`),
    check('orders_call_attempts_nonneg', nonNeg(t.callAttempts)),
    check('orders_money_nonneg', sql`${c(t.subtotalDzd)} >= 0 and ${c(t.feeDzd)} >= 0`),
    check('orders_total_sum', sql`${c(t.totalDzd)} = ${c(t.subtotalDzd)} + ${c(t.feeDzd)}`),
    check('orders_flags_json', isJson(t.flags)),
    check('orders_risk_range', sql`${c(t.riskScore)} is null or ${c(t.riskScore)} between 0 and 100`),
    check('orders_fill_ms_nonneg', nullOrNonNeg(t.fillMs)),
    check('orders_version_nonneg', nonNeg(t.version)),
  ],
);

export const orderItems = sqliteTable(
  'order_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    variantId: integer('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'restrict' }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    // Snapshots at order time (catalogue edits never change a placed order).
    nameFr: text('name_fr').notNull(),
    nameAr: text('name_ar').notNull(),
    /** e.g. "Rouge / XL"; NULL for a single-variant product. */
    variantLabelFr: text('variant_label_fr'),
    variantLabelAr: text('variant_label_ar'),
    sku: text('sku').notNull(),
    unitPriceDzd: integer('unit_price_dzd').notNull(),
    qty: integer('qty').notNull(),
    lineTotalDzd: integer('line_total_dzd').notNull(),
    /**
     * Units actually taken from `variants.stock` when the order was created: `qty` if the variant was
     * tracked then, 0 if untracked (NULL stock). A cancel/return restores exactly this (DB-4 r1).
     */
    stockTaken: integer('stock_taken').notNull().default(0),
  },
  (t) => [
    index('order_items_order_idx').on(t.orderId),
    // FK child indexes: SQLite scans the child table on parent DELETE/UPDATE without them.
    index('order_items_variant_idx').on(t.variantId),
    index('order_items_product_idx').on(t.productId),
    check('order_items_qty_pos', sql`${c(t.qty)} > 0`),
    check('order_items_unit_price_nonneg', nonNeg(t.unitPriceDzd)),
    check('order_items_line_total', sql`${c(t.lineTotalDzd)} = ${c(t.unitPriceDzd)} * ${c(t.qty)}`),
  ],
);

/** Append-only history of an order (DB-2 adds triggers that ABORT on UPDATE/DELETE). */
export const orderEvents = sqliteTable(
  'order_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    type: text('type', { enum: ORDER_EVENT_TYPES }).notNull(),
    fromStatus: text('from_status', { enum: ORDER_STATUSES }),
    toStatus: text('to_status', { enum: ORDER_STATUSES }),
    /** Call outcome or transition reason, e.g. `no_answer`, `wrong_number`, `customer_refused`. */
    outcome: text('outcome'),
    note: text('note'),
    actorType: text('actor_type', { enum: ACTOR_TYPES }).notNull(),
    actorUserId: integer('actor_user_id').references(() => adminUsers.id, { onDelete: 'restrict' }),
    at: integer('at').notNull().default(NOW_MS),
  },
  (t) => [
    index('order_events_order_idx').on(t.orderId, t.at),
    check('order_events_type_enum', oneOf(t.type, ORDER_EVENT_TYPES)),
    check('order_events_from_enum', sql`${c(t.fromStatus)} is null or ${oneOf(t.fromStatus, ORDER_STATUSES)}`),
    check('order_events_to_enum', sql`${c(t.toStatus)} is null or ${oneOf(t.toStatus, ORDER_STATUSES)}`),
    check('order_events_actor_enum', oneOf(t.actorType, ACTOR_TYPES)),
    check(
      'order_events_admin_has_user',
      sql`(${c(t.actorType)} = 'admin') = (${c(t.actorUserId)} is not null)`,
    ),
    check(
      'order_events_status_change_has_to',
      sql`${c(t.type)} <> 'status_change' or ${c(t.toStatus)} is not null`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Content, settings, admin
// ---------------------------------------------------------------------------------------------

export const contentPages = sqliteTable(
  'content_pages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Stable role used for links from templates (footer, order form). */
    key: text('key', { enum: CONTENT_PAGE_KEYS }).notNull(),
    slugFr: text('slug_fr').notNull(),
    slugAr: text('slug_ar').notNull(),
    titleFr: text('title_fr').notNull(),
    titleAr: text('title_ar').notNull(),
    /** One plain line for `<meta name="description">`. */
    summaryFr: text('summary_fr').notNull().default(''),
    summaryAr: text('summary_ar').notNull().default(''),
    /** JSON `ContentBlock[]` (CAT-1): structured, no HTML, no Markdown. */
    bodyFr: text('body_fr', { mode: 'json' }).$type<ContentBlockJson[]>().notNull().default(sql`'[]'`),
    bodyAr: text('body_ar', { mode: 'json' }).$type<ContentBlockJson[]>().notNull().default(sql`'[]'`),
    sort: integer('sort').notNull().default(0),
    active: bool('active', true),
    placeholder: bool('placeholder', false),
    updatedBy: integer('updated_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('content_pages_key_uq').on(t.key),
    uniqueIndex('content_pages_slug_fr_uq').on(t.slugFr),
    uniqueIndex('content_pages_slug_ar_uq').on(t.slugAr),
    check('content_pages_key_enum', oneOf(t.key, CONTENT_PAGE_KEYS)),
    check('content_pages_slug_fr_fmt', slugCheck(t.slugFr)),
    check('content_pages_slug_ar_fmt', slugCheck(t.slugAr)),
    check('content_pages_body_fr_json', sql`json_valid(${c(t.bodyFr)}) and json_type(${c(t.bodyFr)}) = 'array'`),
    check('content_pages_body_ar_json', sql`json_valid(${c(t.bodyAr)}) and json_type(${c(t.bodyAr)}) = 'array'`),
    check('content_pages_active_bool', isBool(t.active)),
    check('content_pages_placeholder_bool', isBool(t.placeholder)),
  ],
);

/**
 * Key/value settings, JSON values. Storefront keys (CAT-1 `SnapshotSettings`): `storeName`,
 * `contactPhone`, `whatsapp`, `contactEmail`, `homeFeaturedProductIds`, `homeHeroProductId`,
 * `turnstileSiteKey`. Other areas add their own camelCase keys (e.g. `orderDedupMinutes`).
 */
export const settings = sqliteTable(
  'settings',
  {
    key: text('key').primaryKey(),
    value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
    updatedBy: integer('updated_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [check('settings_value_json', isJson(t.value))],
);

/** Admin accounts. Production identity = Cloudflare Access email; no passwords stored. */
export const adminUsers = sqliteTable(
  'admin_users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Lower-case. Matched against the Access JWT `email` claim. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role', { enum: ADMIN_ROLES }).notNull(),
    active: bool('active', true),
    /** Admin UI language (per-user toggle). */
    uiLang: text('ui_lang', { enum: LANGS }).notNull().default('fr'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastSeenAt: integer('last_seen_at'),
  },
  (t) => [
    uniqueIndex('admin_users_email_uq').on(t.email),
    check('admin_users_email_lower', sql`${c(t.email)} = lower(${c(t.email)}) and ${c(t.email)} like '%_@_%'`),
    check('admin_users_role_enum', oneOf(t.role, ADMIN_ROLES)),
    check('admin_users_active_bool', isBool(t.active)),
    check('admin_users_ui_lang_enum', oneOf(t.uiLang, LANGS)),
  ],
);

/** Append-only audit trail of admin actions (DB-2 adds triggers that ABORT on UPDATE/DELETE). */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actorType: text('actor_type', { enum: ACTOR_TYPES }).notNull(),
    actorUserId: integer('actor_user_id').references(() => adminUsers.id, { onDelete: 'restrict' }),
    /** Email snapshot, kept even if the admin user is later renamed or deactivated. */
    actorEmail: text('actor_email'),
    /** Verb, e.g. `product.update`, `order.transition`, `fee.update`, `publish.request`. */
    action: text('action').notNull(),
    /** Table name, e.g. `products`. */
    entity: text('entity').notNull(),
    /** Primary key as text (string keys for `settings`). */
    entityId: text('entity_id'),
    before: text('before', { mode: 'json' }).$type<unknown>(),
    after: text('after', { mode: 'json' }).$type<unknown>(),
    /** Correlates rows written by one admin request (e.g. `cf-ray`). */
    requestId: text('request_id'),
    ipHash: text('ip_hash'),
    at: integer('at').notNull().default(NOW_MS),
  },
  (t) => [
    index('audit_log_actor_idx').on(t.actorUserId, t.at),
    index('audit_log_entity_idx').on(t.entity, t.entityId, t.at),
    index('audit_log_at_idx').on(t.at),
    check('audit_log_actor_enum', oneOf(t.actorType, ACTOR_TYPES)),
    check('audit_log_before_json', nullOrJson(t.before)),
    check('audit_log_after_json', nullOrJson(t.after)),
  ],
);

/** One row per admin "Publish" (D1 → snapshot → catalogue → astro build). */
export const publishRuns = sqliteTable(
  'publish_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    requestedBy: integer('requested_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    status: text('status', { enum: PUBLISH_STATUSES }).notNull().default('queued'),
    requestedAt: integer('requested_at').notNull().default(NOW_MS),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    /** SHA-256 of the exported CatalogSnapshot JSON. */
    snapshotSha256: text('snapshot_sha256'),
    productCount: integer('product_count'),
    buildMs: integer('build_ms'),
    /** Per-step timings in ms, e.g. `{"export":120,"catalog":900,"astro":14000}`. */
    timingsJson: text('timings_json', { mode: 'json' }).$type<Record<string, number>>(),
    /** Byte-budget result of the build; NULL until checked. */
    budgetOk: integer('budget_ok', { mode: 'boolean' }),
    error: text('error'),
    /** Last lines of build output + the printed deploy command (≤ 4 KiB, written by jobs). */
    logTail: text('log_tail'),
  },
  (t) => [
    /** At most one queued/running publish: a double-click fails on this index. */
    uniqueIndex('publish_runs_one_active_uq')
      .on(sql`(1)`)
      .where(sql`${c(t.status)} in ('queued', 'running')`),
    check('publish_runs_log_tail_len', sql`${c(t.logTail)} is null or length(${c(t.logTail)}) <= 4096`),
    check('publish_runs_timings_json', nullOrJson(t.timingsJson)),
    check('publish_runs_budget_ok_bool', sql`${c(t.budgetOk)} is null or ${c(t.budgetOk)} in (0, 1)`),
    index('publish_runs_requested_idx').on(t.requestedAt),
    check('publish_runs_status_enum', oneOf(t.status, PUBLISH_STATUSES)),
  ],
);

/** Real-user-monitoring beacons from `/api/rum`. No identifiers, no IP. */
export const rumEvents = sqliteTable(
  'rum_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull().default(NOW_MS),
    /** Template id, e.g. `product`, `home`. */
    template: text('template').notNull(),
    path: text('path').notNull(),
    lang: text('lang', { enum: LANGS }).notNull(),
    metric: text('metric', { enum: RUM_METRICS }).notNull(),
    value: real('value').notNull(),
    rating: text('rating', { enum: RUM_RATINGS }),
    /** `navigation.type` / prerender flag, e.g. `navigate`, `prerender`, `back_forward`. */
    navType: text('nav_type'),
    /** `navigator.connection.effectiveType` if present. */
    effectiveType: text('effective_type'),
    /** `request.cf.colo`, `request.cf.country`, `request.cf.asn` at the edge. */
    colo: text('colo'),
    country: text('country'),
    asn: integer('asn'),
    /** `nextHopProtocol` of the document, e.g. `h2`, `h3`. */
    proto: text('proto'),
    prerendered: bool('prerendered', false),
  },
  (t) => [
    index('rum_events_at_idx').on(t.at),
    index('rum_events_metric_idx').on(t.metric, t.template, t.at),
    check('rum_events_lang_enum', oneOf(t.lang, LANGS)),
    check('rum_events_metric_enum', oneOf(t.metric, RUM_METRICS)),
    check('rum_events_rating_enum', sql`${c(t.rating)} is null or ${oneOf(t.rating, RUM_RATINGS)}`),
    check('rum_events_value_nonneg', sql`${c(t.value)} >= 0`),
    check('rum_events_prerendered_bool', isBool(t.prerendered)),
  ],
);

/** Daily RUM roll-up written by `apps/jobs` (JOBS-5). Unknown colo = '', unknown asn = 0. */
export const rumDaily = sqliteTable(
  'rum_daily',
  {
    /** UTC day, `YYYY-MM-DD`. */
    day: text('day').notNull(),
    template: text('template').notNull(),
    lang: text('lang', { enum: LANGS }).notNull(),
    colo: text('colo').notNull().default(''),
    asn: integer('asn').notNull().default(0),
    n: integer('n').notNull(),
    ttfbP50: real('ttfb_p50'),
    ttfbP75: real('ttfb_p75'),
    lcpP50: real('lcp_p50'),
    lcpP75: real('lcp_p75'),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.template, t.lang, t.colo, t.asn] }),
    check('rum_daily_day_fmt', sql`${c(t.day)} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check('rum_daily_lang_enum', oneOf(t.lang, LANGS)),
    check('rum_daily_n_nonneg', nonNeg(t.n)),
  ],
);

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

/**
 * At-most-once notification delivery per order and channel (JOBS-2). A consumer takes a lease
 * (`status='sending'`, `lease_until`), sends, then marks `sent`.
 */
export const notificationDeliveries = sqliteTable(
  'notification_deliveries',
  {
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    /** e.g. `telegram`, `email`. */
    channel: text('channel').notNull(),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull().default('sending'),
    attempts: integer('attempts').notNull().default(0),
    leaseUntil: integer('lease_until'),
    sentAt: integer('sent_at'),
    lastError: text('last_error'),
    /** When the message was dead-lettered (status `dead`), epoch ms. */
    deadAt: integer('dead_at'),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.channel] }),
    index('notification_deliveries_status_dead_idx').on(t.status, t.deadAt),
    check('notification_deliveries_status_enum', oneOf(t.status, DELIVERY_STATUSES)),
    check('notification_deliveries_attempts_nonneg', nonNeg(t.attempts)),
  ],
);

// ---------------------------------------------------------------------------------------------
// Delivery (SHIP-0 contract, D-010)
// ---------------------------------------------------------------------------------------------

/** One account per courier id. Credentials are AES-GCM sealed (`secret-box.ts`), never plain. */
export const courierAccounts = sqliteTable(
  'courier_accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** `@hb/couriers` registry id; appears in the public webhook path. */
    courier: text('courier').notNull(),
    /** A courier is off until its keys are set and the owner enables it. */
    enabled: bool('enabled', false),
    credentialsCipher: text('credentials_cipher'),
    credentialsIv: text('credentials_iv'),
    keyVersion: integer('key_version'),
    /** Masked metadata only (`field → hint`); never a whole secret. */
    credentialsHint: text('credentials_hint', { mode: 'json' }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
    /** Non-secret settings: origin wilaya, `askCollection`, defaults. */
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    /** SHA-256 (hex) of the webhook URL token. The token itself is shown once and never stored. */
    webhookTokenHash: text('webhook_token_hash'),
    pollLeaseUntil: integer('poll_lease_until'),
    pollBackoffUntil: integer('poll_backoff_until'),
    lastPolledAt: integer('last_polled_at'),
    lastCheckResult: text('last_check_result', { enum: COURIER_CHECK_RESULTS }),
    lastCheckAt: integer('last_check_at'),
    updatedBy: integer('updated_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('courier_accounts_courier_uq').on(t.courier),
    uniqueIndex('courier_accounts_webhook_token_uq').on(t.webhookTokenHash),
    check('courier_accounts_enabled_bool', isBool(t.enabled)),
    check('courier_accounts_hint_json', isJson(t.credentialsHint)),
    check('courier_accounts_config_json', isJson(t.config)),
    check('courier_accounts_cipher_pair', sql`(${c(t.credentialsCipher)} is null) = (${c(t.credentialsIv)} is null)`),
    check('courier_accounts_check_enum', sql`${c(t.lastCheckResult)} is null or ${oneOf(t.lastCheckResult, COURIER_CHECK_RESULTS)}`),
  ],
);

/**
 * One attempt to hand an order to a courier. Partial unique index: at most one live parcel per
 * order, any courier. A row that holds the slot also blocks the order (triggers, migration 0012).
 */
export const shipments = sqliteTable(
  'shipments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    courier: text('courier').notNull(),
    accountId: integer('account_id')
      .notNull()
      .references(() => courierAccounts.id, { onDelete: 'restrict' }),
    state: text('state', { enum: SHIPMENT_STATES }).notNull().default('reserved'),
    /** Our order ref as sent to the courier. A resend reuses it, so a lookup can find an earlier parcel. */
    reference: text('reference').notNull(),
    tracking: text('tracking'),
    labelUrl: text('label_url'),
    /** Normalised status (`@hb/couriers` CourierStatus); NULL until the first event. */
    courierStatus: text('courier_status', { enum: SHIPMENT_COURIER_STATUSES }),
    courierStatusRaw: text('courier_status_raw'),
    courierStatusAt: integer('courier_status_at'),
    deliveryType: text('delivery_type', { enum: DELIVERY_TYPES }).notNull().default('home'),
    stopDeskId: text('stop_desk_id'),
    stopDeskName: text('stop_desk_name'),
    // Snapshot taken by the same version-guarded statement as the reservation.
    address: text('address'),
    codAmountDzd: integer('cod_amount_dzd').notNull(),
    feeDzd: integer('fee_dzd').notNull(),
    wilayaCode: integer('wilaya_code').notNull(),
    communeId: integer('commune_id').notNull(),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    attemptedAt: integer('attempted_at'),
    attemptEndedAt: integer('attempt_ended_at'),
    validateAttemptedAt: integer('validate_attempted_at'),
    acceptedAt: integer('accepted_at'),
    /** Set in the batch that moved the order to `shipped`; closes the slot. */
    appliedAt: integer('applied_at'),
    /** NULL = the cron no longer tries to verify this row. */
    verifyNextAt: integer('verify_next_at'),
    /** When lookups started being inconclusive (`unavailable`, or `not_found` not resend-safe). */
    verifyInconclusiveSince: integer('verify_inconclusive_since'),
    verifyLeaseUntil: integer('verify_lease_until'),
    firstAbsentAt: integer('first_absent_at'),
    lastPolledAt: integer('last_polled_at'),
    createdBy: integer('created_by')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    /** Bumped on every `state` or `courier_status` change; Sheets compares it. */
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('shipments_one_live_uq')
      .on(t.orderId)
      .where(sql`${c(t.state)} in ('reserved', 'sending', 'draft', 'accepted', 'uncertain')`),
    uniqueIndex('shipments_tracking_uq').on(t.courier, t.tracking).where(sql`${c(t.tracking)} is not null`),
    index('shipments_order_idx').on(t.orderId, t.id),
    index('shipments_account_idx').on(t.accountId),
    index('shipments_state_idx').on(t.state, t.attemptedAt),
    index('shipments_poll_idx').on(t.accountId, t.lastPolledAt).where(sql`${c(t.state)} in ('draft', 'accepted') and ${c(t.tracking)} is not null`),
    index('shipments_unapplied_idx').on(t.state).where(sql`${c(t.state)} = 'accepted' and ${c(t.appliedAt)} is null`),
    index('shipments_updated_at_idx').on(t.updatedAt),
    check('shipments_state_enum', oneOf(t.state, SHIPMENT_STATES)),
    check('shipments_courier_status_enum', sql`${c(t.courierStatus)} is null or ${oneOf(t.courierStatus, SHIPMENT_COURIER_STATUSES)}`),
    check('shipments_delivery_type_enum', oneOf(t.deliveryType, DELIVERY_TYPES)),
    check('shipments_stop_desk_has_id', sql`${c(t.deliveryType)} <> 'stop_desk' or ${c(t.stopDeskId)} is not null`),
    check('shipments_money_nonneg', sql`${c(t.codAmountDzd)} >= 0 and ${c(t.feeDzd)} >= 0`),
    check('shipments_accepted_has_tracking', sql`${c(t.state)} not in ('draft', 'accepted') or ${c(t.tracking)} is not null`),
  ],
);

/** Courier status events, deduped per shipment. One path for webhook and poll. */
export const shipmentEvents = sqliteTable(
  'shipment_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    shipmentId: integer('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'restrict' }),
    dedupeKey: text('dedupe_key').notNull(),
    rawStatus: text('raw_status').notNull(),
    mapped: text('mapped', { enum: SHIPMENT_COURIER_STATUSES }).notNull(),
    reason: text('reason'),
    occurredAt: integer('occurred_at'),
    receivedAt: integer('received_at').notNull().default(NOW_MS),
    source: text('source', { enum: SHIPMENT_EVENT_SOURCES }).notNull(),
    state: text('state', { enum: SHIPMENT_EVENT_STATES }).notNull().default('pending'),
    appliedAt: integer('applied_at'),
  },
  (t) => [
    uniqueIndex('shipment_events_dedupe_uq').on(t.shipmentId, t.dedupeKey),
    index('shipment_events_pending_idx').on(t.shipmentId, t.id).where(sql`${c(t.state)} = 'pending'`),
    check('shipment_events_mapped_enum', oneOf(t.mapped, SHIPMENT_COURIER_STATUSES)),
    check('shipment_events_source_enum', oneOf(t.source, SHIPMENT_EVENT_SOURCES)),
    check('shipment_events_state_enum', oneOf(t.state, SHIPMENT_EVENT_STATES)),
  ],
);

/** Raw webhook requests, written by the public route, processed by jobs. */
export const courierWebhookInbox = sqliteTable(
  'courier_webhook_inbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => courierAccounts.id, { onDelete: 'restrict' }),
    courier: text('courier').notNull(),
    /**
     * Byte-exact request body: a signature is computed over the original bytes. At most 32 KiB: the
     * daily backup writes a BLOB as hex (2x) inside a statement limited to 90,000 bytes.
     */
    body: blob('body', { mode: 'buffer' }).notNull(),
    /** Request headers minus cookies, auth and client-IP headers. */
    headers: text('headers', { mode: 'json' }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
    state: text('state', { enum: WEBHOOK_INBOX_STATES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    leaseUntil: integer('lease_until'),
    nextAttemptAt: integer('next_attempt_at'),
    receivedAt: integer('received_at').notNull().default(NOW_MS),
    processedAt: integer('processed_at'),
  },
  (t) => [
    index('courier_webhook_inbox_work_idx').on(t.state, t.nextAttemptAt).where(sql`${c(t.state)} in ('pending', 'held')`),
    index('courier_webhook_inbox_account_open_idx').on(t.accountId).where(sql`${c(t.state)} in ('pending', 'held')`),
    index('courier_webhook_inbox_account_idx').on(t.accountId),
    index('courier_webhook_inbox_purge_idx').on(t.processedAt).where(sql`${c(t.state)} in ('done', 'rejected')`),
    check('courier_webhook_inbox_state_enum', oneOf(t.state, WEBHOOK_INBOX_STATES)),
    check('courier_webhook_inbox_headers_json', isJson(t.headers)),
    check('courier_webhook_inbox_body_size', sql`length(${c(t.body)}) <= 32768`),
    check('courier_webhook_inbox_headers_size', sql`length(cast(${c(t.headers)} as blob)) <= 8192`),
    check('courier_webhook_inbox_attempts_nonneg', nonNeg(t.attempts)),
  ],
);

/** What a person has to deal with (`/delivery/exceptions`). */
export const deliveryExceptions = sqliteTable(
  'delivery_exceptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: DELIVERY_EXCEPTION_KINDS }).notNull(),
    /** What the row is about: `s:<shipment id>`, `t:<courier>|<tracking>`, `c:<courier>`, `i:<inbox id>`. */
    subject: text('subject').notNull(),
    shipmentId: integer('shipment_id').references(() => shipments.id, { onDelete: 'restrict' }),
    orderId: integer('order_id').references(() => orders.id, { onDelete: 'restrict' }),
    courier: text('courier'),
    /** '' when the exception is not about a status; part of the open-row key. */
    rawStatus: text('raw_status').notNull().default(''),
    detail: text('detail'),
    /** How many times this was hit while open. */
    count: integer('count').notNull().default(1),
    state: text('state', { enum: DELIVERY_EXCEPTION_STATES }).notNull().default('open'),
    resolution: text('resolution'),
    resolutionNote: text('resolution_note'),
    resolvedBy: integer('resolved_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    resolvedAt: integer('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('delivery_exceptions_open_uq')
      .on(t.kind, t.subject, t.rawStatus)
      .where(sql`${c(t.state)} = 'open'`),
    index('delivery_exceptions_list_idx').on(t.state, t.createdAt),
    index('delivery_exceptions_shipment_idx').on(t.shipmentId),
    index('delivery_exceptions_order_idx').on(t.orderId),
    index('delivery_exceptions_subject_idx').on(t.kind, t.subject),
    index('delivery_exceptions_resolved_by_idx').on(t.resolvedBy),
    check('delivery_exceptions_kind_enum', oneOf(t.kind, DELIVERY_EXCEPTION_KINDS)),
    check('delivery_exceptions_state_enum', oneOf(t.state, DELIVERY_EXCEPTION_STATES)),
    check('delivery_exceptions_count_pos', sql`${c(t.count)} > 0`),
  ],
);

/** Cached courier lists. `wilaya_code` 0 for the courier-wide wilaya list. */
export const courierDirectory = sqliteTable(
  'courier_directory',
  {
    courier: text('courier').notNull(),
    kind: text('kind', { enum: COURIER_DIRECTORY_KINDS }).notNull(),
    wilayaCode: integer('wilaya_code').notNull().default(0),
    payload: text('payload', { mode: 'json' }).$type<unknown[]>().notNull(),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.courier, t.kind, t.wilayaCode] }),
    check('courier_directory_kind_enum', oneOf(t.kind, COURIER_DIRECTORY_KINDS)),
    check('courier_directory_payload_json', isJson(t.payload)),
    // One row must fit the backup's 90,000-byte statement; a bigger list is simply not cached.
    check('courier_directory_payload_size', sql`length(cast(${c(t.payload)} as blob)) <= 80000`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Google Sheets (SHEET-0 contract)
// ---------------------------------------------------------------------------------------------

/** Singleton (`id = 1`, row inserted by the migration). */
export const sheetsConnection = sqliteTable(
  'sheets_connection',
  {
    id: integer('id').primaryKey(),
    status: text('status', { enum: SHEETS_CONNECTION_STATUSES }).notNull().default('disconnected'),
    googleEmail: text('google_email'),
    googleSub: text('google_sub'),
    connectedBy: integer('connected_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    refreshTokenEnc: text('refresh_token_enc'),
    createKey: text('create_key'),
    spreadsheetId: text('spreadsheet_id'),
    tabId: integer('tab_id'),
    lang: text('lang', { enum: LANGS }),
    generation: integer('generation').notNull().default(1),
    leaseOwner: text('lease_owner'),
    leaseUntil: integer('lease_until'),
    failureCount: integer('failure_count').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    lastSuccessAt: integer('last_success_at'),
    lastErrorCode: text('last_error_code'),
    lastErrorAt: integer('last_error_at'),
    layoutNote: text('layout_note'),
    scanFingerprint: text('scan_fingerprint'),
    lastScanAt: integer('last_scan_at'),
    connectedAt: integer('connected_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check('sheets_connection_singleton', sql`${c(t.id)} = 1`),
    check('sheets_connection_status_enum', oneOf(t.status, SHEETS_CONNECTION_STATUSES)),
    check('sheets_connection_lang_enum', sql`${c(t.lang)} is null or ${oneOf(t.lang, LANGS)}`),
    check('sheets_connection_failure_nonneg', nonNeg(t.failureCount)),
  ],
);

/** One row per order written to the sheet. */
export const sheetsRows = sqliteTable('sheets_rows', {
  orderId: integer('order_id')
    .primaryKey()
    .references(() => orders.id, { onDelete: 'restrict' }),
  generation: integer('generation').notNull(),
  sourceVersion: integer('source_version').notNull(),
  shipmentStamp: integer('shipment_stamp'),
  rowHash: text('row_hash').notNull(),
  syncedAt: integer('synced_at').notNull(),
});

/** Refresh tokens awaiting revocation at Google. */
export const sheetsRevocations = sqliteTable(
  'sheets_revocations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenEnc: text('token_enc').notNull(),
    googleSub: text('google_sub').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('sheets_revocations_next_idx').on(t.nextAttemptAt), check('sheets_revocations_attempts_nonneg', nonNeg(t.attempts))],
);

// ---------------------------------------------------------------------------------------------
// Relations (for `db.query.*` relational queries)
// ---------------------------------------------------------------------------------------------

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: 'category_parent',
  }),
  children: many(categories, { relationName: 'category_parent' }),
  products: many(products),
  images: many(images),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  options: many(productOptions),
  variants: many(variants),
  images: many(images),
  packItems: many(packItems),
}));

export const productOptionsRelations = relations(productOptions, ({ one, many }) => ({
  product: one(products, { fields: [productOptions.productId], references: [products.id] }),
  values: many(optionValues),
}));

export const optionValuesRelations = relations(optionValues, ({ one, many }) => ({
  option: one(productOptions, { fields: [optionValues.optionId], references: [productOptions.id] }),
  variantLinks: many(variantOptionValues),
  images: many(images),
}));

export const variantsRelations = relations(variants, ({ one, many }) => ({
  product: one(products, { fields: [variants.productId], references: [products.id] }),
  optionValues: many(variantOptionValues),
  images: many(images),
  inPacks: many(packItems),
}));

export const variantOptionValuesRelations = relations(variantOptionValues, ({ one }) => ({
  variant: one(variants, { fields: [variantOptionValues.variantId], references: [variants.id] }),
  optionValue: one(optionValues, {
    fields: [variantOptionValues.optionValueId],
    references: [optionValues.id],
  }),
}));

export const packItemsRelations = relations(packItems, ({ one }) => ({
  pack: one(products, { fields: [packItems.packProductId], references: [products.id] }),
  variant: one(variants, { fields: [packItems.variantId], references: [variants.id] }),
}));

export const imagesRelations = relations(images, ({ one }) => ({
  product: one(products, { fields: [images.productId], references: [products.id] }),
  category: one(categories, { fields: [images.categoryId], references: [categories.id] }),
  optionValue: one(optionValues, { fields: [images.optionValueId], references: [optionValues.id] }),
  variant: one(variants, { fields: [images.variantId], references: [variants.id] }),
}));

export const wilayasRelations = relations(wilayas, ({ one, many }) => ({
  communes: many(communes),
  fee: one(deliveryFees, { fields: [wilayas.code], references: [deliveryFees.wilayaCode] }),
}));

export const communesRelations = relations(communes, ({ one }) => ({
  wilaya: one(wilayas, { fields: [communes.wilayaCode], references: [wilayas.code] }),
}));

export const deliveryFeesRelations = relations(deliveryFees, ({ one }) => ({
  wilaya: one(wilayas, { fields: [deliveryFees.wilayaCode], references: [wilayas.code] }),
  updatedByUser: one(adminUsers, { fields: [deliveryFees.updatedBy], references: [adminUsers.id] }),
}));

export const customersRelations = relations(customers, ({ many }) => ({
  orders: many(orders),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  claimedBy: one(adminUsers, { fields: [orders.claimedByUserId], references: [adminUsers.id] }),
  wilaya: one(wilayas, { fields: [orders.wilayaCode], references: [wilayas.code] }),
  commune: one(communes, { fields: [orders.communeId], references: [communes.id] }),
  items: many(orderItems),
  events: many(orderEvents),
  deliveries: many(notificationDeliveries),
  shipments: many(shipments),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  variant: one(variants, { fields: [orderItems.variantId], references: [variants.id] }),
  product: one(products, { fields: [orderItems.productId], references: [products.id] }),
}));

export const orderEventsRelations = relations(orderEvents, ({ one }) => ({
  order: one(orders, { fields: [orderEvents.orderId], references: [orders.id] }),
  actor: one(adminUsers, { fields: [orderEvents.actorUserId], references: [adminUsers.id] }),
}));

export const contentPagesRelations = relations(contentPages, ({ one }) => ({
  updatedByUser: one(adminUsers, { fields: [contentPages.updatedBy], references: [adminUsers.id] }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  actor: one(adminUsers, { fields: [auditLog.actorUserId], references: [adminUsers.id] }),
}));

export const publishRunsRelations = relations(publishRuns, ({ one }) => ({
  requestedByUser: one(adminUsers, { fields: [publishRuns.requestedBy], references: [adminUsers.id] }),
}));

export const notificationDeliveriesRelations = relations(notificationDeliveries, ({ one }) => ({
  order: one(orders, { fields: [notificationDeliveries.orderId], references: [orders.id] }),
}));

export const courierAccountsRelations = relations(courierAccounts, ({ one, many }) => ({
  updatedByUser: one(adminUsers, { fields: [courierAccounts.updatedBy], references: [adminUsers.id] }),
  shipments: many(shipments),
}));

export const shipmentsRelations = relations(shipments, ({ one, many }) => ({
  order: one(orders, { fields: [shipments.orderId], references: [orders.id] }),
  account: one(courierAccounts, { fields: [shipments.accountId], references: [courierAccounts.id] }),
  createdByUser: one(adminUsers, { fields: [shipments.createdBy], references: [adminUsers.id] }),
  events: many(shipmentEvents),
  exceptions: many(deliveryExceptions),
}));

export const shipmentEventsRelations = relations(shipmentEvents, ({ one }) => ({
  shipment: one(shipments, { fields: [shipmentEvents.shipmentId], references: [shipments.id] }),
}));

export const deliveryExceptionsRelations = relations(deliveryExceptions, ({ one }) => ({
  shipment: one(shipments, { fields: [deliveryExceptions.shipmentId], references: [shipments.id] }),
  order: one(orders, { fields: [deliveryExceptions.orderId], references: [orders.id] }),
  resolvedByUser: one(adminUsers, { fields: [deliveryExceptions.resolvedBy], references: [adminUsers.id] }),
}));
