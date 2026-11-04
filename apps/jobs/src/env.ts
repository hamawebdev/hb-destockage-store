import type { SendEmailBinding } from './notify/email.ts';

export interface Env {
  /** Shared D1 (owner of schema: `db`). */
  DB: D1Database;

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
