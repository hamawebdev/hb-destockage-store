// DB-2: append-only triggers, FK child indexes, and index use for the admin queries.
import { describe, expect, test } from 'vitest';
import { eq, is, sql } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '../src/schema.ts';
import { freshDb } from './helpers.ts';

function withOrder() {
  const { sqlite, db } = freshDb();
  sqlite.exec(`
    insert into admin_users (id, email, name, role) values (1, 'owner@dev.local', 'Owner', 'owner');
    insert into categories (id, slug_fr, slug_ar, name_fr, name_ar) values (1, 'cuisine', 'matbakh', 'Cuisine', 'مطبخ');
    insert into products (id, category_id, slug_fr, slug_ar, name_fr, name_ar) values (10, 1, 'p', 'p-ar', 'P', 'ب');
    insert into variants (id, product_id, sku, price_dzd, stock, is_default) values (100, 10, 'S1', 1000, 5, 1);
    insert into wilayas (code, name_fr, name_ar) values (16, 'Alger', 'الجزائر');
    insert into communes (id, wilaya_code, name_fr, name_ar) values (1601, 16, 'Alger Centre', 'الجزائر الوسطى');
    insert into customers (id, phone_e164, name) values (1, '+213560417403', 'Amine');
    insert into orders (id, ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, subtotal_dzd, fee_dzd, total_dzd, fee_source)
      values (1, 'HB-7K2Q9', 'k1', 1, 'Amine', '+213560417403', 16, 1601, 'ar', 1000, 400, 1400, 'table');
    insert into order_events (id, order_id, type, to_status, actor_type) values (1, 1, 'created', 'new', 'customer');
    insert into audit_log (id, actor_type, actor_user_id, actor_email, action, entity, entity_id, after)
      values (1, 'admin', 1, 'owner@dev.local', 'product.update', 'products', '10', '{"priceDzd":1000}');
  `);
  return { sqlite, db };
}

describe('DB-2 append-only tables', () => {
  for (const table of ['audit_log', 'order_events'] as const) {
    describe(table, () => {
      const msg = new RegExp(`${table} is append-only`);

      test('INSERT is allowed (incl. Drizzle insert without id)', () => {
        const { sqlite, db } = withOrder();
        if (table === 'audit_log') {
          db.insert(schema.auditLog).values({ actorType: 'system', action: 'x', entity: 'orders' }).run();
        } else {
          db.insert(schema.orderEvents).values({ orderId: 1, type: 'note', note: 'ok', actorType: 'admin', actorUserId: 1 }).run();
        }
        expect((sqlite.prepare(`select count(*) n from ${table}`).get() as { n: number }).n).toBe(2);
      });

      test('UPDATE aborts', () => {
        const { sqlite } = withOrder();
        expect(() => sqlite.prepare(`update ${table} set at = 0 where id = 1`).run()).toThrow(msg);
      });

      test('UPDATE of zero rows is a no-op, not an error (trigger is per row)', () => {
        const { sqlite } = withOrder();
        expect(sqlite.prepare(`update ${table} set at = 0 where id = 999`).run().changes).toBe(0);
      });

      test('DELETE aborts', () => {
        const { sqlite } = withOrder();
        expect(() => sqlite.prepare(`delete from ${table} where id = 1`).run()).toThrow(msg);
        expect(() => sqlite.prepare(`delete from ${table}`).run()).toThrow(msg);
      });

      test('INSERT OR REPLACE of an existing id aborts (REPLACE skips DELETE triggers)', () => {
        const { sqlite } = withOrder();
        const stmt =
          table === 'audit_log'
            ? `insert or replace into audit_log (id, actor_type, action, entity) values (1, 'system', 'forged', 'orders')`
            : `insert or replace into order_events (id, order_id, type, actor_type) values (1, 1, 'note', 'system')`;
        expect(() => sqlite.prepare(stmt).run()).toThrow(msg);
        expect(() => sqlite.prepare(stmt.replace('insert or replace', 'replace')).run()).toThrow(msg);
      });

      test('upsert (ON CONFLICT DO UPDATE) aborts', () => {
        const { sqlite } = withOrder();
        const stmt =
          table === 'audit_log'
            ? `insert into audit_log (id, actor_type, action, entity) values (1, 'system', 'x', 'orders') on conflict(id) do update set action = 'forged'`
            : `insert into order_events (id, order_id, type, actor_type) values (1, 1, 'note', 'system') on conflict(id) do update set note = 'forged'`;
        expect(() => sqlite.prepare(stmt).run()).toThrow(msg);
      });

      test('Drizzle update/delete abort too', () => {
        const { db } = withOrder();
        const t = table === 'audit_log' ? schema.auditLog : schema.orderEvents;
        expect(() => db.update(t).set({ at: 0 }).where(eq(t.id, 1)).run()).toThrow(msg);
        expect(() => db.delete(t).where(eq(t.id, 1)).run()).toThrow(msg);
      });

      test('an abort inside a transaction rolls the whole transaction back (D1 batch semantics)', () => {
        const { sqlite } = withOrder();
        const tx = sqlite.transaction(() => {
          sqlite.prepare(`update variants set stock = 0 where id = 100`).run();
          sqlite.prepare(`delete from ${table} where id = 1`).run();
        });
        expect(() => tx()).toThrow(msg);
        expect((sqlite.prepare('select stock from variants where id = 100').get() as { stock: number }).stock).toBe(5);
      });
    });
  }

  test('the row is unchanged after every refused write', () => {
    const { sqlite } = withOrder();
    for (const s of [
      `update audit_log set action = 'x'`,
      `delete from audit_log`,
      `insert or replace into audit_log (id, actor_type, action, entity) values (1, 'system', 'x', 'y')`,
    ]) {
      expect(() => sqlite.prepare(s).run()).toThrow();
    }
    expect(sqlite.prepare('select action, after from audit_log where id = 1').get()).toEqual({ action: 'product.update', after: '{"priceDzd":1000}' });
  });
});

