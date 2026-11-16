import type { DeliveryStore } from './deliveries.ts';
import { formatOrderCreated, type StaffLang } from './format.ts';
import { parseOrderCreated } from './message.ts';
import { PermanentError, TransientError, type NotificationProvider } from './provider.ts';
import { log } from '../log.ts';

export interface ConsumerDeps {
  /** Enabled providers only (email). Empty list and no `telegram` = messages are acked untouched. */
  providers: readonly NotificationProvider[];
  /**
   * Telegram (TGS-2): sends the order to the confirmed chats right away. It never throws and never
   * affects ack/retry/DLQ: what it could not send is left to the per-minute sweep.
   */
  telegram?: ((orderId: number) => Promise<void>) | undefined;
  /** Required when at least one provider is enabled. */
  store: DeliveryStore | null;
  /**
   * Explicit DLQ producer (optional). Receives the parsed order for permanent failures and a
   * data-free `{type:'invalid', messageId, attempts, at}` envelope for malformed messages.
   */
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

  if (deps.providers.length === 0 && !deps.telegram) {
    // Nothing configured: nothing to send, no network calls. The order is already durable in D1.
    log('notify.disabled', { messages: batch.messages.length });
    batch.ackAll();
    return;
  }

  for (const msg of batch.messages) {
    const order = parseOrderCreated(msg.body);
    if (!order) {
      log('notify.invalid_message', { messageId: msg.id });
      // The raw body is not forwarded: it failed validation, so it may hold anything (review r1).
      await sendToDlq(deps, { type: 'invalid', messageId: msg.id, attempts: msg.attempts, at: now() });
      msg.ack();
      continue;
    }
    if (deps.telegram) {
      try {
        await deps.telegram(order.orderId);
      } catch (err) {
        // The notifier does not throw; this is a guard so Telegram can never fail the message.
        log('notify.telegram_error', { ref: order.ref, error: errorClass(err) });
      }
    }
    if (deps.providers.length === 0) {
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
        if (claim === 'sent' || claim === 'dead') continue;
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
    // The parsed order (unknown keys stripped), not the raw body.
    if (permanentFailure) await sendToDlq(deps, order);
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
