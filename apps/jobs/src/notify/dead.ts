// Dead-letter consumer for hb-order-notifications-dlq (JOBS-6; plan artifacts/JOBS-6/plan.md).
// Makes failed notifications visible to the admin (ADMIN-5 dashboard tile):
// - an `order.created` message (moved here by Cloudflare after max_retries, or forwarded by the
//   consumer after a permanent provider error) marks that order's channels still 'sending' as
//   'dead' (dead_at = now; last_error kept). If the order has no ledger row at all (the ledger was
//   failing), a ('*', 'dead') row is inserted when the order exists.
// - anything else (the consumer's data-free {type:'invalid'} envelope, or garbage) bumps
//   settings['jobs.notify_invalid'] = {count, lastAt}. No payload is stored.
// Idempotent: marking is conditional on status = 'sending'; the counter is a signal only.
import { backoffSeconds } from './consumer.ts';
import { parseOrderCreated } from './message.ts';
import { log } from '../log.ts';

export const INVALID_COUNTER_KEY = 'jobs.notify_invalid';

export interface DeadLetterDeps {
  db: D1Database;
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
        const marked = await deps.db
          .prepare(`UPDATE notification_deliveries SET status = 'dead', dead_at = ?2, lease_until = NULL WHERE order_id = ?1 AND status = 'sending'`)
          .bind(order.orderId, at)
          .run();
        let changes = marked.meta.changes ?? 0;
        if (changes === 0) {
          // No unsent channel: either every channel was sent (nothing to do) or no row exists at all.
          const any = await deps.db.prepare('SELECT count(*) AS n FROM notification_deliveries WHERE order_id = ?1').bind(order.orderId).first<{ n: number }>();
          if ((any?.n ?? 0) === 0) {
            const ins = await deps.db
              .prepare(
                `INSERT INTO notification_deliveries (order_id, channel, status, attempts, dead_at, last_error)
                 SELECT ?1, '*', 'dead', 0, ?2, 'no delivery recorded' WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?1)
                 ON CONFLICT (order_id, channel) DO NOTHING`,
              )
              .bind(order.orderId, at)
              .run();
            changes = ins.meta.changes ?? 0;
            if (changes === 0) await bumpInvalid(deps.db, at); // unknown order: a producer bug
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
