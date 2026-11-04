/**
 * Queue message contracts. `apps/web` produces `order.created` after the order row is committed;
 * `apps/jobs` consumes it (Telegram/email notifications). Messages carry the minimum: no name,
 * phone, commune or items — staff open the admin for details.
 *
 * Consumers validate with `parseOrderCreatedMessage`; a malformed message is acked and logged,
 * never retried. Bump `v` for an incompatible change and keep accepting the old version until
 * the queue has drained.
 */

import * as v from 'valibot';
import { WILAYA_CODE_MAX, WILAYA_CODE_MIN } from './ids.ts';
import { LANGS } from './lang.ts';
import { ORDER_REF_RE } from './order-schema.ts';

export const OrderCreatedMessageSchema = /* @__PURE__ */ v.object({
  type: v.literal('order.created'),
  v: v.literal(1),
  /** `orders.id`; the consumer's dedupe key (queues deliver at least once). */
  orderId: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  ref: v.pipe(v.string(), v.regex(ORDER_REF_RE)),
  totalDzd: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  wilayaCode: v.pipe(v.number(), v.integer(), v.minValue(WILAYA_CODE_MIN), v.maxValue(WILAYA_CODE_MAX)),
  lang: v.picklist(LANGS),
  /**
   * `OrderFlag` values when produced; validated as plain strings so a consumer older than the
   * producer still delivers the notification (unknown flags are shown raw).
   */
  flags: v.array(v.string()),
  /** Epoch ms. */
  createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export type OrderCreatedMessage = v.InferOutput<typeof OrderCreatedMessageSchema>;

export function parseOrderCreatedMessage(
  body: unknown,
): { readonly ok: true; readonly value: OrderCreatedMessage } | { readonly ok: false; readonly reason: string } {
  const r = v.safeParse(OrderCreatedMessageSchema, body);
  if (r.success) return { ok: true, value: r.output };
  const first = r.issues[0];
  const path = first.path?.map((p) => String(p.key)).join('.') ?? '';
  return { ok: false, reason: path === '' ? first.message : `${path}: ${first.message}` };
}
