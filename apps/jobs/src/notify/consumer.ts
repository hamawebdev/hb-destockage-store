import type { DeliveryStore } from './deliveries.ts';
import { formatOrderCreated, type StaffLang } from './format.ts';
import { parseOrderCreated } from './message.ts';
import { PermanentError, TransientError, type NotificationProvider } from './provider.ts';
import { log } from '../log.ts';

export interface ConsumerDeps {
  /** Enabled providers only. Empty list = notifications disabled, messages are acked untouched. */
  providers: readonly NotificationProvider[];
  /** Required when at least one provider is enabled. */
  store: DeliveryStore | null;
  /** Explicit DLQ producer for permanently failed or malformed messages (optional). */
  dlq?: Queue<unknown> | undefined;
  lang?: StaffLang;
  now?: () => number;
  random?: () => number;
  /** Lease while a consumer is sending one notification. */
  leaseMs?: number;
}

const BASE_DELAY_S = 30;
const MAX_DELAY_S = 3600;

/** Exponential backoff with ±20% jitter: 30 s, 60 s, 120 s … capped at 1 h. Honors provider retry-after. */
export function backoffSeconds(attempts: number, retryAfter: number | undefined, random: () => number = Math.random): number {
  const exp = Math.min(MAX_DELAY_S, BASE_DELAY_S * 2 ** Math.max(0, attempts - 1));
  const jittered = Math.round(exp * (0.8 + 0.4 * random()));
  return Math.min(MAX_DELAY_S, Math.max(jittered, Math.ceil(retryAfter ?? 0), 1));
}

export async function handleOrderNotifications(batch: MessageBatch<unknown>, deps: ConsumerDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const leaseMs = deps.leaseMs ?? 60_000;

  if (deps.providers.length === 0) {
    // No secrets set: nothing to send, no network calls. The order is already durable in D1.
    log('notify.disabled', { messages: batch.messages.length });
    batch.ackAll();
    return;
  }

  for (const msg of batch.messages) {
    const order = parseOrderCreated(msg.body);
    if (!order) {
      log('notify.invalid_message', { messageId: msg.id });
      await sendToDlq(deps, msg.body);
      msg.ack();
      continue;
    }
    if (!deps.store) {
      // Without the ledger we cannot be idempotent: keep the message until configuration is fixed.
      log('notify.no_store', { messageId: msg.id });
      msg.retry({ delaySeconds: backoffSeconds(msg.attempts, undefined, deps.random) });
      continue;
    }

    const notification = formatOrderCreated(order, deps.lang ?? 'fr');
    let retryAfter: number | undefined;
    let pending = false;
    let permanentFailure = false;

    for (const provider of deps.providers) {
      const channel = provider.channel;
      try {
        const claim = await deps.store.claim(order.orderId, channel, now(), leaseMs);
        if (claim === 'sent') continue;
        if (claim === 'busy') {
          pending = true;
          continue;
        }
        try {
          await provider.send(notification);
        } catch (err) {
          // Provider errors carry fixed, data-free messages; anything else is reduced to its class.
          const label = err instanceof PermanentError || err instanceof TransientError ? err.message : `${channel}: ${errorClass(err)}`;
          await deps.store.release(order.orderId, channel, label);
          if (err instanceof PermanentError) {
            // Retrying will not help: ack (after the other channels) and forward to the DLQ.
            permanentFailure = true;
            log('notify.permanent_failure', { ref: order.ref, channel, error: label });
            continue;
          }
          pending = true;
          if (err instanceof TransientError && err.retryAfterSeconds !== undefined) {
            retryAfter = Math.max(retryAfter ?? 0, err.retryAfterSeconds);
          }
          log('notify.transient_failure', { ref: order.ref, channel, attempt: msg.attempts, error: label });
          continue;
        }
        await deps.store.markSent(order.orderId, channel, now());
        log('notify.sent', { ref: order.ref, channel });
      } catch (err) {
        // Ledger (D1) failure: retry the whole message later; already-sent channels are skipped then.
        pending = true;
        log('notify.store_error', { ref: order.ref, channel, error: errorClass(err) });
      }
    }

    if (pending) {
      msg.retry({ delaySeconds: backoffSeconds(msg.attempts, retryAfter, deps.random) });
      continue;
    }
    if (permanentFailure) await sendToDlq(deps, msg.body);
    msg.ack();
  }
}

async function sendToDlq(deps: ConsumerDeps, body: unknown): Promise<void> {
  if (!deps.dlq) return;
  try {
    await deps.dlq.send(body);
  } catch (err) {
    log('notify.dlq_error', { error: errorClass(err) });
  }
}

/** Error class name only: provider/D1 messages may quote values. */
function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
