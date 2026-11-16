// Dead-letter consumer for hb-order-notifications-dlq (JOBS-6; plan artifacts/JOBS-6/plan.md).
// Makes failed notifications visible to the admin (ADMIN-5 dashboard tile):
// - an `order.created` message (moved here by Cloudflare after max_retries, or forwarded by the
//   consumer after a permanent provider error) marks that order's channels still 'sending' as
//   'dead' (dead_at = now; last_error kept). If nothing could be marked but the order has no row
//   at all, or a configured channel has no 'sent' row (its claim kept failing), a ('*', 'dead')
//   row naming the missing channels is inserted when the order exists (review r1 nit 2).
// - anything else (the consumer's data-free {type:'invalid'} envelope, garbage, or an order id
//   that does not exist) bumps settings['jobs.notify_invalid'] = {count, lastAt}: the admin's
//   producer-bug signal. No payload is stored.
// Idempotent (review r2): redelivering the same message N times leaves exactly the state of one
// delivery, and never bumps the counter for an existing order.
import { backoffSeconds } from './consumer.ts';
import { parseOrderCreated } from './message.ts';
import { log } from '../log.ts';

export const INVALID_COUNTER_KEY = 'jobs.notify_invalid';

export interface DeadLetterDeps {
  db: D1Database;
  /** Channels of the enabled providers (e.g. ['email']); [] = no channel expected. Never a `telegram:<chatId>` one. */
  channels?: readonly string[];
  now?: () => number;
  random?: () => number;
}

export async function handleDeadLetters(batch: MessageBatch<unknown>, deps: DeadLetterDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  for (const msg of batch.messages) {
    try {
      const order = parseOrderCreated(msg.body);
      if (order) {
        const at = now();
        // Unknown order = a producer bug: decided by an explicit lookup, never by changes() = 0
        // (review r2: a redelivery hits ON CONFLICT and changes nothing for a known order too).
        const known = await deps.db.prepare('SELECT 1 AS x FROM orders WHERE id = ?1').bind(order.orderId).first<{ x: number }>();
        if (!known) {
          await bumpInvalid(deps.db, at);
          log('notify.dead_letter_unknown_order', { messageId: msg.id });
          msg.ack();
          continue;
        }
        const marked = await deps.db
          // `telegram:<chatId>` rows belong to the Telegram sweep (TGS-2): it retries them for 72 h and
          // they never become 'dead', whatever happened to the email of the same order.
          .prepare(`UPDATE notification_deliveries SET status = 'dead', dead_at = ?2, lease_until = NULL WHERE order_id = ?1 AND status = 'sending' AND channel NOT LIKE 'telegram:%'`)
          .bind(order.orderId, at)
          .run();
        let changes = marked.meta.changes ?? 0;
        if (changes === 0) {
          // Idempotent: a redelivery of the same dead letter leaves exactly the state of one.
          // Rows that exist are already 'sent' or 'dead' (recorded); a '*' row means the failure
          // is already visible. Only configured channels with NO row at all are missing.
          const existing = (
            await deps.db.prepare(`SELECT channel FROM notification_deliveries WHERE order_id = ?1 AND channel NOT LIKE 'telegram:%'`).bind(order.orderId).all<{ channel: string }>()
          ).results.map((r) => r.channel);
          const missing = (deps.channels ?? []).filter((c) => !existing.includes(c));
          if (!existing.includes('*') && (existing.length === 0 || missing.length > 0)) {
            const label = missing.length > 0 && existing.length > 0 ? `no delivery recorded for ${missing.join(', ')}` : 'no delivery recorded';
            const ins = await deps.db
              .prepare(
                `INSERT INTO notification_deliveries (order_id, channel, status, attempts, dead_at, last_error)
                 VALUES (?1, '*', 'dead', 0, ?2, ?3) ON CONFLICT (order_id, channel) DO NOTHING`,
              )
              .bind(order.orderId, at, label)
              .run();
            changes = ins.meta.changes ?? 0;
          }
        }
        log('notify.dead_letter', { ref: order.ref, markedDead: changes });
      } else {
        await bumpInvalid(deps.db, now());
        log('notify.dead_letter_invalid', { messageId: msg.id });
      }
      msg.ack();
    } catch (err) {
      log('notify.dead_letter_error', { messageId: msg.id, error: err instanceof Error ? err.name : typeof err });
      msg.retry({ delaySeconds: backoffSeconds(msg.attempts, undefined, deps.random) });
    }
  }
}

async function bumpInvalid(db: D1Database, at: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, json_object('count', 1, 'lastAt', ?2), ?2)
       ON CONFLICT (key) DO UPDATE SET
         value = json_set(settings.value, '$.count', coalesce(json_extract(settings.value, '$.count'), 0) + 1, '$.lastAt', ?2),
         updated_at = ?2`,
    )
    .bind(INVALID_COUNTER_KEY, at)
    .run();
}
