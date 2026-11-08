// DB-3: seed statements (idempotent upserts, FK order), local-only guard, and, when the repo's
// data/ is present (or HB_SEED_ROOT points at a checkout with it), a full load of the real data.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { blockedVariantDeletionsQuery, buildSeedStatements, categoriesInTreeOrder, referencedImageKeys, type SeedInput, type SeedProduct } from '../src/seed/build.ts';
import { DEV_ADMIN_USERS } from '../src/seed/dev-users.ts';
import { databaseIdFromWranglerJsonc, LOCAL_DATABASE_ID, seedRefusals } from '../src/seed/guard.ts';
import { loadSeedInput } from '../src/seed/load.ts';
import { freshDb } from './helpers.ts';

const L = (fr: string, ar: string) => ({ fr, ar });

function run(sqlite: Database.Database, input: SeedInput) {
  const stmts = buildSeedStatements(input);
  sqlite.transaction(() => {
    for (const s of stmts) sqlite.prepare(s.sql).run(...s.params);
  })();
  return stmts.length;
}

function counts(sqlite: Database.Database) {
  const t = ['wilayas', 'communes', 'delivery_fees', 'admin_users', 'categories', 'products', 'product_options', 'option_values', 'variants', 'variant_option_values', 'pack_items', 'images', 'content_pages', 'settings'];
  return Object.fromEntries(t.map((x) => [x, (sqlite.prepare(`select count(*) n from ${x}`).get() as { n: number }).n]));
}

const shirt: SeedProduct = {
  id: 201,
  kind: 'variable',
  categoryId: 21,
  slug: L('t-shirt', 'qamis'),
  name: L('T-shirt', 'قميص'),
  brandLatin: 'HB',
  summary: L('s', 'م'),
  description: L('d', 'و'),
  status: 'active',
  placeholder: true,
  sort: 1,
  translationPlaceholder: ['ar', 'fr'],
  options: [{ id: 2011, type: 'colour', name: L('Couleur', 'اللون'), position: 0, values: [{ id: 201101, value: L('Rouge', 'أحمر'), swatchHex: '#ff0000', position: 0 }, { id: 201102, value: L('Bleu', 'أزرق'), swatchHex: '#0000ff', position: 1 }] }],
  variants: [
    { id: 20101, sku: 'TS-R', priceDzd: 1500, compareAtDzd: null, stock: 4, weightG: 200, active: true, isDefault: true, optionValueIds: [201101] },
    { id: 20102, sku: 'TS-B', priceDzd: 1500, compareAtDzd: 1900, stock: null, weightG: 200, active: true, isDefault: false, optionValueIds: [201102] },
  ],
  packItems: [],
  images: [
    { id: 2011, variantId: 20101, key: 'shared/1.jpg', width: 800, height: 800, alt: L('a', 'ب'), position: 1, placeholder: true },
    { id: 2012, variantId: null, optionValueId: 201102, key: 'shirt/blue.jpg', width: 800, height: 800, alt: L('a', 'ب'), position: 2, placeholder: true },
  ],
};
const pack: SeedProduct = {
  id: 101,
  kind: 'pack',
  categoryId: 21,
  slug: L('pack', 'taqm'),
  name: L('Pack', 'طقم'),
  brandLatin: null,
  summary: L('s', 'م'),
  description: L('d', 'و'),
  status: 'active',
  placeholder: false,
  sort: 0,
  options: [],
  variants: [{ id: 10101, sku: 'PACK', priceDzd: 14600, compareAtDzd: 17900, stock: null, weightG: null, active: true, isDefault: true, optionValueIds: [] }],
  // References a variant of a product listed AFTER it: pack_items must be written after all variants.
  packItems: [{ variantId: 20101, qty: 2 }, { variantId: 20102, qty: 1 }],
  images: [{ id: 1011, variantId: null, key: 'shared/1.jpg', width: 800, height: 600, alt: L('a', 'ب'), position: 1, placeholder: false }],
};

