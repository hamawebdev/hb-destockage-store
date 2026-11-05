/**
 * D1 adapter of the `OrderStore` port. Reads are web's (they shape the API response); the writes
 * (`createOrder`, `markDuplicate`) are db's DB-4 functions (`@hb/db/orders`), injectable for tests.
 */
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { customers, orderEvents, orderItems, orders, type Db } from '@hb/db';
import { createOrder as dbCreateOrder, markDuplicate as dbMarkDuplicate } from '@hb/db/orders';
import { DUPLICATE_WINDOW_MS, makeOrderRef, type OrderRef } from '@hb/shared';
import type { CreateOrderInput, CreateOrderResult, DuplicateAttempt, ExistingOrder, OrderStore, PhoneHistory } from './store.ts';

export interface OrderWrites {
  createOrder(db: Db, input: CreateOrderInput): Promise<CreateOrderResult>;
  markDuplicate(db: Db, orderId: number, attempt: DuplicateAttempt, now: number): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const existingColumns = {
  id: orders.id,
  ref: orders.ref,
  status: orders.status,
  lang: orders.lang,
  subtotalDzd: orders.subtotalDzd,
  feeDzd: orders.feeDzd,
  totalDzd: orders.totalDzd,
};

function toExisting(r: { id: number; ref: string; status: ExistingOrder['status']; lang: ExistingOrder['lang']; subtotalDzd: number; feeDzd: number; totalDzd: number }): ExistingOrder {
  return { ...r, ref: r.ref as OrderRef };
}

export function createD1OrderStore(db: Db, writes: OrderWrites): OrderStore {
  return {
    async findByIdempotencyKey(key) {
      const r = await db.select(existingColumns).from(orders).where(eq(orders.idempotencyKey, key)).get();
      return r === undefined ? null : toExisting(r);
    },

    async getOrder(id) {
      const r = await db.select(existingColumns).from(orders).where(eq(orders.id, id)).get();
      return r === undefined ? null : toExisting(r);
    },

    async phoneHistory(phoneE164, variantIds, now): Promise<PhoneHistory> {
      const dupQuery = db
        .select(existingColumns)
        .from(orders)
        .where(
          and(
            eq(orders.phoneE164, phoneE164),
            gte(orders.createdAt, now - DUPLICATE_WINDOW_MS),
            ne(orders.status, 'cancelled'),
            sql`exists (select 1 from ${orderItems} where ${orderItems.orderId} = ${orders.id} and ${inArray(orderItems.variantId, [...variantIds])})`,
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(1);
      const countQuery = db
        .select({ n: sql<number>`count(*)` })
        .from(orders)
        .where(and(eq(orders.phoneE164, phoneE164), gte(orders.createdAt, now - DAY_MS), ne(orders.status, 'cancelled')));
      const customerQuery = db.select({ blocked: customers.blocked }).from(customers).where(eq(customers.phoneE164, phoneE164)).limit(1);
      const [dup, count, customer] = await db.batch([dupQuery, countQuery, customerQuery]);
      return {
        duplicate: dup[0] === undefined ? null : toExisting(dup[0]),
        ordersLast24h: Number(count[0]?.n ?? 0),
        blocked: customer[0]?.blocked === true,
      };
    },

    markDuplicate: (orderId, attempt, now) => writes.markDuplicate(db, orderId, attempt, now),
    createOrder: (input) => writes.createOrder(db, input),

    async noteEnqueueFailed(orderId, now) {
      await db.insert(orderEvents).values({
        orderId,
        type: 'note',
        note: 'order.created notification could not be enqueued (web); the order is stored',
        actorType: 'system',
        at: now,
      });
    },
  };
}

/** What the second submission asked for, as the order_events note (ids and numbers only, no PII). */
export function describeAttempt(a: DuplicateAttempt): string {
  const items = a.items.map((i) => `${i.variantId}x${i.qty}`).join(',');
  return `duplicate submit: items=${items} wilaya=${a.wilayaCode} commune=${a.communeId}`;
}

/** The real writes: db's DB-4 `createOrder` (one batch; ref collisions retried inside) and `markDuplicate`. */
export const DB_WRITES: OrderWrites = {
  createOrder: (db, input) =>
    dbCreateOrder(db, input, { newRef: () => makeOrderRef(crypto.getRandomValues(new Uint8Array(5))) }),
  markDuplicate: (db, orderId, attempt, now) => dbMarkDuplicate(db, orderId, describeAttempt(attempt), now),
};
