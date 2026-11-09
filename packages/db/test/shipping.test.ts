// SHIP-1 (SHIP-0 contract checks 1, 1a, 1b, 1c): delivery schema, the open-slot triggers, the system
// actor, the extra guard on order changes, and the secret box. Triggers on SQLite and real D1.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { applyOrderChange, buildOrderChange, classifyConstraintError, orderGuard, type OrderBatchItem, type OrderChange } from '../src/orders.ts';
import { importSecretBoxKey, openSecret, sealSecret, SecretBoxKeyError, SecretBoxOpenError } from '../src/secret-box.ts';
import { courierAccounts, orderEvents, orders, shipments, variants, type Db } from '../src/index.ts';
import { buildSeedStatements } from '../src/seed/build.ts';
import { loadSeedInput } from '../src/seed/load.ts';
import { exec, freshD1, type RawD1 } from './d1.ts';
import { freshDb, MIGRATIONS_DIR, migrationFiles } from './helpers.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const FIXTURE = `
  insert into admin_users (id, email, name, role) values (1, 'owner@dev.local', 'O', 'owner');
  insert into categories (id, slug_fr, slug_ar, name_fr, name_ar) values (1, 'c', 'c-ar', 'C', 'ك');
  insert into products (id, category_id, slug_fr, slug_ar, name_fr, name_ar, status) values (10, 1, 'p', 'p-ar', 'P', 'ب', 'active');
  insert into variants (id, product_id, sku, price_dzd, stock, is_default) values (100, 10, 'S1', 1000, 5, 1);
  insert into wilayas (code, name_fr, name_ar) values (16, 'Alger', 'الجزائر'), (31, 'Oran', 'وهران');
  insert into communes (id, wilaya_code, name_fr, name_ar) values (1601, 16, 'Alger Centre', 'الجزائر الوسطى'), (3101, 31, 'Oran', 'وهران');
  insert into customers (id, phone_e164, name) values (1, '+213560417403', 'Amine');
  insert into courier_accounts (id, courier) values (1, 'yalidine')`;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const refOf = (n: number) => `HB-${[0, 1, 2, 3, 4].map((i) => ALPHABET[Math.floor(n / 32 ** (4 - i)) % 32]).join('')}`;

function orderSql(id: number, status: string, address: string | null): string {
  return `insert into orders (id, ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, address, lang, status, subtotal_dzd, fee_dzd, total_dzd, fee_source)
    values (${id}, '${refOf(id)}', 'k${id}', 1, 'Amine', '+213560417403', 16, 1601, ${address === null ? 'null' : `'${address}'`}, 'ar', '${status}', 1000, 400, 1400, 'table')`;
}

function shipmentSql(id: number, orderId: number, state: string, appliedAt: number | null = null): string {
  const tracking = state === 'draft' || state === 'accepted' ? `'T${id}'` : 'null';
  return `insert into shipments (id, order_id, courier, account_id, state, reference, tracking, cod_amount_dzd, fee_dzd, wilaya_code, commune_id, applied_at, created_by)
    values (${id}, ${orderId}, 'yalidine', 1, '${state}', '${refOf(orderId)}', ${tracking}, 1400, 400, 16, 1601, ${appliedAt ?? 'null'}, 1)`;
}

const OPEN: readonly [state: string, appliedAt: number | null][] = [
  ['reserved', null],
  ['sending', null],
  ['draft', null],
  ['uncertain', null],
  ['accepted', null],
];

describe('open-slot triggers (SQLite)', () => {
  const setup = (state: string, appliedAt: number | null, address: string | null = 'Rue 1') => {
    const { sqlite } = freshDb();
    sqlite.exec(FIXTURE);
    sqlite.exec(orderSql(1, 'confirmed', address));
    sqlite.exec(shipmentSql(1, 1, state, appliedAt));
    return sqlite;
  };
  const CHANGES: readonly [name: string, set: string][] = [
    ['status to cancelled', `status = 'cancelled'`],
    ['status to shipped', `status = 'shipped'`],
    ['wilaya and commune', `wilaya_code = 31, commune_id = 3101`],
    ['fee and total', `fee_dzd = 500, total_dzd = 1500`],
    ['phone', `phone_e164 = '+213660417403'`],
    ['name', `name = 'Karim'`],
    ['address', `address = 'Rue 2'`],
    ['address to NULL', `address = null`],
  ];

  describe.each(OPEN)('slot %s', (state, appliedAt) => {
    test.each(CHANGES)('refuses %s', (_name, set) => {
      const sqlite = setup(state, appliedAt);
      expect(() => sqlite.exec(`update orders set ${set} where id = 1`)).toThrow(/shipment_in_progress/);
    });
    test('refuses address from NULL to a value', () => {
      const sqlite = setup(state, appliedAt, null);
      expect(() => sqlite.exec(`update orders set address = 'Rue 2' where id = 1`)).toThrow(/shipment_in_progress/);
    });
    test('lets a no-op update and an unrelated column through', () => {
      const sqlite = setup(state, appliedAt);
      sqlite.exec(`update orders set status = 'confirmed', address = 'Rue 1', name = 'Amine', version = version + 1, next_call_at = 5 where id = 1`);
      expect((sqlite.prepare('select version, next_call_at as n from orders where id = 1').get() as { version: number; n: number })).toEqual({ version: 1, n: 5 });
    });
  });

  test.each([
    ['failed', null],
    ['accepted', 123],
  ] as const)('a closed slot (%s) blocks nothing', (state, appliedAt) => {
    const sqlite = setup(state, appliedAt);
    sqlite.exec(`update orders set address = 'Rue 2', status = 'cancelled' where id = 1`);
    expect((sqlite.prepare('select status, address from orders where id = 1').get() as { status: string })).toEqual({ status: 'cancelled', address: 'Rue 2' });
  });

  test('statuses other than confirmed are not guarded by the status trigger', () => {
    const { sqlite } = freshDb();
    sqlite.exec(FIXTURE);
    sqlite.exec(orderSql(1, 'called', null));
    sqlite.exec(`update orders set status = 'confirmed' where id = 1`);
    expect((sqlite.prepare('select status from orders where id = 1').get() as { status: string }).status).toBe('confirmed');
  });

  test('both triggers exist on orders after every migration', () => {
    const { sqlite } = freshDb();
    const names = (sqlite.prepare(`select name from sqlite_master where type = 'trigger' and tbl_name = 'orders'`).all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['orders_open_slot_status', 'orders_open_slot_contact']));
  });

  test('one live parcel per order, any courier; a failed row frees the slot', () => {
    const sqlite = setup('sending', null);
    sqlite.exec(`insert into courier_accounts (id, courier) values (2, 'guepex')`);
    const second = shipmentSql(2, 1, 'reserved').replace(`'yalidine', 1`, `'guepex', 2`);
    expect(() => sqlite.exec(second)).toThrow(/UNIQUE constraint failed/);
    sqlite.exec(`update shipments set state = 'failed' where id = 1`);
    sqlite.exec(second);
  });

  test('unique tracking per courier, and open exceptions dedupe by kind, subject and raw status', () => {
    const { sqlite } = freshDb();
    sqlite.exec(FIXTURE);
    sqlite.exec(orderSql(1, 'shipped', null));
    sqlite.exec(orderSql(2, 'shipped', null));
    sqlite.exec(shipmentSql(1, 1, 'accepted', 1).replace(`'T1'`, `'SAME'`));
    expect(() => sqlite.exec(shipmentSql(2, 2, 'accepted', 1).replace(`'T2'`, `'SAME'`))).toThrow(/UNIQUE constraint failed/);
    const ex = (subject: string, raw: string | null) =>
      raw === null ? `insert into delivery_exceptions (kind, subject) values ('unknown_status', '${subject}')` : `insert into delivery_exceptions (kind, subject, raw_status) values ('unknown_status', '${subject}', '${raw}')`;
    sqlite.exec(ex('s:1', 'X'));
    expect(() => sqlite.exec(ex('s:1', 'X'))).toThrow(/UNIQUE constraint failed/);
    sqlite.exec(ex('s:1', 'Y'));
    sqlite.exec(ex('s:2', 'X'));
    sqlite.exec(ex('c:a', null));
    expect(() => sqlite.exec(ex('c:a', null))).toThrow(/UNIQUE constraint failed/);
    sqlite.exec(`update delivery_exceptions set state = 'resolved' where subject = 's:1' and raw_status = 'X'`);
    sqlite.exec(ex('s:1', 'X'));
  });

  test('shipment CHECKs: accepted and draft need a tracking, stop desk needs an id, unknown state refused', () => {
    const sqlite = setup('sending', null);
    expect(() => sqlite.exec(`update shipments set state = 'accepted' where id = 1`)).toThrow(/shipments_accepted_has_tracking/);
    expect(() => sqlite.exec(`update shipments set delivery_type = 'stop_desk' where id = 1`)).toThrow(/shipments_stop_desk_has_id/);
    expect(() => sqlite.exec(`update shipments set state = 'lost' where id = 1`)).toThrow(/shipments_state_enum/);
  });

  test('a body over 32 KiB and oversized headers are refused by the database', () => {
    const { sqlite } = freshDb();
    sqlite.exec(FIXTURE);
    const ins = sqlite.prepare(`insert into courier_webhook_inbox (account_id, courier, body, headers) values (1, 'yalidine', ?, ?)`);
    ins.run(Buffer.alloc(32768), '{}');
    expect(() => ins.run(Buffer.alloc(32769), '{}')).toThrow(/courier_webhook_inbox_body_size/);
    expect(() => ins.run(Buffer.alloc(1), JSON.stringify({ a: 'x'.repeat(8192) }))).toThrow(/courier_webhook_inbox_headers_size/);
  });

  test('a directory payload too big for one backup statement is refused, counted in bytes', () => {
    const { sqlite } = freshDb();
    const ins = sqlite.prepare(`insert into courier_directory (courier, kind, wilaya_code, payload, fetched_at) values ('yalidine', 'communes', ?, ?, 1)`);
    ins.run(16, JSON.stringify(['x'.repeat(79_000)]));
    expect(() => ins.run(31, JSON.stringify(['\u0628'.repeat(40_500)]))).toThrow(/courier_directory_payload_size/);
  });

  test('sheets_connection holds exactly its singleton row', () => {
    const { sqlite } = freshDb();
    expect(sqlite.prepare('select id, status, generation, failure_count from sheets_connection').all()).toEqual([{ id: 1, status: 'disconnected', generation: 1, failure_count: 0 }]);
    expect(() => sqlite.exec(`insert into sheets_connection (id, updated_at) values (2, 1)`)).toThrow(/sheets_connection_singleton/);
  });
});

// The lead's approval condition: the trigger set runs against a copy of the seeded database.
const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const dataRoot = process.env.HB_SEED_ROOT ?? repoRoot;
const hasData = existsSync(join(dataRoot, 'data', 'catalog', 'validate.mjs')) && existsSync(join(dataRoot, 'data', 'geo', 'communes.json'));

describe.skipIf(!hasData)('migrations 0011 and 0012 on a seeded database', () => {
  test('existing rows are untouched and the triggers work on real data', async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const applyFile = (file: string) => {
      for (const stmt of readFileSync(join(MIGRATIONS_DIR, file), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) sqlite.exec(stmt);
    };
    const files = migrationFiles();
    const firstNew = files.findIndex((f) => f.startsWith('0011_'));
    expect(firstNew).toBeGreaterThan(0);
    files.slice(0, firstNew).forEach(applyFile);

    const { input } = await loadSeedInput(dataRoot);
    const stmts = buildSeedStatements(input);
    sqlite.transaction(() => {
      for (const s of stmts) sqlite.prepare(s.sql).run(...s.params);
    })();
    const commune = sqlite.prepare('select id, wilaya_code as w from communes order by id limit 1').get() as { id: number; w: number };
    sqlite.exec(`insert into admin_users (id, email, name, role) values (9001, 'ship-test@dev.local', 'S', 'owner') on conflict do nothing`);
    sqlite.exec(`insert into customers (id, phone_e164, name) values (9001, '+213560417403', 'Amine') on conflict do nothing`);
    const customer = (sqlite.prepare(`select id from customers where phone_e164 = '+213560417403'`).get() as { id: number }).id;
    sqlite.exec(`insert into orders (id, ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, address, lang, status, subtotal_dzd, fee_dzd, total_dzd, fee_source)
      values (9001, '${refOf(9001)}', 'k9001', ${customer}, 'Amine', '+213560417403', ${commune.w}, ${commune.id}, null, 'ar', 'confirmed', 1000, 400, 1400, 'table')`);

    const tables = (sqlite.prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`).all() as { name: string }[]).map((r) => r.name);
    const digest = () => Object.fromEntries(tables.map((t) => [t, sqlite.prepare(`select count(*) n, coalesce(sum(length(cast(rowid as text))), 0) d from "${t}"`).get()]));
    const orderBefore = sqlite.prepare('select * from orders where id = 9001').get();
    const before = digest();
    expect((before['products'] as { n: number }).n).toBeGreaterThan(0);

    files.slice(firstNew).forEach(applyFile);
    expect(digest()).toEqual(before);
    expect(sqlite.prepare('select * from orders where id = 9001').get()).toEqual(orderBefore);

    sqlite.exec(`insert into courier_accounts (id, courier) values (1, 'yalidine')`);
    sqlite.exec(`insert into shipments (order_id, courier, account_id, state, reference, cod_amount_dzd, fee_dzd, wilaya_code, commune_id, created_by)
      values (9001, 'yalidine', 1, 'uncertain', '${refOf(9001)}', 1400, 400, ${commune.w}, ${commune.id}, 9001)`);
    expect(() => sqlite.exec(`update orders set status = 'cancelled' where id = 9001`)).toThrow(/shipment_in_progress/);
    expect(() => sqlite.exec(`update orders set address = 'x' where id = 9001`)).toThrow(/shipment_in_progress/);
    sqlite.exec(`update shipments set state = 'failed' where order_id = 9001`);
    sqlite.exec(`update orders set address = 'x', status = 'cancelled' where id = 9001`);
  });
});