const fixture: SeedInput = {
  wilayas: [{ code: 16, name_fr: 'Alger', name_ar: 'الجزائر' }, { code: 31, name_fr: 'Oran', name_ar: 'وهران' }],
  communes: [{ id: 1601, wilaya_code: 16, name_fr: 'Alger Centre', name_ar: 'الجزائر الوسطى' }, { id: 3101, wilaya_code: 31, name_fr: 'Oran', name_ar: 'وهران' }],
  fees: [{ wilaya_code: 16, fee_dzd: 400, available: true }, { wilaya_code: 31, fee_dzd: 600, available: false, placeholder: true }],
  // Child listed before its parent on purpose.
  categories: [
    { id: 21, parentId: 2, slug: L('vetements', 'malabis'), name: L('Vêtements', 'ملابس'), description: null, sort: 0, active: true, placeholder: true },
    { id: 2, parentId: null, slug: L('mode', 'muda'), name: L('Mode', 'موضة'), description: L('d', 'و'), sort: 0, active: true, placeholder: true, translationPlaceholder: ['ar'], image: { id: 9001, variantId: null, key: 'cat/2.jpg', width: 10, height: 10, alt: L('a', 'ب'), position: 0, placeholder: true } },
  ],
  products: [pack, shirt],
  contentPages: [{ id: 1, key: 'about', slug: L('qui-sommes-nous', 'man-nahnu'), title: L('Qui', 'من'), summary: L('s', 'م'), body: { fr: [{ type: 'p', text: 'x' }], ar: [{ type: 'p', text: 'س' }] }, sort: 0, active: true, placeholder: true, updatedAt: 1793800000000 }],
  settings: { storeName: L('HB Destockage', 'HB Destockage'), contactPhone: '0560417403', whatsapp: '213779942022', contactEmail: null, homeFeaturedProductIds: [101], homeHeroProductId: 101, turnstileSiteKey: null },
  adminUsers: DEV_ADMIN_USERS,
};