const tables = (Object.values(schema) as unknown[]).filter((v): v is SQLiteTable => is(v, SQLiteTable));

describe('DB-2 indexes', () => {
  test('every foreign-key child column is the leading column of some index (or the PK)', () => {
    const { sqlite } = freshDb();
    const missing: string[] = [];
    for (const t of tables) {
      const name = getTableConfig(t).name;
      const fks = sqlite.prepare('select "from" as col from pragma_foreign_key_list(?)').all(name) as { col: string }[];
      const leading = new Set<string>();
      for (const idx of sqlite.prepare('select name from pragma_index_list(?)').all(name) as { name: string }[]) {
        const first = sqlite.prepare('select name from pragma_index_info(?) where seqno = 0').get(idx.name) as { name: string } | undefined;
        if (first) leading.add(first.name);
      }
      const pkFirst = (sqlite.prepare('select name from pragma_table_info(?) where pk = 1').get(name) as { name: string } | undefined)?.name;
      if (pkFirst) leading.add(pkFirst);
      for (const fk of fks) if (!leading.has(fk.col)) missing.push(`${name}.${fk.col}`);
    }
    // Admin-user audit columns are low-volume parents never deleted (deactivated instead).
    const allowed = new Set([
      'delivery_fees.updated_by',
      'content_pages.updated_by',
      'settings.updated_by',
      'order_events.actor_user_id',
      'orders.claimed_by_user_id',
      'publish_runs.requested_by',
    ]);
    expect(missing.filter((m) => !allowed.has(m))).toEqual([]);
  });

  // Admin and order-path queries must hit an index, not scan the table.
  const plans: [string, string, RegExp][] = [
    ['orders by status, newest first', `select id from orders where status = 'new' order by created_at desc, id desc limit 50`, /orders_status_created_idx/],
    ['orders newest first', `select id from orders order by created_at desc, id desc limit 50`, /orders_created_idx/],
    ['orders by phone (dedup window)', `select id from orders where phone_e164 = '+213560417403' and created_at > 0`, /orders_phone_created_idx/],
    ['order by ref', `select id from orders where ref = 'HB-7K2Q9'`, /orders_ref_uq/],
    ['order by idempotency key', `select id from orders where idempotency_key = 'k'`, /orders_idempotency_key_uq/],
    ['callbacks due', `select id from orders where status = 'unreachable' and next_call_at <= 0`, /orders_status_next_call_idx/],
    ['flagged orders', `select id from orders where flags <> '[]' order by created_at desc, id desc`, /orders_flagged_created_idx/],
    ['orders of a customer', `select id from orders where customer_id = 1 order by created_at desc`, /orders_customer_created_idx/],
    ['customer by phone', `select id from customers where phone_e164 = '+213560417403'`, /customers_phone_uq/],
    ['items of an order', `select id from order_items where order_id = 1`, /order_items_order_idx/],
    ['events of an order', `select id from order_events where order_id = 1 order by at`, /order_events_order_idx/],
    ['variants of a product', `select id from variants where product_id = 10 order by position`, /variants_product_idx/],
    ['communes of a wilaya', `select id from communes where wilaya_code = 16`, /communes_wilaya_idx/],
    ['products of a category', `select id from products where category_id = 1 and status = 'active' order by sort`, /products_category_idx/],
    ['audit trail of an entity', `select id from audit_log where entity = 'products' and entity_id = '10' order by at`, /audit_log_entity_idx/],
  ];

  test.each(plans)('%s uses an index', (_name, query, idx) => {
    const { sqlite } = freshDb();
    const plan = (sqlite.prepare(`explain query plan ${query}`).all() as { detail: string }[]).map((r) => r.detail).join(' | ');
    expect(plan).toMatch(idx);
    expect(plan).not.toMatch(/^SCAN \w+$/m);
  });

  test('drizzle sql helper sanity: index names in the migration match schema', () => {
    const { db } = freshDb();
    const rows = db.all<{ name: string }>(sql`select name from sqlite_master where type = 'index' and name not like 'sqlite_%'`);
    const fromSchema = tables.flatMap((t) => getTableConfig(t).indexes.map((i) => i.config.name)).sort();
    expect(rows.map((r) => r.name).sort()).toEqual(fromSchema);
  });
});

