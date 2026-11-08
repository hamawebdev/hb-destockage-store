// order.created enqueue: after the write, one retry, never fails the order; a failure leaves a note.
import { describe, expect, test, vi } from 'vitest';
import type { OrderCreatedMessage } from '@hb/shared';
import { notify } from '../src/routes/order.ts';

const msg: OrderCreatedMessage = { type: 'order.created', v: 1, orderId: 5, ref: 'HB-7K2Q9', totalDzd: 15200, wilayaCode: 16, lang: 'ar', flags: [], createdAt: 1 };

function env(send: () => Promise<unknown>) {
  return { ORDERS: { send: vi.fn(send) } as unknown as Queue<unknown> };
}

describe('notify', () => {
  test('sends the message once as JSON; no note', async () => {
    const e = env(async () => ({}));
    const store = { noteEnqueueFailed: vi.fn(async () => {}) };
    await notify(e, store, 5, msg);
    expect(e.ORDERS.send).toHaveBeenCalledTimes(1);
    expect(e.ORDERS.send).toHaveBeenCalledWith(msg, { contentType: 'json' });
    expect(store.noteEnqueueFailed).not.toHaveBeenCalled();
  });

  test('one transient failure → retried, no note', async () => {
    let n = 0;
    const e = env(async () => {
      if (n++ === 0) throw new Error('queue busy');
      return {};
    });
    const store = { noteEnqueueFailed: vi.fn(async () => {}) };
    await notify(e, store, 5, msg);
    expect(e.ORDERS.send).toHaveBeenCalledTimes(2);
    expect(store.noteEnqueueFailed).not.toHaveBeenCalled();
  });

  test('queue down → two attempts, then an order_events note; never throws', async () => {
    const e = env(async () => {
      throw new Error('queue down');
    });
    const store = { noteEnqueueFailed: vi.fn(async () => {}) };
    await expect(notify(e, store, 5, msg)).resolves.toBeUndefined();
    expect(e.ORDERS.send).toHaveBeenCalledTimes(2);
    expect(store.noteEnqueueFailed).toHaveBeenCalledWith(5, expect.any(Number));
  });

  test('queue and D1 both down → still resolves (the order is already stored)', async () => {
    const e = env(async () => {
      throw new Error('queue down');
    });
    const store = { noteEnqueueFailed: vi.fn(async () => Promise.reject(new Error('D1 down'))) };
    await expect(notify(e, store, 5, msg)).resolves.toBeUndefined();
  });
});