describe('DB-3 seed statements', () => {
  test('load into a fresh DB with every constraint and trigger on', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(counts(sqlite)).toMatchObject({ wilayas: 2, communes: 2, delivery_fees: 2, admin_users: 5, categories: 2, products: 2, variants: 3, variant_option_values: 2, pack_items: 2, images: 4, content_pages: 1, settings: 8 }); // 7 data keys + seed.owned
  });

  test('re-running is idempotent (same counts, same rows)', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture);
    const dump = () => ['variants', 'pack_items', 'images', 'settings', 'delivery_fees', 'admin_users'].map((t) => sqlite.prepare(`select * from ${t} order by 1, 2`).all().map((r) => ({ ...(r as object), updated_at: 0, created_at: 0 })));
    const first = { c: counts(sqlite), d: dump() };
    run(sqlite, fixture);
    expect(counts(sqlite)).toEqual(first.c);
    expect(dump()).toEqual(first.d);
  });

  test('a re-run keeps orders and customers, and data changes are applied in place', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture);
    sqlite.exec(`insert into customers (id, phone_e164, name) values (1, '+213560417403', 'A');
      insert into orders (id, ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, subtotal_dzd, fee_dzd, total_dzd, fee_source)
      values (1, 'HB-7K2Q9', 'k', 1, 'A', '+213560417403', 16, 1601, 'ar', 14600, 400, 15000, 'table');
      insert into order_items (order_id, variant_id, product_id, name_fr, name_ar, sku, unit_price_dzd, qty, line_total_dzd) values (1, 10101, 101, 'Pack', 'طقم', 'PACK', 14600, 1, 14600);`);
    // Move the default variant and change a price: the one-default index must not trip.
    const changed: SeedInput = {
      ...fixture,
      products: [pack, { ...shirt, variants: shirt.variants.map((v) => ({ ...v, isDefault: !v.isDefault, priceDzd: 1600 })) }],
    };
    run(sqlite, changed);
    expect(sqlite.prepare('select id, is_default, price_dzd from variants where product_id = 201 order by id').all()).toEqual([
      { id: 20101, is_default: 0, price_dzd: 1600 },
      { id: 20102, is_default: 1, price_dzd: 1600 },
    ]);
    expect(counts(sqlite).variants).toBe(3);
    expect((sqlite.prepare('select count(*) n from orders').get() as { n: number }).n).toBe(1);
  });

  test('field mapping: placeholders, translation flags, JSON, fee placeholder, inactive dev user', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture);
    expect(sqlite.prepare('select translation_placeholder t from categories where id = 2').get()).toEqual({ t: '["ar"]' });
    expect(sqlite.prepare('select translation_placeholder t from categories where id = 21').get()).toEqual({ t: '[]' });
    expect(sqlite.prepare('select wilaya_code, fee_dzd, available, placeholder from delivery_fees order by 1').all()).toEqual([
      { wilaya_code: 16, fee_dzd: 400, available: 1, placeholder: 1 },
      { wilaya_code: 31, fee_dzd: 600, available: 0, placeholder: 1 },
    ]);
    expect(sqlite.prepare("select value from settings where key = 'homeFeaturedProductIds'").get()).toEqual({ value: '[101]' });
    expect(sqlite.prepare("select value from settings where key = 'contactEmail'").get()).toEqual({ value: 'null' });
    expect(sqlite.prepare('select body_ar, updated_at from content_pages').get()).toEqual({ body_ar: '[{"type":"p","text":"س"}]', updated_at: 1793800000000 });
    expect(sqlite.prepare("select role, active from admin_users where email = 'inactive@dev.local'").get()).toEqual({ role: 'confirmer', active: 0 });
    expect(sqlite.prepare('select position, qty from pack_items where pack_product_id = 101 order by position').all()).toEqual([{ position: 0, qty: 2 }, { position: 1, qty: 1 }]);
    expect(sqlite.prepare('select category_id, product_id from images where id = 9001').get()).toEqual({ category_id: 2, product_id: null });
    expect(sqlite.prepare('select variant_id, option_value_id from images where id = 2012').get()).toEqual({ variant_id: null, option_value_id: 201102 });
  });

  // DB-3 r3: a re-run converges the catalogue to data/ exactly.
  const ids = (sqlite: Database.Database, sql: string) => (sqlite.prepare(sql).all() as { id: number }[]).map((r) => r.id);
  const changedFixture = (): SeedInput => ({
    ...fixture,
    categories: fixture.categories.map((c) => (c.id === 2 ? { ...c, image: null } : c)), // category image dropped
    products: [
      { ...pack, packItems: [pack.packItems[0]!] }, // one pack item dropped
      {
        ...shirt,
        images: [shirt.images[1]!], // image 2011 dropped
        // variant 20102 renamed to 20109 with the SAME sku: the old row must go before the new one is written
        variants: shirt.variants.map((v) => (v.id === 20102 ? { ...v, id: 20109 } : v)),
      },
    ],
  });

  test('re-running with changed data converges the DB to data/ (drop image, rename variant id, drop pack item)', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture);
    run(sqlite, changedFixture());
    expect(ids(sqlite, 'select id from images order by id')).toEqual([1011, 2012]);
    expect(ids(sqlite, 'select id from variants where product_id = 201 order by id')).toEqual([20101, 20109]);
    expect(sqlite.prepare('select sku from variants where id = 20109').get()).toEqual({ sku: 'TS-B' });
    expect(sqlite.prepare('select variant_id from pack_items').all()).toEqual([{ variant_id: 20101 }]);
    expect(sqlite.prepare('select option_value_id from variant_option_values where variant_id = 20109').all()).toEqual([{ option_value_id: 201102 }]);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    // And back again: converges to the original.
    run(sqlite, fixture);
    expect(ids(sqlite, 'select id from images order by id')).toEqual([1011, 2011, 2012, 9001]);
    expect(ids(sqlite, 'select id from variants where product_id = 201 order by id')).toEqual([20101, 20102]);
  });

  test('a dropped option value and option are deleted too', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture);
    const noBlue: SeedProduct = {
      ...shirt,
      options: [{ ...shirt.options[0]!, values: [shirt.options[0]!.values[0]!] }],
      variants: [shirt.variants[0]!],
      images: [shirt.images[0]!],
    };
    const packOfRed: SeedProduct = { ...pack, packItems: [{ variantId: 20101, qty: 1 }] };
    run(sqlite, { ...fixture, products: [packOfRed, noBlue] });
    expect(ids(sqlite, 'select id from option_values order by id')).toEqual([201101]);
    const noOptions: SeedProduct = { ...noBlue, kind: 'simple', options: [], variants: [{ ...shirt.variants[0]!, optionValueIds: [] }] };
    run(sqlite, { ...fixture, products: [packOfRed, noOptions] });
    expect(ids(sqlite, 'select id from product_options')).toEqual([]);
  });

  test('a variant to delete that an order line references: reported by the pre-check, and the batch would abort', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture);
    sqlite.exec(`insert into customers (id, phone_e164, name) values (1, '+213560417403', 'A');
      insert into orders (id, ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, subtotal_dzd, fee_dzd, total_dzd, fee_source)
      values (1, 'HB-7K2Q9', 'k', 1, 'A', '+213560417403', 16, 1601, 'ar', 1500, 400, 1900, 'table');
      insert into order_items (order_id, variant_id, product_id, name_fr, name_ar, sku, unit_price_dzd, qty, line_total_dzd) values (1, 20102, 201, 'T', 'ق', 'TS-B', 1500, 1, 1500);`);
    const blocked = blockedVariantDeletionsQuery(changedFixture()).flatMap((q) => sqlite.prepare(q.sql).all(...q.params));
    expect(blocked).toEqual([{ id: 20102, sku: 'TS-B', order_lines: 1, other_packs: 0 }]);
    expect(() => run(sqlite, changedFixture())).toThrow(/FOREIGN KEY/);
    expect(ids(sqlite, 'select id from variants where product_id = 201 order by id')).toEqual([20101, 20102]); // rolled back
    expect((sqlite.prepare('select count(*) n from orders').get() as { n: number }).n).toBe(1);
  });

  test('a variant to delete that a pack outside data/ references is reported', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture);
    sqlite.exec(`insert into products (id, kind, category_id, slug_fr, slug_ar, name_fr, name_ar) values (999, 'pack', 21, 'admin-pack', 'admin-pack-ar', 'P', 'ب');
      insert into pack_items (pack_product_id, variant_id, qty) values (999, 20102, 1);`);
    const blocked = blockedVariantDeletionsQuery(changedFixture()).flatMap((q) => sqlite.prepare(q.sql).all(...q.params));
    expect(blocked).toEqual([{ id: 20102, sku: 'TS-B', order_lines: 0, other_packs: 1 }]);
    expect(blockedVariantDeletionsQuery(fixture).flatMap((q) => sqlite.prepare(q.sql).all(...q.params))).toEqual([]);
  });

  test('printed_prices_dzd comes from the photo manifest by key; photos absent from it print none (DB-8)', () => {
    const { sqlite } = freshDb();
    run(sqlite, { ...fixture, printedPrices: { 'shared/1.jpg': [14600, 13600] } });
    // One key backs two image rows (1011 on the pack, 2011 on the shirt): both get it.
    expect(sqlite.prepare('select id, printed_prices_dzd p from images order by id').all()).toEqual([
      { id: 1011, p: '[14600,13600]' },
      { id: 2011, p: '[14600,13600]' },
      { id: 2012, p: '[]' },
      { id: 9001, p: '[]' },
    ]);
  });

  // DB-3 r4 (rev-b r3 F1): products and categories that left data/ never stay live.
  const owned = (sqlite: Database.Database) => JSON.parse((sqlite.prepare("select value from settings where key = 'seed.owned'").get() as { value: string }).value);

  test('the seed records what it owns', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture);
    expect(owned(sqlite)).toEqual({ products: [101, 201], categories: [2, 21] });
  });

  test('a seed-owned product removed from data/ and referenced by nothing is deleted with its children', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture);
    const packOfNothing: SeedProduct = { ...pack, packItems: [] };
    run(sqlite, { ...fixture, products: [packOfNothing] }); // shirt 201 removed
    expect(ids(sqlite, 'select id from products order by id')).toEqual([101]);
    for (const t of ['variants', 'images', 'product_options', 'option_values', 'variant_option_values']) {
      const n = (sqlite.prepare(`select count(*) n from ${t} where ${t === 'option_values' ? 'option_id in (select id from product_options where product_id = 201)' : t === 'variant_option_values' ? 'variant_id in (20101, 20102)' : 'product_id = 201'}`).get() as { n: number }).n;
      expect(n, t).toBe(0);
    }
    expect(owned(sqlite).products).toEqual([101]);
  });

  test('a removed product that an order references is archived (not live) and kept; still seed-owned', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture);
    sqlite.exec(`insert into customers (id, phone_e164, name) values (1, '+213560417403', 'A');
      insert into orders (id, ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, subtotal_dzd, fee_dzd, total_dzd, fee_source)
      values (1, 'HB-7K2Q9', 'k', 1, 'A', '+213560417403', 16, 1601, 'ar', 1500, 400, 1900, 'table');
      insert into order_items (order_id, variant_id, product_id, name_fr, name_ar, sku, unit_price_dzd, qty, line_total_dzd) values (1, 20101, 201, 'T', 'ق', 'TS-R', 1500, 1, 1500);`);
    run(sqlite, { ...fixture, products: [{ ...pack, packItems: [] }] });
    expect(sqlite.prepare('select status from products where id = 201').get()).toEqual({ status: 'archived' });
    expect(ids(sqlite, 'select id from variants where product_id = 201 order by id')).toEqual([20101, 20102]);
    expect(owned(sqlite).products).toEqual([101, 201]);
    // Back in data/: the seed takes it over again with the data's status.
    run(sqlite, fixture);
    expect(sqlite.prepare('select status from products where id = 201').get()).toEqual({ status: 'active' });
  });

  test('a removed product whose variant a remaining pack lists is archived, not deleted', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture); // pack 101 lists 20101 and 20102
    run(sqlite, { ...fixture, products: [pack] });
    expect(sqlite.prepare('select status from products where id = 201').get()).toEqual({ status: 'archived' });
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  test('admin-created rows (not seed-owned) are never touched', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture);
    sqlite.exec(`insert into categories (id, slug_fr, slug_ar, name_fr, name_ar) values (900, 'admin-cat', 'admin-cat-ar', 'A', 'ب');
      insert into products (id, category_id, slug_fr, slug_ar, name_fr, name_ar, status) values (950, 900, 'admin-p', 'admin-p-ar', 'P', 'ب', 'active');
      insert into variants (id, product_id, sku, price_dzd) values (95001, 950, 'ADMIN-1', 100);`);
    run(sqlite, fixture);
    expect(sqlite.prepare('select status from products where id = 950').get()).toEqual({ status: 'active' });
    expect(sqlite.prepare('select active from categories where id = 900').get()).toEqual({ active: 1 });
    expect(owned(sqlite)).toEqual({ products: [101, 201], categories: [2, 21] });
  });

  test('removed categories: deleted when empty (children first, image included), inactive while something needs them', () => {
    const { sqlite } = freshDb();
    run(sqlite, fixture);
    // Move both products to a new category 3; drop categories 2 (has image) and its child 21.
    const cat3 = { id: 3, parentId: null, slug: L('maison', 'bayt'), name: L('Maison', 'بيت'), description: null, sort: 0, active: true, placeholder: true };
    run(sqlite, { ...fixture, categories: [cat3], products: [{ ...pack, categoryId: 3 }, { ...shirt, categoryId: 3 }] });
    expect(ids(sqlite, 'select id from categories order by id')).toEqual([3]);
    expect(ids(sqlite, 'select id from images where category_id is not null')).toEqual([]);
    // An archived product keeps its (removed) category alive but inactive.
    run(sqlite, fixture);
    sqlite.exec(`insert into customers (id, phone_e164, name) values (1, '+213560417403', 'A');
      insert into orders (id, ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, subtotal_dzd, fee_dzd, total_dzd, fee_source)
      values (1, 'HB-7K2Q9', 'k', 1, 'A', '+213560417403', 16, 1601, 'ar', 1500, 400, 1900, 'table');
      insert into order_items (order_id, variant_id, product_id, name_fr, name_ar, sku, unit_price_dzd, qty, line_total_dzd) values (1, 20101, 201, 'T', 'ق', 'TS-R', 1500, 1, 1500);`);
    run(sqlite, { ...fixture, categories: [cat3], products: [{ ...pack, categoryId: 3, packItems: [] }] });
    expect(sqlite.prepare('select status, category_id from products where id = 201').get()).toEqual({ status: 'archived', category_id: 21 });
    expect(sqlite.prepare('select id, active from categories order by id').all()).toEqual([
      { id: 2, active: 0 },
      { id: 3, active: 1 },
      { id: 21, active: 0 },
    ]);
  });

  test('categories are written parents first; a cycle or unknown parent throws', () => {
    expect(categoriesInTreeOrder(fixture.categories).map((c) => c.id)).toEqual([2, 21]);
    expect(() => categoriesInTreeOrder([{ ...fixture.categories[0]!, parentId: 999 }])).toThrow(/unknown parent/);
  });

  test('photo keys are de-duplicated (two products share one photo)', () => {
    expect(referencedImageKeys(fixture)).toEqual(['cat/2.jpg', 'shared/1.jpg', 'shirt/blue.jpg']);
  });

  test('dev users: one per role plus one inactive, all @dev.local', () => {
    expect(DEV_ADMIN_USERS.map((u) => u.role).sort()).toEqual(['confirmer', 'confirmer', 'content', 'logistics', 'owner']);
    expect(DEV_ADMIN_USERS.every((u) => u.email.endsWith('@dev.local'))).toBe(true);
    expect(DEV_ADMIN_USERS.filter((u) => !u.active).map((u) => u.email)).toEqual(['inactive@dev.local']);
  });
});

