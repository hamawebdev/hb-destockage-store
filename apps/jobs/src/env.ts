import type { SendEmailBinding } from './notify/email.ts';

export interface Env {
  /** `production` in wrangler.jsonc; `.dev.vars` sets `development` locally. Outbound HTTP is held to loopback unless exactly `production`. */
  ENV?: string;
  /** Shared D1 (owner of schema: `db`). */
  DB: D1Database;
  /** Private backup bucket (JOBS-1). Never public, never the media bucket. */
  BACKUPS: R2Bucket;

  // Order notifications (JOBS-2). Email is enabled only when all its values are set.
  // Telegram (TGS-2, D-022) has no secret here: the bot token, the chats and the ticked details come
  // from the admin (settings rows); the token is opened with COURIER_KEYS_KEY.
  /** Non-production only: loopback Bot API stand-in or the local live proxy. Ignored in production. */
  TELEGRAM_STANDIN_URL?: string;
  /** `send_email` binding (Cloudflare Email Routing, verified destination). */
  NOTIFY_EMAIL?: SendEmailBinding;
  NOTIFY_EMAIL_FROM?: string;
  NOTIFY_EMAIL_TO?: string;
  /** Staff email language: 'fr' (default) or 'ar'. (The Telegram language is chosen in the admin.) */
  NOTIFY_LANG?: string;
  /** Producer binding to the notifications DLQ, for permanent failures and malformed messages. */
  ORDER_NOTIFICATIONS_DLQ?: Queue<unknown>;

  // Courier status sync (SHIP-5). Unset or invalid key = no courier is called; D1-only steps still run.
  /** 32 random bytes, base64 (secret), the same value as the admin's. Opens the sealed courier keys, the Google refresh token and the Telegram bot token. */
  COURIER_KEYS_KEY?: string;
  /** Local courier stand-in. Honoured only when ENV is not `production`. */
  COURIER_STANDIN_URL?: string;

  // Google Sheets sync (SHEET-2). Off until these and COURIER_KEYS_KEY are set; `config_missing` otherwise.
  /** Secret. */
  GOOGLE_CLIENT_ID?: string;
  /** Secret. */
  GOOGLE_CLIENT_SECRET?: string;
  /** Non-production only: loopback stand-in base URL. Ignored in production. */
  GOOGLE_STANDIN_URL?: string;
}

export const ORDER_NOTIFICATIONS_QUEUE = 'hb-order-notifications';
export const ORDER_NOTIFICATIONS_DLQ = 'hb-order-notifications-dlq';
export const CRON_DAILY_BACKUP = '0 2 * * *';
/** 09:00 UTC = 10:00 Algiers: alert if the last good backup is older than 26 h. */
export const CRON_BACKUP_HEALTH = '0 9 * * *';
/** 02:30 UTC = 03:30 Algiers: RUM rollup + 90-day purge (JOBS-5). */
export const CRON_RUM_ROLLUP = '30 2 * * *';
/** Courier status sync, Sheets sync and the Telegram sweep. Each runs on its own; none can block another. */
export const CRON_EVERY_MINUTE = '* * * * *';
