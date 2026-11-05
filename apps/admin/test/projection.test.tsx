/** @jsxImportSource hono/jsx */
// customers.sensitive: field-level projection enforced at SELECT time (lead decision 2026-11-05).
import { eq } from 'drizzle-orm';
import { createDb, customers, orders } from '@hb/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../src/app.ts';
import { PERMISSIONS } from '../src/auth/permissions.ts';
import { requirePerm } from '../src/auth/require-role.ts';
import { CUSTOMER_SENSITIVE, ORDER_SENSITIVE, customerColumns, orderColumns, projectCustomer, projectOrder, canSeeCustomerHistory } from '../src/lib/projection.ts';
import { harness, testIdentify, USERS, type Harness } from './helpers.ts';

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

describe('row strippers (defence in depth)', () => {
  test('projectCustomer / projectOrder', () => {
    const cust = Object.fromEntries([...CUSTOMER_SENSITIVE, 'name', 'phoneE164'].map((k) => [k, 1]));
    expect(Object.keys(projectCustomer({ role: 'logistics' }, cust)).sort()).toEqual(['name', 'phoneE164']);
    expect(Object.keys(projectCustomer({ role: 'owner' }, cust))).toHaveLength(CUSTOMER_SENSITIVE.length + 2);
    const ord = Object.fromEntries([...ORDER_SENSITIVE, 'ref', 'totalDzd'].map((k) => [k, 1]));
    expect(Object.keys(projectOrder({ role: 'logistics' }, ord)).sort()).toEqual(['ref', 'totalDzd']);
    expect(Object.keys(projectOrder({ role: 'confirmer' }, ord))).toHaveLength(ORDER_SENSITIVE.length + 2);
  });
});