describe('DB-3 seed refuses anything but the local D1 (lead ruling)', () => {
  const local = { argv: [], env: {}, databaseId: LOCAL_DATABASE_ID };
  test('local development target is accepted', () => {
    expect(seedRefusals(local)).toEqual([]);
    // The repo's own config, and a commented-out remote flag, are fine.
    const own = readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8');
    expect(seedRefusals({ ...local, configText: own })).toEqual([]);
    expect(seedRefusals({ ...local, configText: '{ "r2_buckets": [{ "binding": "MEDIA" // "remote": true\n }] }' })).toEqual([]);
    expect(seedRefusals({ ...local, env: { ENV: 'development' } })).toEqual([]);
  });
  test.each([
    ['--remote', { ...local, argv: ['--remote'] }],
    ['--remote=true', { ...local, argv: ['--remote=true'] }],
    ['a real database_id', { ...local, databaseId: '6f1c2b8e-1111-4222-8333-944455556666' }],
    ['no database_id', { ...local, databaseId: undefined }],
    ['ENV=production', { ...local, env: { ENV: 'production' } }],
    ['ENV=staging', { ...local, env: { ENV: 'staging' } }],
    ['NODE_ENV=production', { ...local, env: { NODE_ENV: 'production' } }],
    ['CLOUDFLARE_ENV=production', { ...local, env: { CLOUDFLARE_ENV: 'production' } }],
    // DB-3 r1 (rev-b): remote bindings and environments
    ['--env staging', { ...local, argv: ['--env', 'staging'] }],
    ['--env=production', { ...local, argv: ['--env=production'] }],
    ['-e production', { ...local, argv: ['-e', 'production'] }],
    ['an R2 binding marked remote', { ...local, configText: '{ "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "hb-media", "remote": true }] }' }],
    ['a D1 binding marked remote', { ...local, configText: `{ "d1_databases": [{ "binding": "DB", "database_id": "${LOCAL_DATABASE_ID}", "remote" : true }] }` }],
  ])('refuses %s', (_n, target) => {
    expect(seedRefusals(target).length).toBeGreaterThan(0);
  });
  test('the CLI disables remote bindings in getPlatformProxy', () => {
    const cli = readFileSync(fileURLToPath(new URL('../src/seed/cli.ts', import.meta.url)), 'utf8');
    expect(cli).toMatch(/await getPlatformProxy<.*remoteBindings: false/);
    expect(cli.match(/getPlatformProxy</g)).toHaveLength(1);
  });
  test("packages/db/wrangler.jsonc uses the local placeholder database_id", () => {
    const text = readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8');
    expect(databaseIdFromWranglerJsonc(text)).toBe(LOCAL_DATABASE_ID);
    expect(databaseIdFromWranglerJsonc('{ "d1_databases": [ { "binding": "DB", // x\n "database_id": "abc" } ] }')).toBe('abc');
  });
});

