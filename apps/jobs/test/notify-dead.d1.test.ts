// JOBS-6: dead-letter consumer on a real local D1 with the @hb/db migration chain (DB-7: 'dead'
// status + dead_at).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { handleDeadLetters, INVALID_COUNTER_KEY } from '../src/notify/dead.ts';
import { D1DeliveryStore } from '../src/notify/deliveries.ts';
import { captureConsole, fakeBatch, fakeMessage, type FakeMessage } from './helpers/batch.ts';
import { localPlatform, type LocalPlatform } from './helpers/platform.ts';
import { applyMigrations, insertOrders } from './helpers/schema.ts';

let p: LocalPlatform<{ DB: D1Database }>;
const NOW = 1_800_000_000_000;
const body = (orderId: number) => ({ type: 'order.created', v: 1, orderId, ref: `HB-T${String(orderId).padStart(4, '0')}`, totalDzd: 15400, wilayaCode: 16, lang: 'fr', flags: [], createdAt: 1 });
const rows = (orderId: number) =>
  p.env.DB.prepare('SELECT channel, status, dead_at, last_error FROM notification_deliveries WHERE order_id = ? ORDER BY channel').bind(orderId).all().then((r) => r.results);
const DLQ = 'hb-order-notifications-dlq';

beforeAll(async () => {
  p = await localPlatform();
  await applyMigrations(p.env.DB);
  await insertOrders(p.env.DB, [1, 2, 3, 4]);
}, 60_000);
afterAll(async () => p?.dispose());
beforeEach(async () => {
  await p.env.DB.batch([p.env.DB.prepare('DELETE FROM notification_deliveries'), p.env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(INVALID_COUNTER_KEY)]);
});

describe('handleDeadLetters', { timeout: 60_000 }, () => {
  test('marks only the unsent channels dead, status and dead_at together; sent rows untouched', async () => {
    const store = new D1DeliveryStore(p.env.DB);
    await store.claim(1, 'telegram', 1, 60_000);
    await store.markSent(1, 'telegram', 2);
    await store.claim(1, 'email', 3, 60_000);
    await store.release(1, 'email', 'email: send failed');
    const m = fakeMessage(body(1));
    await handleDeadLetters(fakeBatch([m], DLQ), { db: p.env.DB, now: () => NOW });
    expect(m.outcome).toBe('ack');
    expect(await rows(1)).toEqual([
      { channel: 'email', status: 'dead', dead_at: NOW, last_error: 'email: send failed' },
      { channel: 'telegram', status: 'sent', dead_at: null, last_error: null },
    ]);
  });

  test('no ledger row at all → a (\'*\', dead) row, so the order still shows up in the admin', async () => {
    await handleDeadLetters(fakeBatch([fakeMessage(body(2))], DLQ), { db: p.env.DB, now: () => NOW });
    expect(await rows(2)).toEqual([{ channel: '*', status: 'dead', dead_at: NOW, last_error: 'no delivery recorded' }]);
  });

  test('everything already sent → nothing marked', async () => {
    const store = new D1DeliveryStore(p.env.DB);
    await store.claim(3, 'telegram', 1, 60_000);
    await store.markSent(3, 'telegram', 2);
    await handleDeadLetters(fakeBatch([fakeMessage(body(3))], DLQ), { db: p.env.DB, now: () => NOW });
    expect(await rows(3)).toEqual([{ channel: 'telegram', status: 'sent', dead_at: null, last_error: null }]);
  });

  test('redelivery is idempotent (dead_at keeps the first time)', async () => {
    await handleDeadLetters(fakeBatch([fakeMessage(body(4))], DLQ), { db: p.env.DB, now: () => NOW });
    await handleDeadLetters(fakeBatch([fakeMessage(body(4), 2)], DLQ), { db: p.env.DB, now: () => NOW + 5 });
    expect(await rows(4)).toEqual([{ channel: '*', status: 'dead', dead_at: NOW, last_error: 'no delivery recorded' }]);
  });

  test('invalid envelope, garbage and unknown orders bump settings[jobs.notify_invalid]; nothing else stored', async () => {
    const msgs: FakeMessage<unknown>[] = [fakeMessage<unknown>({ type: 'invalid', messageId: 'x', attempts: 1, at: 1 }), fakeMessage<unknown>('garbage'), fakeMessage<unknown>(body(99999))];
    await handleDeadLetters(fakeBatch(msgs, DLQ), { db: p.env.DB, now: () => NOW });
    expect(msgs.map((m) => m.outcome)).toEqual(['ack', 'ack', 'ack']);
    const v = await p.env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(INVALID_COUNTER_KEY).first<{ value: string }>();
    expect(JSON.parse(v!.value)).toEqual({ count: 3, lastAt: NOW });
    expect(await rows(99999)).toEqual([]);
  });

  test('D1 failure → retry with backoff; logs hold no personal data', async () => {
    const broken = { prepare: () => ({ bind: () => ({ run: async () => Promise.reject(new Error('D1_ERROR: +213560417403')) }) }) } as unknown as D1Database;
    const m = fakeMessage({ ...body(1), phone: '+213560417403' });
    const cap = captureConsole();
    try {
      await handleDeadLetters(fakeBatch([m], DLQ), { db: broken, now: () => NOW, random: () => 0.5 });
    } finally {
      cap.restore();
    }
    expect(m.outcome).toBe('retry');
    expect(m.retryDelay).toBe(30);
    expect(cap.lines.join('\n')).not.toContain('560417403');
  });

  test('the admin queries (ADMIN-5 contract) return the dead deliveries', async () => {
    await handleDeadLetters(fakeBatch([fakeMessage(body(2)), fakeMessage(body(4))], DLQ), { db: p.env.DB, now: () => NOW });
    const tile = await p.env.DB.prepare(`SELECT count(DISTINCT order_id) AS failed_orders, max(dead_at) AS last_at FROM notification_deliveries WHERE status = 'dead'`).first();
    expect(tile).toEqual({ failed_orders: 2, last_at: NOW });
    const list = await p.env.DB.prepare(
      `SELECT o.ref, d.channel, d.last_error, d.dead_at FROM notification_deliveries d JOIN orders o ON o.id = d.order_id WHERE d.status = 'dead' ORDER BY d.dead_at DESC LIMIT 50`,
    ).all();
    expect(list.results.map((r) => r['ref']).sort()).toEqual(['HB-T0002', 'HB-T0004']);
  });
});