describe('order changes on real D1', () => {
  let d1: RawD1;
  let db: Db;
  let dispose: () => Promise<void>;
  let next = 100;

  beforeAll(async () => {
    ({ d1, db, dispose } = await freshD1());
    await exec(d1, FIXTURE);
  });
  afterAll(async () => dispose?.());

  async function makeOrder(status: string): Promise<number> {
    const id = next++;
    await d1.prepare(orderSql(id, status, null)).run();
    return id;
  }
  const status = async (id: number) => (await db.select({ s: orders.status, v: orders.version }).from(orders).where(eq(orders.id, id)))[0]!;
  const eventCount = async (id: number) => (await db.select({ n: sql<number>`count(*)` }).from(orderEvents).where(eq(orderEvents.orderId, id)))[0]!.n;
  const SYSTEM = { system: 'courier_sync' } as const;

  describe('system actor', () => {
    const allowed = [
      ['confirmed', 'shipped'],
      ['shipped', 'delivered'],
      ['shipped', 'returned'],
    ] as const;
    test.each(allowed)('may move %s to %s, written as actor_type system with no user', async (from, to) => {
      const id = await makeOrder(from);
      const res = await applyOrderChange(db, { orderId: id, expectedVersion: 0, actor: SYSTEM, hops: [[from, to]] });
      expect(res).toEqual({ ok: true, version: 1, status: to });
      const ev = await db.select().from(orderEvents).where(eq(orderEvents.orderId, id));
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ type: 'status_change', fromStatus: from, toStatus: to, actorType: 'system', actorUserId: null });
    });
    test.each([
      ['new', 'called'],
      ['called', 'confirmed'],
      ['called', 'unreachable'],
      ['called', 'cancelled'],
      ['unreachable', 'called'],
      ['unreachable', 'cancelled'],
      ['confirmed', 'cancelled'],
    ] as const)('may not move %s to %s', async (from, to) => {
      const id = await makeOrder(from);
      expect(await applyOrderChange(db, { orderId: id, expectedVersion: 0, actor: SYSTEM, hops: [[from, to]] })).toEqual({ ok: false, code: 'forbidden' });
      expect(await status(id)).toEqual({ s: from, v: 0 });
    });
    test('may not log a call', async () => {
      const id = await makeOrder('new');
      expect(await applyOrderChange(db, { orderId: id, expectedVersion: 0, actor: SYSTEM, callAttempt: { outcome: 'no_answer' } })).toEqual({ ok: false, code: 'forbidden' });
      expect(await eventCount(id)).toBe(0);
    });
    test('a return through the system actor restores stock exactly once', async () => {
      const id = await makeOrder('shipped');
      await d1
        .prepare(`insert into order_items (order_id, variant_id, product_id, name_fr, name_ar, sku, unit_price_dzd, qty, line_total_dzd, stock_taken) values (?, 100, 10, 'n', 'ن', 'S1', 1000, 2, 2000, 2)`)
        .bind(id)
        .run();
      const stock = async () => (await db.select({ s: variants.stock }).from(variants).where(eq(variants.id, 100)))[0]!.s;
      const before = (await stock())!;
      expect((await applyOrderChange(db, { orderId: id, expectedVersion: 0, actor: SYSTEM, hops: [['shipped', 'returned']] })).ok).toBe(true);
      expect(await stock()).toBe(before + 2);
      expect((await applyOrderChange(db, { orderId: id, expectedVersion: 1, actor: SYSTEM, hops: [['shipped', 'returned']] })).ok).toBe(false);
      expect(await stock()).toBe(before + 2);
    });
  });

  describe('extra guard', () => {
    async function reserve(orderId: number, state: string): Promise<number> {
      const shipmentId = next++;
      await d1.prepare(shipmentSql(shipmentId, orderId, state)).run();
      return shipmentId;
    }
    const snapshot = (id: number, version: number) => ({ id, status: 'confirmed' as const, version, customerId: 1 });
    const trackingOf = (shipmentId: number) => `TRK${shipmentId}`;
    const change = (id: number, shipmentId: number): OrderChange => ({ orderId: id, expectedVersion: 0, actor: SYSTEM, hops: [['confirmed', 'shipped']], patch: { courierTracking: trackingOf(shipmentId), courierName: 'yalidine' } });
    const sendingGuard = (shipmentId: number) => sql`EXISTS (SELECT 1 FROM shipments WHERE id = ${shipmentId} AND state = 'accepted' AND tracking = ${trackingOf(shipmentId)})`;

    function acceptBatch(id: number, shipmentId: number, expected: 'sending' | 'uncertain') {
      const guard = sendingGuard(shipmentId);
      const cas = db
        .update(shipments)
        .set({ state: 'accepted', tracking: trackingOf(shipmentId) })
        .where(and(eq(shipments.id, shipmentId), eq(shipments.state, expected)));
      const close = db
        .update(shipments)
        .set({ appliedAt: 1 })
        .where(and(eq(shipments.id, shipmentId), orderGuard(id, 0), guard));
      const built = buildOrderChange(db, snapshot(id, 0), change(id, shipmentId), [close], { guard });
      if (!built.ok) throw new Error('refused');
      return [cas, ...built.items] as [OrderBatchItem, ...OrderBatchItem[]];
    }

    test('closing the slot then moving the order passes the triggers in one batch', async () => {
      const id = await makeOrder('confirmed');
      const shipmentId = await reserve(id, 'sending');
      await db.batch(acceptBatch(id, shipmentId, 'sending'));
      expect(await status(id)).toEqual({ s: 'shipped', v: 1 });
      expect((await db.select().from(shipments).where(eq(shipments.id, shipmentId)))[0]).toMatchObject({ state: 'accepted', tracking: trackingOf(shipmentId), appliedAt: 1 });
      expect(await eventCount(id)).toBe(1);
    });

    test('a lost compare-and-swap writes nothing: order, events, slot', async () => {
      const id = await makeOrder('confirmed');
      const shipmentId = await reserve(id, 'uncertain');
      await db.update(shipments).set({ state: 'failed' }).where(eq(shipments.id, shipmentId));
      await db.batch(acceptBatch(id, shipmentId, 'uncertain'));
      expect(await status(id)).toEqual({ s: 'confirmed', v: 0 });
      expect(await eventCount(id)).toBe(0);
      expect((await db.select().from(shipments).where(eq(shipments.id, shipmentId)))[0]).toMatchObject({ state: 'failed', tracking: null, appliedAt: null });
    });

    test('a stale version keeps the tracking and moves nothing else', async () => {
      const id = await makeOrder('confirmed');
      const shipmentId = await reserve(id, 'sending');
      const items = acceptBatch(id, shipmentId, 'sending');
      await d1.prepare('update orders set version = version + 1 where id = ?').bind(id).run();
      await db.batch(items);
      expect(await status(id)).toEqual({ s: 'confirmed', v: 1 });
      expect((await db.select().from(shipments).where(eq(shipments.id, shipmentId)))[0]).toMatchObject({ state: 'accepted', tracking: trackingOf(shipmentId), appliedAt: null });
      expect(await eventCount(id)).toBe(0);
    });

    test('the guard also holds back the restock and the customer counter', async () => {
      const id = await makeOrder('shipped');
      await d1
        .prepare(`insert into order_items (order_id, variant_id, product_id, name_fr, name_ar, sku, unit_price_dzd, qty, line_total_dzd, stock_taken) values (?, 100, 10, 'n', 'ن', 'S1', 1000, 1, 1000, 1)`)
        .bind(id)
        .run();
      const stock = async () => (await db.select({ s: variants.stock }).from(variants).where(eq(variants.id, 100)))[0]!.s;
      const counter = async () => (await d1.prepare('select returned_count n from customers where id = 1').first<{ n: number }>())!.n;
      const [s0, c0] = [await stock(), await counter()];
      const res = await applyOrderChange(db, { orderId: id, expectedVersion: 0, actor: SYSTEM, hops: [['shipped', 'returned']] }, [], { guard: sql`0` });
      expect(res).toEqual({ ok: false, code: 'version_conflict' });
      expect(await status(id)).toEqual({ s: 'shipped', v: 0 });
      expect([await stock(), await counter()]).toEqual([s0, c0]);
      expect(await eventCount(id)).toBe(0);
    });

    test('the abort reaches the caller classified, and rolls the whole batch back', async () => {
      const id = await makeOrder('confirmed');
      await reserve(id, 'uncertain');
      await expect(
        applyOrderChange(db, { orderId: id, expectedVersion: 0, actor: { userId: 1, role: 'owner' }, hops: [['confirmed', 'cancelled']] }),
      ).rejects.toSatisfy((e) => classifyConstraintError(e) === 'shipment_in_progress');
      expect(await status(id)).toEqual({ s: 'confirmed', v: 0 });
      expect(await eventCount(id)).toBe(0);
    });
  });

  test('courier account row accepts a sealed key pair only as a pair', async () => {
    await expect(db.insert(courierAccounts).values({ courier: 'guepex', credentialsCipher: 'x' })).rejects.toThrow();
  });
});