// Real data: the repo root (once data/ is on main) or HB_SEED_ROOT (a checkout that has data/).
const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const dataRoot = process.env.HB_SEED_ROOT ?? repoRoot;
const hasData = existsSync(join(dataRoot, 'data', 'catalog', 'validate.mjs')) && existsSync(join(dataRoot, 'data', 'geo', 'communes.json'));

describe.skipIf(!hasData)('DB-3 real data/ loads into a fresh DB, twice', () => {
  test('69 wilayas, 1,541 communes, every fee, catalogue, content; idempotent', async () => {
    const { input } = await loadSeedInput(dataRoot);
    const { sqlite } = freshDb();
    run(sqlite, input);
    const first = counts(sqlite);
    expect(first).toMatchObject({ wilayas: 69, communes: 1541, delivery_fees: 69, admin_users: 5 });
    expect(first.products).toBe(input.products.length);
    expect(first.content_pages).toBe(input.contentPages.length);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    // DB-8: every image's printed prices equal the manifest's for its key ([] when not listed).
    for (const r of sqlite.prepare('select r2_key k, printed_prices_dzd p from images').all() as { k: string; p: string }[]) {
      expect(JSON.parse(r.p), r.k).toEqual(input.printedPrices?.[r.k] ?? []);
    }
    run(sqlite, input);
    expect(counts(sqlite)).toEqual(first);
  }, 60_000);
});