describe('DB-2 order geography and parent deletes', () => {
  test("an order's commune must belong to its wilaya (insert)", () => {
    const { sqlite } = withOrder();
    sqlite.exec(`insert into wilayas (code, name_fr, name_ar) values (31, 'Oran', 'وهران');
                 insert into communes (id, wilaya_code, name_fr, name_ar) values (3101, 31, 'Oran', 'وهران');`);
    const ins = (wilaya: number, commune: number, key: string) =>
      sqlite
        .prepare(
          `insert into orders (ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, subtotal_dzd, fee_dzd, total_dzd, fee_source)
           values (?, ?, 1, 'A', '+213560417403', ?, ?, 'fr', 1, 0, 1, 'table')`,
        )
        .run(`HB-XXX${key}`, key, wilaya, commune);
    expect(() => ins(16, 3101, 'X1')).toThrow(/commune_id is not in orders.wilaya_code/);
    expect(ins(31, 3101, 'X2').changes).toBe(1);
  });

  test("an order's commune must belong to its wilaya (update of either column)", () => {
    const { sqlite } = withOrder();
    sqlite.exec(`insert into wilayas (code, name_fr, name_ar) values (31, 'Oran', 'وهران');
                 insert into communes (id, wilaya_code, name_fr, name_ar) values (3101, 31, 'Oran', 'وهران');`);
    expect(() => sqlite.prepare('update orders set commune_id = 3101 where id = 1').run()).toThrow(/wilaya_code/);
    expect(() => sqlite.prepare('update orders set wilaya_code = 31 where id = 1').run()).toThrow(/wilaya_code/);
    expect(sqlite.prepare('update orders set wilaya_code = 31, commune_id = 3101 where id = 1').run().changes).toBe(1);
    // Unrelated column updates are not affected.
    expect(sqlite.prepare("update orders set status = 'called' where id = 1").run().changes).toBe(1);
  });

  test.each([
    ['HB-7K2Q9', true],
    ['HB-00000', true],
    ['HB-ZZZZZ', true],
    ['HB-7K2QI', false], // I is not Crockford
    ['HB-7K2QO', false], // O
    ['HB-7K2QL', false], // L
    ['HB-7K2QU', false], // U
    ['HB-7k2q9', false], // lower case
    ['HB-7K2Q', false],
    ['HB-7K2Q90', false],
    ['XX-7K2Q9', false],
    ['', false],
  ] as const)('order ref %s accepted: %s', (ref, ok) => {
    const { sqlite } = withOrder();
    const ins = () =>
      sqlite
        .prepare(
          `insert into orders (ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, subtotal_dzd, fee_dzd, total_dzd, fee_source)
           values (?, 'k-ref', 1, 'A', '+213560417403', 16, 1601, 'fr', 1, 0, 1, 'table')`,
        )
        .run(ref);
    const upd = () => sqlite.prepare('update orders set ref = ? where id = 1').run(ref);
    if (ok && ref !== 'HB-7K2Q9') {
      expect(ins().changes).toBe(1);
    } else if (!ok) {
      expect(ins).toThrow(/orders.ref must match/);
      expect(upd).toThrow(/orders.ref must match/);
    }
  });

  test('deleting an order with events/items is refused (no cascade into append-only rows)', () => {
    const { sqlite } = withOrder();
    expect(() => sqlite.prepare('delete from orders where id = 1').run()).toThrow(/FOREIGN KEY/);
    expect((sqlite.prepare('select count(*) n from order_events').get() as { n: number }).n).toBe(1);
  });

  test('deleting an admin user referenced by the audit log is refused', () => {
    const { sqlite } = withOrder();
    expect(() => sqlite.prepare('delete from admin_users where id = 1').run()).toThrow(/FOREIGN KEY/);
  });
});

