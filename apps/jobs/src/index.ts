// hb-jobs Worker. Owner: jobs.
// - queue: `order.created` notifications (JOBS-2)
// - scheduled: daily D1 -> R2 backup (JOBS-1), RUM rollup (JOBS-5)
import { backupHealthCheck, backupJob } from './backup/job.ts';
import { CRON_BACKUP_HEALTH, CRON_DAILY_BACKUP, CRON_RUM_ROLLUP, ORDER_NOTIFICATIONS_DLQ, ORDER_NOTIFICATIONS_QUEUE, type Env } from './env.ts';
import { handleDeadLetters } from './notify/dead.ts';
import { rumJob } from './rum/rollup.ts';
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

/** Alerts go to the same staff channels as order notifications, when configured. */
async function staffAlert(env: Env): Promise<((subject: string, text: string, id: string) => Promise<void>) | undefined> {
  const makeEmailMessage = await emailFactory(env);
  const providers = buildProviders(env, makeEmailMessage ? { makeEmailMessage } : {});
  if (providers.length === 0) return undefined;
  return async (subject, text, id) => {
    await Promise.allSettled(providers.map((p) => p.send({ id, subject, text })));
  };
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    switch (controller.cron) {
      case CRON_DAILY_BACKUP: {
        // Throws on failure so the cron invocation is recorded as failed.
        const alert = await staffAlert(env);
        await backupJob(env, { startedAt: controller.scheduledTime, ...(alert ? { alert } : {}) });
        return;
      }
      case CRON_BACKUP_HEALTH: {
        const alert = await staffAlert(env);
        await backupHealthCheck(env, alert ? { alert } : {});
        return;
      }
      case CRON_RUM_ROLLUP: {
        await rumJob(env.DB, controller.scheduledTime);
        return;
      }
      default:
        log('scheduled.unknown_cron', { cron: controller.cron });
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (batch.queue === ORDER_NOTIFICATIONS_DLQ) {
      await handleDeadLetters(batch, { db: env.DB });
      return;
    }
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
