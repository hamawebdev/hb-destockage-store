import { afterEach, describe, expect, test, vi } from 'vitest';
import { backoffSeconds, handleOrderNotifications, type ConsumerDeps } from '../src/notify/consumer.ts';
import { MemoryDeliveryStore } from '../src/notify/deliveries.ts';
import { PermanentError, TransientError, type NotificationProvider, type StaffNotification } from '../src/notify/provider.ts';
import worker from '../src/index.ts';
import type { Env } from '../src/env.ts';
import { captureConsole, fakeBatch, fakeMessage } from './helpers/batch.ts';

const body = { type: 'order.created', v: 1, orderId: 42, ref: 'HB-7K2Q9', totalDzd: 15400, wilayaCode: 16, lang: 'fr', flags: [], createdAt: 1_793_000_000_000 };

class FakeProvider implements NotificationProvider {
  sent: StaffNotification[] = [];
  failures: Error[] = [];
  constructor(readonly channel: string) {}
  async send(n: StaffNotification): Promise<void> {
    const f = this.failures.shift();
    if (f) throw f;
    this.sent.push(n);
  }
}

function deps(providers: NotificationProvider[], extra: Partial<ConsumerDeps> = {}): ConsumerDeps & { store: MemoryDeliveryStore } {
  return { providers, store: new MemoryDeliveryStore(), random: () => 0.5, now: () => 1_000_000, ...extra } as ConsumerDeps & { store: MemoryDeliveryStore };
}

afterEach(() => vi.restoreAllMocks());

describe('backoffSeconds', () => {
  test('exponential from 30 s, capped at 1 h, honors retry-after', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 8, 20].map((a) => backoffSeconds(a, undefined, mid))).toEqual([30, 60, 120, 240, 3600, 3600]);
    expect(backoffSeconds(1, 90, mid)).toBe(90);
    expect(backoffSeconds(1, undefined, () => 0)).toBe(24);
    expect(backoffSeconds(1, undefined, () => 1)).toBe(36);
  });
});