describe('dead is terminal for the main consumer', { timeout: 60_000 }, () => {
  test('a redelivered order.created for a dead channel is acked without sending', async () => {
    const { handleOrderNotifications } = await import('../src/notify/consumer.ts');
    await handleDeadLetters(fakeBatch([fakeMessage(body(2))], DLQ), { db: p.env.DB, now: () => NOW });
    let sent = 0;
    const provider = { channel: '*', send: async () => void sent++ };
    const m = fakeMessage(body(2), 3);
    await handleOrderNotifications(fakeBatch([m]), { providers: [provider], store: new D1DeliveryStore(p.env.DB), random: () => 0.5 });
    expect(m.outcome).toBe('ack');
    expect(sent).toBe(0);
  });

  test('worker.queue routes the DLQ to the dead-letter handler', async () => {
    const { default: worker } = await import('../src/index.ts');
    const m = fakeMessage(body(3));
    await worker.queue(fakeBatch([m], DLQ), { DB: p.env.DB } as never, {} as ExecutionContext);
    expect(m.outcome).toBe('ack');
    expect(await rows(3)).toEqual([{ channel: '*', status: 'dead', dead_at: expect.any(Number), last_error: 'no delivery recorded' }]);
  });
});

describe('review r1 nits', { timeout: 60_000 }, () => {
  test('markSent after a dead mark: status sent and dead_at cleared together', async () => {
    const store = new D1DeliveryStore(p.env.DB);
    await store.claim(1, 'telegram', 1, 60_000);
    await handleDeadLetters(fakeBatch([fakeMessage(body(1))], DLQ), { db: p.env.DB, now: () => NOW });
    expect(await rows(1)).toEqual([{ channel: 'telegram', status: 'dead', dead_at: NOW, last_error: null }]);
    await store.markSent(1, 'telegram', NOW + 1); // the slow send did complete
    expect(await rows(1)).toEqual([{ channel: 'telegram', status: 'sent', dead_at: null, last_error: null }]);
  });

  test('partial ledger: telegram sent, email never recorded → a visible (\'*\', dead) row naming email', async () => {
    const store = new D1DeliveryStore(p.env.DB);
    await store.claim(3, 'telegram', 1, 60_000);
    await store.markSent(3, 'telegram', 2);
    await handleDeadLetters(fakeBatch([fakeMessage(body(3))], DLQ), { db: p.env.DB, now: () => NOW, channels: ['telegram', 'email'] });
    expect(await rows(3)).toEqual([
      { channel: '*', status: 'dead', dead_at: NOW, last_error: 'no delivery recorded for email' },
      { channel: 'telegram', status: 'sent', dead_at: null, last_error: null },
    ]);
  });

  test('every configured channel sent → still nothing marked', async () => {
    const store = new D1DeliveryStore(p.env.DB);
    for (const c of ['telegram', 'email']) {
      await store.claim(4, c, 1, 60_000);
      await store.markSent(4, c, 2);
    }
    await handleDeadLetters(fakeBatch([fakeMessage(body(4))], DLQ), { db: p.env.DB, now: () => NOW, channels: ['telegram', 'email'] });
    expect((await rows(4)).map((r) => r['status'])).toEqual(['sent', 'sent']);
  });
});