describe('secret box', () => {
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const OTHER = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
  const PLAIN = 'SENTINEL-api-token-123';

  test('round trip, and a fresh IV each time', async () => {
    const key = await importSecretBoxKey(KEY);
    const a = await sealSecret(key, PLAIN, 'yalidine');
    const b = await sealSecret(key, PLAIN, 'yalidine');
    expect(a.cipher).not.toBe(b.cipher);
    expect(a.iv).not.toBe(b.iv);
    expect(a.cipher).not.toContain(PLAIN);
    expect(await openSecret(key, a, 'yalidine')).toBe(PLAIN);
  });
  test('a ciphertext moved to another courier does not open', async () => {
    const key = await importSecretBoxKey(KEY);
    await expect(openSecret(key, await sealSecret(key, PLAIN, 'yalidine'), 'guepex')).rejects.toBeInstanceOf(SecretBoxOpenError);
  });
  test('the wrong key and a tampered ciphertext do not open; errors carry no secret', async () => {
    const key = await importSecretBoxKey(KEY);
    const sealed = await sealSecret(key, PLAIN, 'x');
    const bytes = Uint8Array.from(atob(sealed.cipher), (ch) => ch.charCodeAt(0));
    bytes[0]! ^= 1;
    const tampered = { ...sealed, cipher: btoa(String.fromCharCode(...bytes)) };
    const other = await importSecretBoxKey(OTHER);
    for (const attempt of [() => openSecret(other, sealed, 'x'), () => openSecret(key, tampered, 'x'), () => openSecret(key, { cipher: '%%%', iv: sealed.iv }, 'x')]) {
      const err = await attempt().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SecretBoxOpenError);
      expect(String((err as Error).message)).not.toContain(PLAIN);
    }
  });
  test.each([
    ['unset', undefined],
    ['empty', '  '],
    ['not base64', '%%%%'],
    ['wrong length', btoa('short')],
  ])('a key that is %s is refused', async (_n, raw) => {
    await expect(importSecretBoxKey(raw)).rejects.toBeInstanceOf(SecretBoxKeyError);
  });
});
