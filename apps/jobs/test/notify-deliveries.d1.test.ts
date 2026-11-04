// D1DeliveryStore against a real local D1 (workerd via getPlatformProxy) with DB-1's migrations.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { D1DeliveryStore } from '../src/notify/deliveries.ts';
import { handleOrderNotifications } from '../src/notify/consumer.ts';
import type { NotificationProvider, StaffNotification } from '../src/notify/provider.ts';
import { fakeBatch, fakeMessage } from './helpers/batch.ts';
import { localPlatform, type LocalPlatform } from './helpers/platform.ts';
import { applyMigrations, insertOrders } from './helpers/schema.ts';

let p: LocalPlatform<{ DB: D1Database }>;
let store: D1DeliveryStore;

beforeAll(async () => {
  p = await localPlatform();
  await applyMigrations(p.env.DB);
  await insertOrders(p.env.DB, [1, 2, 3, 5, 99]);
  store = new D1DeliveryStore(p.env.DB);
}, 60_000);
afterAll(async () => p?.dispose());

const row = (orderId: number, channel = 'telegram') =>
  p.env.DB.prepare('SELECT status, attempts, lease_until, last_error FROM notification_deliveries WHERE order_id = ? AND channel = ?')
    .bind(orderId, channel)
    .first();

describe('D1DeliveryStore (DB-1 notification_deliveries)', () => {
  test('claim → sent → skipped afterwards; channels independent', async () => {
    expect(await store.claim(1, 'telegram', 1000, 60_000)).toBe('claimed');
    expect(await store.claim(1, 'telegram', 1001, 60_000)).toBe('busy');
    await store.markSent(1, 'telegram', 1002);
    expect(await store.claim(1, 'telegram', 999_999, 60_000)).toBe('sent');
    expect(await store.claim(1, 'email', 1003, 60_000)).toBe('claimed');
    expect(await row(1)).toMatchObject({ status: 'sent', lease_until: null, last_error: null });
  });

  test('release records last_error and lets the next attempt claim; attempts counted', async () => {
    expect(await store.claim(2, 'telegram', 1000, 60_000)).toBe('claimed');
    await store.release(2, 'telegram', 'telegram: HTTP 502');
    expect(await row(2)).toEqual({ status: 'sending', attempts: 1, lease_until: null, last_error: 'telegram: HTTP 502' });
    expect(await store.claim(2, 'telegram', 1002, 60_000)).toBe('claimed');
    expect(await row(2)).toMatchObject({ attempts: 2, lease_until: 61_002 });
  });

  test('expired lease (crashed consumer) is taken over', async () => {
    expect(await store.claim(3, 'telegram', 1000, 60_000)).toBe('claimed');
    expect(await store.claim(3, 'telegram', 60_999, 60_000)).toBe('busy');
    expect(await store.claim(3, 'telegram', 61_000, 60_000)).toBe('claimed');
  });

  test('concurrent claims: exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.claim(5, 'telegram', 5000, 60_000)));
    expect(results.filter((r) => r === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r === 'busy')).toHaveLength(7);
  });

  test('a message for an order that does not exist fails the FK: retried, never sent', async () => {
    const sent: StaffNotification[] = [];
    const provider: NotificationProvider = { channel: 'telegram', send: async (n) => void sent.push(n) };
    const m = fakeMessage({ type: 'order.created', v: 1, orderId: 12345, ref: 'HB-ZZZZ8', totalDzd: 1, wilayaCode: 1, lang: 'fr', flags: [], createdAt: 1 });
    await handleOrderNotifications(fakeBatch([m]), { providers: [provider], store, random: () => 0.5 });
    expect(m.outcome).toBe('retry');
    expect(sent).toHaveLength(0);
  });

  test('end to end with the consumer: concurrent duplicate deliveries send once', async () => {
    const sent: StaffNotification[] = [];
    const provider: NotificationProvider = { channel: 'telegram', send: async (n) => void sent.push(n) };
    const body = { type: 'order.created', v: 1, orderId: 99, ref: 'HB-ZZZZ9', totalDzd: 100, wilayaCode: 1, lang: 'fr', flags: [], createdAt: 1 };
    const msgs = [fakeMessage(body), fakeMessage(body), fakeMessage(body)];
    await Promise.all(msgs.map((m) => handleOrderNotifications(fakeBatch([m]), { providers: [provider], store, random: () => 0.5 })));
    expect(sent).toHaveLength(1);
    // Each duplicate either saw 'sent' (ack) or a live lease (retry); a retried one acks on redelivery.
    expect(msgs.every((m) => m.outcome === 'ack' || m.outcome === 'retry')).toBe(true);
    const redelivered = [...msgs.filter((m) => m.outcome === 'retry').map(() => fakeMessage(body, 2)), fakeMessage(body, 3)];
    await handleOrderNotifications(fakeBatch(redelivered), { providers: [provider], store, random: () => 0.5 });
    expect(redelivered.every((m) => m.outcome === 'ack')).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
