import { expect, test } from 'vitest';
import { type OrderCreatedMessage, parseOrderCreatedMessage } from '../src/messages.ts';

const msg: OrderCreatedMessage = {
  type: 'order.created',
  v: 1,
  orderId: 42,
  ref: 'HB-7K2Q9',
  totalDzd: 15200,
  wilayaCode: 16,
  lang: 'ar',
  flags: ['duplicate', 'turnstile_missing'],
  createdAt: 1_700_000_000_000,
};

test('valid message round-trips, unknown keys stripped, future flags tolerated', () => {
  expect(parseOrderCreatedMessage({ ...msg, extra: 1 })).toEqual({ ok: true, value: msg });
  expect(parseOrderCreatedMessage({ ...msg, flags: ['some_future_flag'] }).ok).toBe(true);
});

test.each([
  [{ type: 'order.updated' }],
  [{ v: 2 }],
  [{ orderId: 0 }],
  [{ ref: 'X-1' }],
  [{ totalDzd: 10.5 }],
  [{ wilayaCode: 70 }],
  [{ lang: 'en' }],
  [{ flags: 'duplicate' }],
  [{ createdAt: -1 }],
])('rejects %j with a reason', (patch) => {
  const r = parseOrderCreatedMessage({ ...msg, ...patch });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(new RegExp(`^${Object.keys(patch)[0]}: `));
});

test('non-object', () => {
  expect(parseOrderCreatedMessage(null).ok).toBe(false);
});
