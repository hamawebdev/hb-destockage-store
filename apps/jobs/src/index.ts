// hb-jobs Worker. Owner: jobs.
// - queue: `order.created` notifications (JOBS-2)
// - scheduled: daily D1 -> R2 backup (JOBS-1), RUM rollup (JOBS-5)
import { ORDER_NOTIFICATIONS_QUEUE, type Env } from './env.ts';
import { handleOrderNotifications } from './notify/consumer.ts';
import { D1DeliveryStore } from './notify/deliveries.ts';
import type { EmailMessageFactory } from './notify/email.ts';
import { buildProviders, emailEnabled } from './notify/providers.ts';
import { log } from './log.ts';

async function emailFactory(env: Env): Promise<EmailMessageFactory | undefined> {
  if (!emailEnabled(env)) return undefined;
  // Loaded only when email is configured; `cloudflare:email` exists only in workerd.
  const { EmailMessage } = await import('cloudflare:email');
  return (from, to, raw) => new EmailMessage(from, to, raw);
}

export default {
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // daily D1 -> R2 export lands in JOBS-1
  },

  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (batch.queue !== ORDER_NOTIFICATIONS_QUEUE) {
      log('queue.unknown', { queue: batch.queue, messages: batch.messages.length });
      batch.retryAll({ delaySeconds: 3600 });
      return;
    }
    const makeEmailMessage = await emailFactory(env);
    const providers = buildProviders(env, makeEmailMessage ? { makeEmailMessage } : {});
    await handleOrderNotifications(batch, {
      providers,
      store: providers.length ? new D1DeliveryStore(env.DB) : null,
      dlq: env.ORDER_NOTIFICATIONS_DLQ,
      lang: env.NOTIFY_LANG === 'ar' ? 'ar' : 'fr',
    });
  },
} satisfies ExportedHandler<Env>;
