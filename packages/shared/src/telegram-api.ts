/**
 * Telegram Bot API client (TGS-1), used by the admin (getMe, getUpdates, test message) and the jobs
 * Worker (sendMessage). Import it by name (`@hb/shared/telegram-api`); it is not part of the index
 * and never belongs in a storefront import path.
 *
 * The bot token is part of the URL path. So nothing here logs, and no error leaves this file with a
 * URL or a caught message in it: every failure is a `TelegramError` with a fixed text and a code.
 * Only fetch, AbortSignal and JSON are used.
 */
import { TELEGRAM_CHAT_TITLE_MAX, TELEGRAM_CHAT_TYPES, telegramOneLine, type TelegramChat, type TelegramChatType } from './telegram.ts';

const PRODUCTION_BASE = 'https://api.telegram.org';
const STANDIN_URL = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?\/?$/;

/**
 * Production → 'https://api.telegram.org'. Otherwise only a literal loopback URL from
 * TELEGRAM_STANDIN_URL (http://127.0.0.1:<port> or http://localhost:<port>), else null = Telegram off.
 * Same rule as resolveGoogleEndpoints in apps/jobs/src/sheets/google.ts.
 */
export function resolveTelegramBase(env: { ENV?: string | undefined; TELEGRAM_STANDIN_URL?: string | undefined }): string | null {
  if (env.ENV === 'production') return PRODUCTION_BASE;
  const raw = env.TELEGRAM_STANDIN_URL;
  if (typeof raw !== 'string' || !STANDIN_URL.test(raw)) return null;
  return raw.replace(/\/$/, '');
}

export type TelegramFailure = 'token_rejected' | 'chat_rejected' | 'rate_limited' | 'unreachable' | 'conflict' | 'bad_response';

/** The message is a fixed text naming the code: never the URL, the token or what Telegram answered. */
export class TelegramError extends Error {
  override readonly name = 'TelegramError';
  readonly code: TelegramFailure;
  readonly retryAfterSeconds?: number;
  constructor(code: TelegramFailure, retryAfterSeconds?: number) {
    super(`telegram: ${code}`);
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface TelegramClientOptions {
  base: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Method = 'getMe' | 'getUpdates' | 'sendMessage';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function failureFor(method: Method, status: number): TelegramFailure {
  if (status === 401 || status === 404) return 'token_rejected';
  if (status === 429) return 'rate_limited';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'unreachable';
  // 400 "chat not found" / 403 "bot was blocked by the user" / "bot is not a member".
  if ((status === 400 || status === 403) && method === 'sendMessage') return 'chat_rejected';
  return 'bad_response';
}

/** POSTs one Bot API method and returns its `result`. Throws only `TelegramError`. */
async function call(o: TelegramClientOptions, method: Method, payload: Record<string, unknown>): Promise<unknown> {
  const doFetch = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${o.base}/bot${o.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    });
  } catch {
    // Network error or timeout. The caught error may quote the URL (the token): dropped.
    throw new TelegramError('unreachable');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON: decided by the status below */
  }
  if (!res.ok) {
    const code = failureFor(method, res.status);
    const params = isRecord(body) ? body['parameters'] : null;
    const ra = isRecord(params) ? params['retry_after'] : null;
    throw new TelegramError(code, code === 'rate_limited' && typeof ra === 'number' && ra > 0 ? Math.ceil(ra) : undefined);
  }
  if (!isRecord(body) || body['ok'] !== true) throw new TelegramError('bad_response');
  return body['result'];
}

export async function telegramGetMe(o: TelegramClientOptions): Promise<{ id: number; username: string; name: string }> {
  const r = await call(o, 'getMe', {});
  if (!isRecord(r) || typeof r['id'] !== 'number' || !Number.isSafeInteger(r['id']) || typeof r['username'] !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(r['username'])) {
    throw new TelegramError('bad_response');
  }
  return { id: r['id'], username: r['username'], name: telegramOneLine(typeof r['first_name'] === 'string' ? r['first_name'] : '', 80) };
}

/** Plain text, no parse_mode, no link preview. */
export async function telegramSendMessage(o: TelegramClientOptions, chatId: string, text: string): Promise<void> {
  await call(o, 'sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
}

type FoundChat = Omit<TelegramChat, 'status' | 'seenAt' | 'confirmedAt'>;

function chatOf(raw: unknown): FoundChat | null {
  if (!isRecord(raw)) return null;
  const { id, type } = raw;
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
  if (!(TELEGRAM_CHAT_TYPES as readonly unknown[]).includes(type)) return null;
  const str = (k: string): string => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
  const person = `${str('first_name')} ${str('last_name')}`.trim();
  const title = telegramOneLine(str('title') || person || (str('username') ? `@${str('username')}` : ''), TELEGRAM_CHAT_TITLE_MAX);
  return { id: String(id), title: title || String(id), type: type as TelegramChatType };
}

/**
 * getUpdates with timeout 0, limit 100. Returns the chats seen (message, edited_message,
 * channel_post, my_chat_member with a status other than left/kicked) and the next offset
 * (the given one when there was no update). 409 → 'conflict' (a webhook is set).
 */
export async function telegramGetUpdates(o: TelegramClientOptions, offset: number | null): Promise<{ chats: FoundChat[]; nextOffset: number | null }> {
  const r = await call(o, 'getUpdates', { timeout: 0, limit: 100, ...(offset === null ? {} : { offset }) });
  if (!Array.isArray(r)) throw new TelegramError('bad_response');
  const chats = new Map<string, FoundChat>();
  let nextOffset = offset;
  for (const u of r) {
    if (!isRecord(u)) continue;
    const updateId = u['update_id'];
    if (typeof updateId === 'number' && Number.isSafeInteger(updateId) && (nextOffset === null || updateId + 1 > nextOffset)) nextOffset = updateId + 1;
    let raw: unknown = null;
    for (const kind of ['message', 'edited_message', 'channel_post'] as const) {
      const m = u[kind];
      if (isRecord(m)) raw = m['chat'];
    }
    const member = u['my_chat_member'];
    if (isRecord(member)) {
      const now = member['new_chat_member'];
      const status = isRecord(now) ? now['status'] : null;
      if (status !== 'left' && status !== 'kicked') raw = member['chat'];
    }
    const chat = chatOf(raw);
    if (chat) chats.set(chat.id, chat);
  }
  return { chats: [...chats.values()], nextOffset };
}
