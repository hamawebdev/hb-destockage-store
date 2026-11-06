/** @jsxImportSource hono/jsx */
// customers.sensitive: field-level projection enforced at SELECT time (lead decision 2026-11-05).
import { eq } from 'drizzle-orm';
import { communes, createDb, customers, orders } from '@hb/db';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { PERMISSIONS } from '../src/auth/permissions.ts';
import { requirePerm } from '../src/auth/require-role.ts';
import { CUSTOMER_DELIVERY_KEYS, CUSTOMER_SENSITIVE, ORDER_DELIVERY_KEYS, ORDER_SENSITIVE, customerColumns, orderColumns, projectCustomer, projectOrder, canSeeCustomerHistory } from '../src/lib/projection.ts';
import { harness, testIdentify, USERS, type Harness } from './helpers.ts';

// Real D1 (workerd) requests take seconds on the loaded shared machine: explicit budgets instead
// of vitest's 5 s default, so the admin gate is not red at random (lead, 2026-11-06).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let h: Harness;
let customerId: number;
const SECRET_NOTE = 'NOTE-very-private-7731';
beforeAll(async () => {
  h = await harness();
  const r = await h.db
    .prepare("insert into customers (phone_e164, name, order_count, delivered_count, returned_count, cancelled_count, flags, blocked, notes) values ('+213560417403', 'Amina', 4, 2, 1, 1, '[\"FLAG-fraud-suspect\"]', 1, ?) returning id")
    .bind(SECRET_NOTE)
    .first<{ id: number }>();
  customerId = r!.id;
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe('permission', () => {
  test('customers.sensitive = owner, confirmer only', () => {
    expect([...PERMISSIONS['customers.sensitive']].sort()).toEqual(['confirmer', 'owner']);
    expect(canSeeCustomerHistory({ role: 'logistics' })).toBe(false);
    expect(canSeeCustomerHistory({ role: 'content' })).toBe(false);
    expect(canSeeCustomerHistory({ role: 'confirmer' })).toBe(true);
  });
});

describe('the SQL never selects sensitive columns without the permission', () => {
  const db = () => createDb({} as D1Database);
  const sensitiveCustomerSql = ['order_count', 'delivered_count', 'returned_count', 'cancelled_count', '"flags"', 'blocked', 'notes', 'last_order_at'];
  const sensitiveOrderSql = ['idempotency_key', '"flags"', 'turnstile', 'fill_ms', 'risk_score', 'ip_hash', 'call_attempts', 'next_call_at', 'claimed_by_user_id', 'claimed_until'];
  test('customers', () => {
    const lg = db().select(customerColumns({ role: 'logistics' })).from(customers).toSQL().sql;
    for (const col of sensitiveCustomerSql) expect(lg, col).not.toContain(col);
    for (const col of ['"name"', 'phone_e164']) expect(lg).toContain(col);
    const cf = db().select(customerColumns({ role: 'confirmer' })).from(customers).toSQL().sql;
    for (const col of sensitiveCustomerSql) expect(cf, col).toContain(col);
  });
  test('orders', () => {
    const lg = db().select(orderColumns({ role: 'logistics' })).from(orders).toSQL().sql;
    for (const col of sensitiveOrderSql) expect(lg, col).not.toContain(col);
    for (const col of ['"ref"', 'phone_e164', 'wilaya_code', 'commune_id', 'address', 'total_dzd', 'status', 'courier_tracking']) expect(lg, col).toContain(col);
    const ow = db().select(orderColumns({ role: 'owner' })).from(orders).toSQL().sql;
    for (const col of sensitiveOrderSql) expect(ow, col).toContain(col);
  });
});

describe('a page built on the helper cannot leak (raw HTML search)', () => {
  // A customer page the way admin-orders builds it: select with customerColumns, render every
  // field it received. Logistics must not find any sensitive value in the HTML.
  function app() {
    const a = createApp({ identify: testIdentify });
    a.get('/t/customer/:id', requirePerm('customers.view'), async (c) => {
      const row = await c.var.db.select(customerColumns(c.var.user)).from(customers).where(eq(customers.id, Number(c.req.param('id')))).get();
      return c.render(
        <dl class="details">
          {Object.entries(row ?? {}).map(([k, v]) => (
            <>
              <dt>{k}</dt>
              <dd>{JSON.stringify(v)}</dd>
            </>
          ))}
        </dl>,
        { title: 'customer' },
      );
    });
    return a;
  }
  test('logistics: delivery fields only', async () => {
    const html = await (await app().request(`/t/customer/${customerId}`, { headers: { 'x-test-user': USERS.logistics } }, h.env)).text();
    expect(html).toContain('Amina');
    expect(html).toContain('+213560417403');
    for (const leak of [SECRET_NOTE, 'FLAG-fraud-suspect', 'blocked', 'orderCount', 'notes', 'lastOrderAt']) expect(html, leak).not.toContain(leak);
  });
  test('confirmer: everything', async () => {
    const html = await (await app().request(`/t/customer/${customerId}`, { headers: { 'x-test-user': USERS.confirmer } }, h.env)).text();
    for (const v of [SECRET_NOTE, 'FLAG-fraud-suspect', 'blocked', 'orderCount']) expect(html, v).toContain(v);
  });
  test('content cannot open customers at all', async () => {
    expect((await app().request(`/t/customer/${customerId}`, { headers: { 'x-test-user': USERS.content } }, h.env)).status).toBe(403);
  });
});

describe('row projection is an allow-list (review 18f8a4b F1)', () => {
  test('known delivery keys survive; sensitive AND unknown keys are dropped, whatever the alias', () => {
    const row = {
      name: 'Amina',
      phoneE164: '+213560417403',
      ref: 'HB-7K2Q9',
      totalDzd: 15000,
      // aliases a join could produce:
      customerBlocked: 1,
      customerNotes: SECRET_NOTE,
      orderCount: 4,
      ip_hash: 'abc',
      customerFlags: '["fraud"]',
      somethingNew: 'x',
    };
    expect(Object.keys(projectOrder({ role: 'logistics' }, row)).sort()).toEqual(['name', 'phoneE164', 'ref', 'totalDzd']);
    expect(Object.keys(projectCustomer({ role: 'logistics' }, row)).sort()).toEqual(['name', 'phoneE164']);
    expect(projectOrder({ role: 'confirmer' }, row)).toEqual(row);
    // Every table delivery key passes; no sensitive table key does.
    const ord = Object.fromEntries([...ORDER_SENSITIVE, ...ORDER_DELIVERY_KEYS].map((k) => [k, 1]));
    expect(Object.keys(projectOrder({ role: 'logistics' }, ord)).sort()).toEqual([...ORDER_DELIVERY_KEYS].sort());
    const cust = Object.fromEntries([...CUSTOMER_SENSITIVE, ...CUSTOMER_DELIVERY_KEYS].map((k) => [k, 1]));
    expect(Object.keys(projectCustomer({ role: 'logistics' }, cust)).sort()).toEqual([...CUSTOMER_DELIVERY_KEYS].sort());
  });
  test('aliases must be declared safe explicitly; sensitive-looking names cannot be', () => {
    const row = { ref: 'HB-1', communeNameFr: 'Alger Centre', customerNotes: 'x' };
    expect(projectOrder({ role: 'logistics' }, row, { safe: ['communeNameFr'] })).toEqual({ ref: 'HB-1', communeNameFr: 'Alger Centre' });
    for (const bad of ['customerNotes', 'notes', 'riskScore', 'ip_hash', 'orderCount', 'customerBlocked', 'flags', 'callAttempts', 'historyJson']) {
      expect(() => projectOrder({ role: 'logistics' }, row, { safe: [bad] }), bad).toThrow();
    }
  });
});

describe('a JOIN with aliased sensitive columns, rendered as logistics, leaks nothing', () => {
  beforeAll(async () => {
    await h.db.batch([
      h.db.prepare("insert or ignore into wilayas (code, name_fr, name_ar) values (16, 'Alger', 'الجزائر')"),
      h.db.prepare("insert or ignore into communes (id, wilaya_code, name_fr, name_ar) values (1601, 16, 'Alger Centre', 'الجزائر الوسطى')"),
    ]);
    await h.db
      .prepare(
        "insert into orders (ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, subtotal_dzd, fee_dzd, total_dzd, fee_source, flags, risk_score, ip_hash) values ('HB-JN7Q1', 'idem-join-1', ?, 'Amina', '+213560417403', 16, 1601, 'ar', 14600, 400, 15000, 'table', '[\"ORDERFLAG-dup\"]', 87, 'IPHASH-deadbeef')",
      )
      .bind(customerId)
      .run();
  });
  function app() {
    const a = createApp({ identify: testIdentify });
    a.get('/t/order-joined/:ref', requirePerm('orders.view'), async (c) => {
      // The kind of detail query a builder writes: order + customer + commune, with aliases.
      const row = await c.var.db
        .select({
          ...orderColumns(c.var.user),
          customerBlocked: customers.blocked,
          customerNotes: customers.notes,
          customerOrderCount: customers.orderCount,
          customerFlags: customers.flags,
          communeNameFr: communes.nameFr,
        })
        .from(orders)
        .innerJoin(customers, eq(customers.id, orders.customerId))
        .innerJoin(communes, eq(communes.id, orders.communeId))
        .where(eq(orders.ref, c.req.param('ref')))
        .get();
      const shown = projectOrder(c.var.user, row ?? {}, { safe: ['communeNameFr'] });
      return c.render(
        <dl class="details">
          {Object.entries(shown).map(([k, v]) => (
            <>
              <dt>{k}</dt>
              <dd>{JSON.stringify(v)}</dd>
            </>
          ))}
        </dl>,
        { title: 'order' },
      );
    });
    return a;
  }
  const LEAKS = [SECRET_NOTE, 'FLAG-fraud-suspect', 'ORDERFLAG-dup', 'IPHASH-deadbeef', 'idem-join-1', 'customerBlocked', 'customerNotes', 'customerOrderCount', 'customerFlags', 'riskScore', 'ipHash'];
  test('logistics: delivery data and the declared-safe commune only', async () => {
    const html = await (await app().request('/t/order-joined/HB-JN7Q1', { headers: { 'x-test-user': USERS.logistics } }, h.env)).text();
    for (const ok of ['HB-JN7Q1', 'Amina', '+213560417403', 'Alger Centre', '15000']) expect(html, ok).toContain(ok);
    for (const leak of LEAKS) expect(html, leak).not.toContain(leak);
  });
  test('confirmer sees them all', async () => {
    const html = await (await app().request('/t/order-joined/HB-JN7Q1', { headers: { 'x-test-user': USERS.confirmer } }, h.env)).text();
    for (const v of [SECRET_NOTE, 'ORDERFLAG-dup', 'IPHASH-deadbeef', 'customerBlocked']) expect(html, v).toContain(v);
  });
});
