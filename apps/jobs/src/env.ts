import type { SendEmailBinding } from './notify/email.ts';

export interface Env {
  /** `production` in wrangler.jsonc; `.dev.vars` sets `development` locally. Outbound HTTP is held to loopback unless exactly `production`. */
  ENV?: string;
  /** Shared D1 (owner of schema: `db`). */
  DB: D1Database;
  /** Private backup bucket (JOBS-1). Never public, never the media bucket. */
  BACKUPS: R2Bucket;

  // Order notifications (JOBS-2). All optional: a channel is enabled only when all its values are set.
  /** Secret. */
  TELEGRAM_BOT_TOKEN?: string;
  /** Secret. */
  TELEGRAM_CHAT_ID?: string;
  /** `send_email` binding (Cloudflare Email Routing, verified destination). */
  NOTIFY_EMAIL?: SendEmailBinding;
  NOTIFY_EMAIL_FROM?: string;
  NOTIFY_EMAIL_TO?: string;
  /** Staff message language: 'fr' (default) or 'ar'. */
  NOTIFY_LANG?: string;
  /** Producer binding to the notifications DLQ, for permanent failures and malformed messages. */
  ORDER_NOTIFICATIONS_DLQ?: Queue<unknown>;
}

export const ORDER_NOTIFICATIONS_QUEUE = 'hb-order-notifications';
export const ORDER_NOTIFICATIONS_DLQ = 'hb-order-notifications-dlq';
export const CRON_DAILY_BACKUP = '0 2 * * *';
/** 09:00 UTC = 10:00 Algiers: alert if the last good backup is older than 26 h. */
export const CRON_BACKUP_HEALTH = '0 9 * * *';
/** 02:30 UTC = 03:30 Algiers: RUM rollup + 90-day purge (JOBS-5). */
export const CRON_RUM_ROLLUP = '30 2 * * *';
/** Courier status sync and Sheets sync. Each runs on its own; neither can block the other. */
export const CRON_EVERY_MINUTE = '* * * * *';
