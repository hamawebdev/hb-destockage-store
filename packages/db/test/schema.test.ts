import { describe, expect, test } from 'vitest';
import { eq, is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '../src/schema.ts';
import { ORDER_STATUSES } from '../src/enums.ts';
import { freshDb, migrationFiles } from './helpers.ts';

const tables = (Object.values(schema) as unknown[]).filter((v): v is SQLiteTable => is(v, SQLiteTable));

const BRIEF_TABLES = [
  'categories',
  'products',
  'product_options',
  'option_values',
  'variants',
  'variant_option_values',
  'pack_items',
  'images',
  'wilayas',
  'communes',
  'delivery_fees',
  'customers',
  'orders',
  'order_items',
  'order_events',
  'content_pages',
  'settings',
  'admin_users',
  'audit_log',
  'publish_runs',
  'rum_events',
  // Added for consumers (jobs: JOBS-2, JOBS-5).
  'rum_daily',
  'notification_deliveries',
].sort();

/** Insert the smallest valid graph: category → product → variant, geo, customer, order. */
function seedMinimal() {
  const { sqlite, db } = freshDb();
  db.insert(schema.categories).values({ id: 1, slugFr: 'cuisine', slugAr: 'matbakh', nameFr: 'Cuisine', nameAr: 'مطبخ' }).run();
  db.insert(schema.products)
    .values({ id: 10, kind: 'simple', categoryId: 1, slugFr: 'pack-cuisine', slugAr: 'pack-matbakh', nameFr: 'Pack cuisine', nameAr: 'باك المطبخ', status: 'active' })
    .run();
  db.insert(schema.variants).values({ id: 100, productId: 10, sku: 'HB-PC-1', priceDzd: 14600, stock: 3, isDefault: true }).run();
  db.insert(schema.wilayas).values({ code: 16, nameFr: 'Alger', nameAr: 'الجزائر' }).run();
  db.insert(schema.communes).values({ id: 1601, wilayaCode: 16, nameFr: 'Alger Centre', nameAr: 'الجزائر الوسطى', postalCode: '16000' }).run();
  db.insert(schema.deliveryFees).values({ wilayaCode: 16, feeDzd: 400 }).run();
  db.insert(schema.customers).values({ id: 1, phoneE164: '+213560417403', name: 'Amine' }).run();
  db.insert(schema.adminUsers).values({ id: 1, email: 'owner@example.test', name: 'Owner', role: 'owner' }).run();
  return { sqlite, db };
}

const order = (over: Partial<typeof schema.orders.$inferInsert> = {}): typeof schema.orders.$inferInsert => ({
  ref: 'HB-7K2Q9',
  idempotencyKey: '7f0c1f1e-3b8a-4c2e-9a51-1d2f3a4b5c6d',
  customerId: 1,
  name: 'Amine',
  phoneE164: '+213560417403',
  wilayaCode: 16,
  communeId: 1601,
  lang: 'ar',
  subtotalDzd: 14600,
  feeDzd: 400,
  totalDzd: 15000,
  feeSource: 'table',
  ...over,
});

describe('DB-1 migrations', () => {
  test('there is at least one migration and it applies to an empty database', () => {
    expect(migrationFiles()[0]).toMatch(/^0000_.+\.sql$/);
    const { sqlite } = freshDb();
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  test('every table named in BRIEF §4 DB-1 (+ consumer additions) exists', () => {
    const { sqlite } = freshDb();
    const names = (
      sqlite.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names.sort()).toEqual(BRIEF_TABLES);
    expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual(BRIEF_TABLES);
  });

  test('migration SQL matches the Drizzle schema column for column (no drift)', () => {
    const { sqlite } = freshDb();
    for (const t of tables) {
      const cfg = getTableConfig(t);
      const cols = (sqlite.prepare(`select name, "notnull" as nn from pragma_table_info(?)`).all(cfg.name) as { name: string; nn: number }[]);
      expect(cols.map((c) => c.name).sort(), cfg.name).toEqual(cfg.columns.map((c) => c.name).sort());
      for (const col of cfg.columns) {
        const dbCol = cols.find((c) => c.name === col.name)!;
        expect(Boolean(dbCol.nn) || col.primary, `${cfg.name}.${col.name} notNull`).toBe(col.notNull);
      }
    }
  });

  test('money columns are INTEGER, never REAL', () => {
    const { sqlite } = freshDb();
    for (const t of tables) {
      const name = getTableConfig(t).name;
      const cols = sqlite.prepare('select name, type from pragma_table_info(?)').all(name) as { name: string; type: string }[];
      for (const c of cols.filter((c) => c.name.endsWith('_dzd'))) expect(c.type.toLowerCase(), `${name}.${c.name}`).toBe('integer');
    }
  });
});

describe('DB-1 round trip', () => {
  test('a full order graph inserts and reads back through relations', () => {
    const { db } = seedMinimal();
    const before = Date.now();
    db.insert(schema.orders).values(order({ id: 1 })).run();
    db.insert(schema.orderItems)
      .values({ orderId: 1, variantId: 100, productId: 10, nameFr: 'Pack cuisine', nameAr: 'باك المطبخ', sku: 'HB-PC-1', unitPriceDzd: 14600, qty: 1, lineTotalDzd: 14600 })
      .run();
    db.insert(schema.orderEvents).values({ orderId: 1, type: 'created', toStatus: 'new', actorType: 'customer' }).run();

    const o = db.query.orders.findFirst({ where: eq(schema.orders.id, 1), with: { items: true, events: true, commune: true, customer: true } }).sync();
    expect(o?.status).toBe('new');
    expect(o?.flags).toEqual([]);
    expect(o?.version).toBe(0);
    expect(o?.items[0]?.lineTotalDzd).toBe(14600);
    expect(o?.events[0]?.type).toBe('created');
    expect(o?.commune.postalCode).toBe('16000');
    expect(o?.customer.phoneE164).toBe('+213560417403');
    // created_at default is integer epoch ms from SQLite.
    expect(Number.isInteger(o?.createdAt)).toBe(true);
    expect(o!.createdAt).toBeGreaterThanOrEqual(before - 1000);
    expect(o!.createdAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('JSON and boolean columns round-trip as JS values', () => {
    const { db } = seedMinimal();
    db.insert(schema.settings).values({ key: 'homeFeaturedProductIds', value: [10] }).run();
    db.insert(schema.contentPages)
      .values({ key: 'delivery', slugFr: 'livraison', slugAr: 'tawsil', titleFr: 'Livraison', titleAr: 'التوصيل', bodyFr: [{ type: 'p', text: 'x' }], bodyAr: [{ type: 'p', text: 'س' }] })
      .run();
    expect(db.select().from(schema.settings).get()?.value).toEqual([10]);
    const page = db.select().from(schema.contentPages).get();
    expect(page?.bodyAr).toEqual([{ type: 'p', text: 'س' }]);
    expect(page?.active).toBe(true);
    expect(page?.placeholder).toBe(false);
  });
});

describe('DB-1 constraints reject bad rows', () => {
  const cases: [string, (db: ReturnType<typeof seedMinimal>['db'], sqlite: ReturnType<typeof seedMinimal>['sqlite']) => unknown, RegExp][] = [
    ['unknown order status', (_db, s) => s.prepare(`insert into orders (ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, status, subtotal_dzd, fee_dzd, total_dzd, fee_source) values ('HB-1','k',1,'a','+213560417403',16,1601,'ar','paid',1,0,1,'x')`).run(), /orders_status_enum/],
    ['total ≠ subtotal + fee', (db) => db.insert(schema.orders).values(order({ totalDzd: 14999 })).run(), /orders_total_sum/],
    ['non-mobile phone', (db) => db.insert(schema.orders).values(order({ phoneE164: '+213212345678' })).run(), /orders_phone_e164/],
    ['national-format phone', (db) => db.insert(schema.customers).values({ phoneE164: '0560417403', name: 'x' }).run(), /customers_phone_e164/],
    ['duplicate idempotency key', (db) => { db.insert(schema.orders).values(order()).run(); db.insert(schema.orders).values(order({ ref: 'HB-OTHER' })).run(); }, /UNIQUE.*idempotency_key/],
    ['duplicate ref', (db) => { db.insert(schema.orders).values(order()).run(); db.insert(schema.orders).values(order({ idempotencyKey: 'other' })).run(); }, /UNIQUE.*orders\.ref/],
    ['unknown commune (FK)', (db) => db.insert(schema.orders).values(order({ communeId: 9999 })).run(), /FOREIGN KEY/],
    ['line total ≠ unit × qty', (db) => { db.insert(schema.orders).values(order({ id: 1 })).run(); db.insert(schema.orderItems).values({ orderId: 1, variantId: 100, productId: 10, nameFr: 'a', nameAr: 'b', sku: 's', unitPriceDzd: 100, qty: 2, lineTotalDzd: 201 }).run(); }, /order_items_line_total/],
    ['qty 0', (db) => { db.insert(schema.orders).values(order({ id: 1 })).run(); db.insert(schema.orderItems).values({ orderId: 1, variantId: 100, productId: 10, nameFr: 'a', nameAr: 'b', sku: 's', unitPriceDzd: 100, qty: 0, lineTotalDzd: 0 }).run(); }, /order_items_qty_pos/],
    ['negative stock', (db) => db.update(schema.variants).set({ stock: -1 }).where(eq(schema.variants.id, 100)).run(), /variants_stock_nonneg/],
    ['negative price', (db) => db.update(schema.variants).set({ priceDzd: -1 }).where(eq(schema.variants.id, 100)).run(), /variants_price_nonneg/],
    ['compare-at not above price', (db) => db.update(schema.variants).set({ compareAtDzd: 14600 }).where(eq(schema.variants.id, 100)).run(), /variants_compare_at_gt_price/],
    ['second default variant', (db) => db.insert(schema.variants).values({ productId: 10, sku: 'HB-PC-2', priceDzd: 1, isDefault: true }).run(), /UNIQUE.*variants\.product_id/],
    ['duplicate SKU', (db) => db.insert(schema.variants).values({ productId: 10, sku: 'HB-PC-1', priceDzd: 1 }).run(), /UNIQUE.*variants\.sku/],
    ['non-kebab slug', (db) => db.insert(schema.categories).values({ slugFr: 'Salle de bain', slugAr: 'hammam', nameFr: 'a', nameAr: 'b' }).run(), /categories_slug_fr_fmt/],
    ['Arabic-script slug', (db) => db.insert(schema.categories).values({ slugFr: 'bain', slugAr: 'حمام', nameFr: 'a', nameAr: 'b' }).run(), /categories_slug_ar_fmt/],
    ['unknown product kind', (_db, s) => s.prepare(`insert into products (kind, category_id, slug_fr, slug_ar, name_fr, name_ar) values ('bundle',1,'a','b','c','d')`).run(), /products_kind_enum/],
    ['upper-case swatch', (db) => { db.insert(schema.productOptions).values({ id: 1, productId: 10, kind: 'colour', nameFr: 'Couleur', nameAr: 'اللون' }).run(); db.insert(schema.optionValues).values({ optionId: 1, valueFr: 'Rouge', valueAr: 'أحمر', swatchHex: '#FF0000' }).run(); }, /option_values_swatch_hex/],
    ['wilaya code 70', (db) => db.insert(schema.wilayas).values({ code: 70, nameFr: 'x', nameAr: 'y' }).run(), /wilayas_code_range/],
    ['negative fee', (db) => db.update(schema.deliveryFees).set({ feeDzd: -5 }).run(), /delivery_fees_fee_nonneg/],
    ['mixed-case admin email', (db) => db.insert(schema.adminUsers).values({ email: 'Boss@Example.test', name: 'b', role: 'owner' }).run(), /admin_users_email_lower/],
    ['unknown admin role', (_db, s) => s.prepare(`insert into admin_users (email, name, role) values ('a@b.c','a','root')`).run(), /admin_users_role_enum/],
    ['admin event without user', (db) => { db.insert(schema.orders).values(order({ id: 1 })).run(); db.insert(schema.orderEvents).values({ orderId: 1, type: 'note', actorType: 'admin' }).run(); }, /order_events_admin_has_user/],
    ['status_change without to_status', (db) => { db.insert(schema.orders).values(order({ id: 1 })).run(); db.insert(schema.orderEvents).values({ orderId: 1, type: 'status_change', actorType: 'system' }).run(); }, /order_events_status_change_has_to/],
    ['invalid JSON flags', (_db, s) => s.prepare(`update customers set flags = 'not json'`).run(), /customers_flags_json/],
    ['content body not an array', (_db, s) => s.prepare(`insert into content_pages (key, slug_fr, slug_ar, title_fr, title_ar, body_fr, body_ar) values ('about','a','b','c','d','{}','[]')`).run(), /content_pages_body_fr_json/],
    ['unknown content key', (_db, s) => s.prepare(`insert into content_pages (key, slug_fr, slug_ar, title_fr, title_ar) values ('faq','a','b','c','d')`).run(), /content_pages_key_enum/],
    ['unknown RUM metric', (db) => db.insert(schema.rumEvents).values({ template: 'home', path: '/ar/', lang: 'ar', metric: 'FID' as 'LCP', value: 1 }).run(), /rum_events_metric_enum/],
    ['translation_placeholder with an unknown language', (_db, s) => s.prepare(`update products set translation_placeholder = '["en"]'`).run(), /products_translation_placeholder/],
    ['image with both product and category', (db) => db.insert(schema.images).values({ productId: 10, categoryId: 1, r2Key: 'k', width: 1, height: 1, altFr: 'a', altAr: 'b' }).run(), /images_one_owner/],
    ['image with no owner', (db) => db.insert(schema.images).values({ r2Key: 'k', width: 1, height: 1, altFr: 'a', altAr: 'b' }).run(), /images_one_owner/],
    ['second active publish run', (db) => { db.insert(schema.publishRuns).values({ requestedBy: 1 }).run(); db.insert(schema.publishRuns).values({ requestedBy: 1, status: 'running' }).run(); }, /UNIQUE/],
    ['category as its own parent', (_db, s) => s.prepare('update categories set parent_id = id').run(), /categories_not_own_parent/],
  ];

  test.each(cases)('%s', (_name, act, err) => {
    const { db, sqlite } = seedMinimal();
    expect(() => act(db, sqlite)).toThrow(err);
  });

  test('translation_placeholder accepts language arrays and round-trips', () => {
    const { db } = seedMinimal();
    db.update(schema.products).set({ translationPlaceholder: ['ar', 'fr'] }).run();
    expect(db.select().from(schema.products).get()?.translationPlaceholder).toEqual(['ar', 'fr']);
    expect(db.select().from(schema.categories).get()?.translationPlaceholder).toEqual([]);
  });

  test('publish runs: a new run is allowed once the previous one finished', () => {
    const { db } = seedMinimal();
    db.insert(schema.publishRuns).values({ id: 1, requestedBy: 1 }).run();
    db.update(schema.publishRuns).set({ status: 'succeeded', timingsJson: { astro: 1 }, budgetOk: true }).where(eq(schema.publishRuns.id, 1)).run();
    db.insert(schema.publishRuns).values({ requestedBy: 1 }).run();
    expect(db.select().from(schema.publishRuns).all()).toHaveLength(2);
  });

  test('two images (product and category) may share one R2 key', () => {
    const { db } = seedMinimal();
    db.insert(schema.images).values({ productId: 10, r2Key: 'pack/1.jpg', width: 1, height: 1, altFr: 'a', altAr: 'b' }).run();
    db.insert(schema.images).values({ categoryId: 1, r2Key: 'pack/1.jpg', width: 1, height: 1, altFr: 'a', altAr: 'b' }).run();
    expect(db.select().from(schema.images).all()).toHaveLength(2);
  });

  test('stock NULL (untracked) is allowed', () => {
    const { db } = seedMinimal();
    db.update(schema.variants).set({ stock: null }).where(eq(schema.variants.id, 100)).run();
    expect(db.select().from(schema.variants).get()?.stock).toBeNull();
  });

  test('every order status in the enum is accepted', () => {
    const { db } = seedMinimal();
    ORDER_STATUSES.forEach((status, i) => {
      db.insert(schema.orders).values(order({ status, ref: `HB-${i}`, idempotencyKey: `k-${i}` })).run();
    });
    expect(db.select().from(schema.orders).all()).toHaveLength(ORDER_STATUSES.length);
  });
});