describe('DB-2 storage types and formats (rev-d DB-1 r1 nits)', () => {
  const refused: [string, string, RegExp][] = [
    ['REAL price', 'update variants set price_dzd = 999.5 where id = 100', /variants: money\/quantity/],
    ['TEXT stock', "update variants set stock = 'many' where id = 100", /variants: money\/quantity/],
    ['REAL compare-at', 'update variants set compare_at_dzd = 2000.5 where id = 100', /variants: money\/quantity/],
    ['REAL fee', 'update orders set fee_dzd = 0.5, total_dzd = 1000.5 where id = 1', /orders: money\/quantity/],
    ['REAL delivery fee', "insert into delivery_fees (wilaya_code, fee_dzd) values (16, 400.5)", /delivery_fees: money\/quantity/],
    ['flags object', `update orders set flags = '{"a":1}' where id = 1`, /orders.flags must be a JSON array/],
    ['customer flags string', `update customers set flags = '"x"' where id = 1`, /customers.flags must be a JSON array/],
    ['fee_source free text', "update orders set fee_source = 'admin-table' where id = 1", /fee_source must be/],
    ['fee_source courier without name', "update orders set fee_source = 'courier:' where id = 1", /fee_source must be/],
  ];
  test.each(refused)('refuses %s', (_n, stmt, err) => {
    const { sqlite } = withOrder();
    expect(() => sqlite.prepare(stmt).run()).toThrow(err);
  });

  test('lossless integer text/real is coerced by affinity and accepted; NULL stock stays allowed', () => {
    const { sqlite } = withOrder();
    sqlite.prepare("update variants set stock = '12', price_dzd = 1200.0 where id = 100").run();
    expect(sqlite.prepare('select typeof(stock) s, typeof(price_dzd) p from variants where id = 100').get()).toEqual({ s: 'integer', p: 'integer' });
    sqlite.prepare('update variants set stock = null where id = 100').run();
    sqlite.prepare("update orders set fee_source = 'courier:yalidine' where id = 1").run();
    sqlite.prepare(`update orders set flags = '["duplicate"]' where id = 1`).run();
  });

  test('an order_items row with a REAL quantity is refused', () => {
    const { sqlite } = withOrder();
    expect(() =>
      sqlite.prepare("insert into order_items (order_id, variant_id, product_id, name_fr, name_ar, sku, unit_price_dzd, qty, line_total_dzd) values (1, 100, 10, 'a', 'b', 'S1', 1000, 1.5, 1500)").run(),
    ).toThrow(/order_items: money\/quantity/);
  });
});

describe('DB-2 triggers exist with the expected names', () => {
  test('append-only and geography triggers', () => {
    const { sqlite } = freshDb();
    const names = (sqlite.prepare("select name from sqlite_master where type = 'trigger' order by name").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual([
      'audit_log_no_delete',
      'audit_log_no_replace',
      'audit_log_no_update',
      'order_events_no_delete',
      'order_events_no_replace',
      'order_events_no_update',
      'orders_commune_in_wilaya_ins',
      'orders_commune_in_wilaya_upd',
      'orders_ref_format_ins',
      'orders_ref_format_upd',
      ...['variants', 'orders', 'order_items', 'delivery_fees', 'pack_items'].flatMap((x) => [`${x}_int_types_ins`, `${x}_int_types_upd`]),
      'orders_flags_array_ins',
      'orders_flags_array_upd',
      'customers_flags_array_ins',
      'customers_flags_array_upd',
      'orders_fee_source_fmt_ins',
      'orders_fee_source_fmt_upd',
    ].sort());
  });
});
