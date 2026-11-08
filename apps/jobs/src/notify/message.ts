// `order.created` Queue message: contract in @hb/shared (SHARED-1, messages.ts).
import { parseOrderCreatedMessage, type OrderCreatedMessage } from '../shared.ts';

export type { OrderCreatedMessage };

/**
 * Validates an untrusted queue body; null when malformed (never throws). The validator's reason is
 * deliberately dropped: Valibot issue messages quote the received value, which must not be logged.
 * Unknown keys are stripped, so stray personal data never reaches a provider.
 */
export function parseOrderCreated(body: unknown): OrderCreatedMessage | null {
  const r = parseOrderCreatedMessage(body);
  return r.ok ? r.value : null;
}
