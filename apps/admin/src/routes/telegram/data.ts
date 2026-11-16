// Telegram settings state (TGS-4): reads, the one-batch write, and the outbound client options.
// Shared by the /telegram page and the Telegram card on /settings.
//
// The bot token is opened only to call Telegram (chat discovery, test message). It is never put in
// a view model, an audit row, a redirect or a log; errors from the client carry a code only.
import { inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Context } from 'hono';
import { settings } from '@hb/db';
import { importSecretBoxKey, type SecretBoxKey } from '@hb/db/secret-box';
import { openTelegramToken, TELEGRAM_SETTING_KEYS } from '@hb/db/telegram-settings';
import { confirmedTelegramChats, parseTelegramSettings, parseTelegramStatus, type TelegramSettings, type TelegramStatus } from '@hb/shared/telegram';
import { resolveTelegramBase, type TelegramClientOptions } from '@hb/shared/telegram-api';
import { audit, type AuditEntry } from '../../audit/audit.ts';
import type { AppEnv, Env } from '../../env.ts';

type Ctx = Context<AppEnv>;

export const K = TELEGRAM_SETTING_KEYS;
/** Outbound calls from a page request: shorter than the jobs Worker's 10 s. */
export const ADMIN_TIMEOUT_MS = 8_000;

// Test seam: the admin tests replace the outbound fetch for this module only (never globalThis).
let fetchOverride: typeof fetch | undefined;
export function setTelegramFetchForTests(f: typeof fetch | undefined): void {
  fetchOverride = f;
}

export interface TelegramState {
  settings: TelegramSettings;
  status: TelegramStatus;
  /** A sealed token row exists (it may still be unreadable with the current key). */
  hasToken: boolean;
  /** Raw stored value of the sealed token; server side only. */
  tokenEnc: unknown;
  /** The `telegram` row exists (first write is a `set`, later ones a `change`). */
  exists: boolean;
}

export async function readTelegramState(c: Ctx): Promise<TelegramState> {
  const rows = await c.var.db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [K.settings, K.tokenEnc, K.status]))
    .all();
  const map = new Map(rows.map((row) => [row.key, row.value as unknown]));
  const parsed = parseTelegramSettings(map.get(K.settings));
  const hasToken = map.has(K.tokenEnc);
  return {
    settings: parsed,
    status: parseTelegramStatus(map.get(K.status)),
    hasToken,
    tokenEnc: map.get(K.tokenEnc),
    exists: map.has(K.settings),
  };
}

export async function telegramKey(env: Env): Promise<SecretBoxKey | null> {
  try {
    return await importSecretBoxKey(env.COURIER_KEYS_KEY);
  } catch {
    return null;
  }
}

export const telegramBase = (env: Env): string | null => resolveTelegramBase(env);

export function clientOptions(base: string, token: string): TelegramClientOptions {
  return fetchOverride ? { base, token, timeoutMs: ADMIN_TIMEOUT_MS, fetch: fetchOverride } : { base, token, timeoutMs: ADMIN_TIMEOUT_MS };
}

export type OpenedClient = { ok: true; options: TelegramClientOptions } | { ok: false; reason: 'noToken' | 'unreadable' | 'unreachable' };

/** Client options for the stored token, or why there are none. */
export async function openClient(c: Ctx, state: TelegramState): Promise<OpenedClient> {
  if (!state.hasToken || state.settings.bot === null) return { ok: false, reason: 'noToken' };
  const base = telegramBase(c.env);
  if (base === null) return { ok: false, reason: 'unreachable' };
  const key = await telegramKey(c.env);
  if (key === null) return { ok: false, reason: 'unreadable' };
  try {
    return { ok: true, options: clientOptions(base, await openTelegramToken(key, state.tokenEnc)) };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

function upsert(c: Ctx, key: string, value: unknown): BatchItem<'sqlite'> {
  const json = JSON.stringify(value);
  const userId = c.var.user.id;
  // settings.value is JSON text: bind the serialised JSON ourselves (as routes/settings does).
  return c.var.db
    .insert(settings)
    .values({ key, value: sql`${json}`, updatedBy: userId })
    .onConflictDoUpdate({ target: settings.key, set: { value: sql`${json}`, updatedBy: userId, updatedAt: Date.now() } });
}

/**
 * Writes the `telegram` row and its audit row in one batch. `tokenEnc`: a string stores the sealed
 * token, `null` deletes the row, `undefined` leaves it alone.
 */
export async function writeTelegram(c: Ctx, next: TelegramSettings, entry: Omit<AuditEntry, 'entity' | 'entityId'>, tokenEnc?: string | null): Promise<void> {
  const db = c.var.db;
  const stmts: BatchItem<'sqlite'>[] = [upsert(c, K.settings, next)];
  if (typeof tokenEnc === 'string') stmts.push(upsert(c, K.tokenEnc, tokenEnc));
  else if (tokenEnc === null) stmts.push(db.delete(settings).where(inArray(settings.key, [K.tokenEnc])));
  stmts.push(audit(c, { ...entry, entity: 'settings', entityId: K.settings }));
  await db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

export interface ChatDelivery {
  lastSentAt: number | null;
  lastError: string | null;
}

/** Per confirmed chat: last message sent and the error of a delivery still waiting, if any. */
export async function chatDeliveries(c: Ctx, s: TelegramSettings): Promise<Map<string, ChatDelivery>> {
  const out = new Map<string, ChatDelivery>();
  const chats = confirmedTelegramChats(s);
  if (chats.length === 0) return out;
  const channels = chats.map((chat) => `telegram:${chat.id}`);
  const marks = channels.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await c.env.DB.prepare(
    `SELECT channel, MAX(sent_at) AS last_sent,
            MAX(CASE WHEN status <> 'sent' AND last_error IS NOT NULL THEN last_error END) AS last_error
     FROM notification_deliveries WHERE channel IN (${marks}) GROUP BY channel`,
  )
    .bind(...channels)
    .all<{ channel: string; last_sent: number | null; last_error: string | null }>();
  for (const row of results) out.set(row.channel.slice('telegram:'.length), { lastSentAt: row.last_sent, lastError: row.last_error });
  return out;
}
