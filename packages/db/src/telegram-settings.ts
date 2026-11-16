// Telegram settings rows in D1 (TGS-1, D-022). The admin is the only source of the bot token, the
// chats and the ticks; the jobs Worker reads them and writes only its own status row.
//
//   telegram             → TelegramSettings (@hb/shared/telegram), written only by the admin
//   telegramBotTokenEnc  → "<iv>.<cipher>" (both base64), AES-GCM under COURIER_KEYS_KEY
//   jobs.telegram_status → { lastOkAt, lastErrorCode, lastErrorAt }, written only by jobs
//
// All three are internal (INTERNAL_SETTINGS_KEYS): never in the snapshot, never in a deploy export.
// Nothing here logs, and no error carries the token, key material or the stored value.
import { openSecret, sealSecret, SecretBoxOpenError, type SecretBoxKey } from './secret-box.ts';

export const TELEGRAM_SETTING_KEYS = {
  settings: 'telegram',
  tokenEnc: 'telegramBotTokenEnc',
  status: 'jobs.telegram_status',
} as const;

const TOKEN_AAD = 'telegram.bot_token';

/** The value to store under `telegramBotTokenEnc` (a string; the caller stores it as JSON). */
export async function sealTelegramToken(key: SecretBoxKey, token: string): Promise<string> {
  const sealed = await sealSecret(key, token, TOKEN_AAD);
  return `${sealed.iv}.${sealed.cipher}`;
}

/** Throws `SecretBoxOpenError` when the stored value is damaged or was sealed under another key. */
export async function openTelegramToken(key: SecretBoxKey, stored: unknown): Promise<string> {
  if (typeof stored !== 'string') throw new SecretBoxOpenError('secret could not be opened');
  const dot = stored.indexOf('.');
  if (dot <= 0) throw new SecretBoxOpenError('secret could not be opened');
  return openSecret(key, { iv: stored.slice(0, dot), cipher: stored.slice(dot + 1) }, TOKEN_AAD);
}