describe('handleOrderNotifications', () => {
  test('no providers: acks everything, sends nothing', async () => {
    const m = fakeMessage(body);
    await handleOrderNotifications(fakeBatch([m]), { providers: [], store: null });
    expect(m.outcome).toBe('ack');
  });

  test('sends once per channel and acks', async () => {
    const tg = new FakeProvider('telegram');
    const em = new FakeProvider('email');
    const d = deps([tg, em]);
    const m = fakeMessage(body);
    await handleOrderNotifications(fakeBatch([m]), d);
    expect(m.outcome).toBe('ack');
    expect(tg.sent).toHaveLength(1);
    expect(em.sent).toHaveLength(1);
    expect(tg.sent[0]!.text).toContain('HB-7K2Q9');
  });

  test('idempotent: redelivery and duplicates in one batch send nothing more', async () => {
    const tg = new FakeProvider('telegram');
    const d = deps([tg]);
    const a = fakeMessage(body);
    const b = fakeMessage({ ...body });
    await handleOrderNotifications(fakeBatch([a, b]), d);
    const c = fakeMessage(body, 2);
    await handleOrderNotifications(fakeBatch([c]), d);
    expect(tg.sent).toHaveLength(1);
    expect([a.outcome, b.outcome, c.outcome]).toEqual(['ack', 'ack', 'ack']);
  });

  test('transient failure on one channel: retry with backoff, then only that channel is resent', async () => {
    const tg = new FakeProvider('telegram');
    const em = new FakeProvider('email');
    em.failures.push(new TransientError('email: send failed'));
    const d = deps([tg, em]);
    const m1 = fakeMessage(body, 1);
    await handleOrderNotifications(fakeBatch([m1]), d);
    expect(m1.outcome).toBe('retry');
    expect(m1.retryDelay).toBe(30);
    expect(tg.sent).toHaveLength(1);
    expect(em.sent).toHaveLength(0);

    const m2 = fakeMessage(body, 2);
    await handleOrderNotifications(fakeBatch([m2]), d);
    expect(m2.outcome).toBe('ack');
    expect(tg.sent).toHaveLength(1);
    expect(em.sent).toHaveLength(1);
  });

  test('retry-after from the provider sets the delay', async () => {
    const tg = new FakeProvider('telegram');
    tg.failures.push(new TransientError('telegram: HTTP 429', 120));
    const m = fakeMessage(body, 1);
    await handleOrderNotifications(fakeBatch([m]), deps([tg]));
    expect(m.retryDelay).toBe(120);
  });

  test('unexpected error is treated as transient', async () => {
    const tg = new FakeProvider('telegram');
    tg.failures.push(new Error('boom'));
    const m = fakeMessage(body, 3);
    await handleOrderNotifications(fakeBatch([m]), deps([tg]));
    expect(m.outcome).toBe('retry');
    expect(m.retryDelay).toBe(120);
  });

  test('permanent failure: not retried, forwarded to the DLQ, acked, last_error recorded', async () => {
    const tg = new FakeProvider('telegram');
    tg.failures.push(new PermanentError('telegram: HTTP 400'));
    const em = new FakeProvider('email');
    const dlq = { send: vi.fn(async () => undefined) } as unknown as Queue<unknown>;
    const d = deps([tg, em], { dlq });
    const m = fakeMessage(body);
    await handleOrderNotifications(fakeBatch([m]), d);
    expect(m.outcome).toBe('ack');
    expect(em.sent).toHaveLength(1);
    expect(dlq.send).toHaveBeenCalledWith(body);
    expect(d.store.rows.get('42:telegram')).toMatchObject({ status: 'sending', leaseUntil: null, lastError: 'telegram: HTTP 400' });
  });

  test('permanent failure with a transient one on another channel: retry; the DLQ only once all is settled', async () => {
    const tg = new FakeProvider('telegram');
    tg.failures.push(new PermanentError('telegram: HTTP 400'));
    const em = new FakeProvider('email');
    em.failures.push(new TransientError('email: send failed'));
    const dlq = { send: vi.fn(async () => undefined) } as unknown as Queue<unknown>;
    const m = fakeMessage(body);
    await handleOrderNotifications(fakeBatch([m]), deps([tg, em], { dlq }));
    expect(m.outcome).toBe('retry');
    expect(dlq.send).not.toHaveBeenCalled();
  });

  test('malformed message: acked and sent to the DLQ, no provider call', async () => {
    const tg = new FakeProvider('telegram');
    const send = vi.spyOn(tg, 'send');
    const dlq = { send: vi.fn(async () => undefined) } as unknown as Queue<unknown>;
    const m = fakeMessage({ type: 'order.created', v: 1, phone: '0560417403' });
    await handleOrderNotifications(fakeBatch([m]), deps([tg], { dlq }));
    expect(m.outcome).toBe('ack');
    expect(send).not.toHaveBeenCalled();
    expect(dlq.send).toHaveBeenCalledOnce();
  });

  test('busy lease held by another consumer: retry, no send', async () => {
    const tg = new FakeProvider('telegram');
    const d = deps([tg]);
    await d.store.claim(42, 'telegram', 1_000_000, 60_000);
    const m = fakeMessage(body);
    await handleOrderNotifications(fakeBatch([m]), d);
    expect(m.outcome).toBe('retry');
    expect(tg.sent).toHaveLength(0);
  });

  test('ledger error: retry the message', async () => {
    const tg = new FakeProvider('telegram');
    const d = deps([tg]);
    vi.spyOn(d.store, 'claim').mockRejectedValue(new Error('D1_ERROR: UNIQUE constraint failed: phone 0560417403'));
    const m = fakeMessage(body);
    const cap = captureConsole();
    try {
      await handleOrderNotifications(fakeBatch([m]), d);
    } finally {
      cap.restore();
    }
    expect(m.outcome).toBe('retry');
    expect(cap.lines.join('\n')).not.toContain('0560417403');
  });

  test('providers enabled but no ledger: retry rather than risk duplicates', async () => {
    const m = fakeMessage(body);
    await handleOrderNotifications(fakeBatch([m]), { providers: [new FakeProvider('telegram')], store: null, random: () => 0.5 });
    expect(m.outcome).toBe('retry');
  });

  test('logs carry the ref and channel, never personal data from the body', async () => {
    const tg = new FakeProvider('telegram');
    tg.failures.push(new PermanentError('telegram: HTTP 400'));
    const cap = captureConsole();
    try {
      await handleOrderNotifications(fakeBatch([fakeMessage({ ...body, name: 'Amina Benali', phone: '+213560417403' })]), deps([tg]));
    } finally {
      cap.restore();
    }
    const out = cap.lines.join('\n');
    expect(out).toContain('HB-7K2Q9');
    expect(out).not.toMatch(/Amina|560417403/);
  });
});

describe('worker.queue', () => {
  const ctx = {} as ExecutionContext;

  test('no secrets: acks the batch and makes no network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const m = fakeMessage(body);
    const env = { DB: {} as D1Database } as Env;
    await worker.queue(fakeBatch([m]), env, ctx);
    expect(m.outcome).toBe('ack');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('unknown queue: retried, not dropped', async () => {
    const m = fakeMessage(body);
    await worker.queue(fakeBatch([m], 'something-else'), { DB: {} as D1Database } as Env, ctx);
    expect(m.outcome).toBe('retry');
  });
});
