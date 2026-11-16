// Orders to Telegram (TGS-2, D-022). The admin is the only source of the bot token, the chats and the
// ticked details (settings rows `telegram` and `telegramBotTokenEnc`); this Worker holds no Telegram
// secret of its own.
//
// Two callers share one delivery step (claim → send → markSent, ledger channel `telegram:<chatId>`):
// - the queue consumer sends a new order right away. A failure releases the claim and is NOT a queue
//   retry: Telegram never causes a retry, a DLQ forward or a `dead` row.
// - the per-minute sweep `runTelegramSync` sends whatever has no `sent` row yet, so a message missed
//   during an outage follows once Telegram is back.
// The ledger makes the pair idempotent: an order reaches each confirmed chat once (at-least-once
// only if the Worker dies between the send and markSent).
//
// Logs carry event names, the order ref, counts and error codes. Never the token, a URL, a chat
// title, a name, a phone or an address. No caught error message is logged (it could quote the URL).
import { importSecretBoxKey } from '@hb/db/secret-box';
import { TELEGRAM_SETTING_KEYS, openTelegramToken } from '@hb/db/telegram-settings';
import {
  confirmedTelegramChats,
  formatTelegramOrder,
  parseTelegramSettings,
  parseTelegramStatus,
  type TelegramChat,
  type TelegramOrderView,
  type TelegramSettings,
  type TelegramStatus,
  type TelegramStatusCode,
} from '@hb/shared/telegram';
import { TelegramError, resolveTelegramBase, telegramSendMessage, type TelegramClientOptions, type TelegramFailure } from '@hb/shared/telegram-api';
import { log } from '../log.ts';
import { D1DeliveryStore } from './deliveries.ts';

export const TELEGRAM_CHANNEL_PREFIX = 'telegram:';
/** An order older than this is never sent (a long outage does not flood the chat afterwards). */
export const TELEGRAM_WINDOW_MS = 72 * 3_600_000;
export const TELEGRAM_MAX_SENDS_PER_RUN = 20;
const LEASE_MS = 60_000;
/** Telegram's limit for one message. */
const ALERT_MAX = 4000;

export const telegramChannel = (chatId: string): string => `${TELEGRAM_CHANNEL_PREFIX}${chatId}`;

export interface TelegramEnv {
  DB: D1Database;
  ENV?: string;
  /** Non-production only: loopback stand-in base URL. Ignored in production. */
  TELEGRAM_STANDIN_URL?: string;
  /** Opens the sealed bot token (the same key as the admin's). */
  COURIER_KEYS_KEY?: string;
}

export interface TelegramDeps {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxSends?: number;
}

export type TelegramConfig =
  /** Switched off, no token, no confirmed chat, or no endpoint outside production. */
  | { state: 'off'; status: TelegramStatus }
  /** On and configured, but COURIER_KEYS_KEY is unset or cannot open the stored token. */
  | { state: 'key_missing'; status: TelegramStatus }
  | { state: 'ready'; status: TelegramStatus; settings: TelegramSettings; chats: TelegramChat[]; client: TelegramClientOptions };

function fromJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** One D1 read, no network. */
export async function loadTelegramConfig(env: TelegramEnv, deps: TelegramDeps = {}): Promise<TelegramConfig> {
  const K = TELEGRAM_SETTING_KEYS;
  const rows = (await env.DB.prepare('SELECT key, value FROM settings WHERE key IN (?1, ?2, ?3)').bind(K.settings, K.tokenEnc, K.status).all<{ key: string; value: string }>()).results;
  const get = (key: string): unknown => fromJson(rows.find((r) => r.key === key)?.value);
  const status = parseTelegramStatus(get(K.status));
  const settings = parseTelegramSettings(get(K.settings));
  const chats = confirmedTelegramChats(settings);
  const stored = get(K.tokenEnc);
  if (!settings.enabled || chats.length === 0 || typeof stored !== 'string' || stored === '') return { state: 'off', status };
  const base = resolveTelegramBase(env);
  if (base === null) return { state: 'off', status };
  let token: string;
  try {
    token = await openTelegramToken(await importSecretBoxKey(env.COURIER_KEYS_KEY), stored);
  } catch {
    return { state: 'key_missing', status };
  }
  const client: TelegramClientOptions = {
    base,
    token,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  };
  return { state: 'ready', status, settings, chats, client };
}

// ---------------------------------------------------------------------------------------------
// jobs.telegram_status
// ---------------------------------------------------------------------------------------------

/** What a failure means for the owner. `conflict`/`bad_response` cannot be told from an outage here. */
export function statusCodeFor(failure: TelegramFailure): TelegramStatusCode {
  if (failure === 'token_rejected' || failure === 'chat_rejected' || failure === 'rate_limited') return failure;
  return 'unreachable';
}

/** These end a run: the next call would fail the same way. */
const stopsRun = (code: TelegramStatusCode): boolean => code !== 'chat_rejected';

interface Outcome {
  sent: number;
  error: TelegramStatusCode | null;
  /** The caller looked at everything that was waiting (a sweep that was not cut short). */
  complete: boolean;
}

function nextStatus(prev: TelegramStatus, o: Outcome, now: number): TelegramStatus {
  const next: TelegramStatus = { ...prev };
  if (o.sent > 0) next.lastOkAt = now;
  if (o.error !== null) {
    // Keep the first time a continuing problem was seen.
    if (prev.lastErrorCode !== o.error || prev.lastErrorAt === null) next.lastErrorAt = now;
    next.lastErrorCode = o.error;
  } else if (o.complete || (o.sent > 0 && prev.lastErrorCode !== 'chat_rejected')) {
    next.lastErrorCode = null;
    next.lastErrorAt = null;
  }
  return next;
}

/** Writes only when something changed, so an idle minute costs no write. */
async function saveStatus(db: D1Database, prev: TelegramStatus, o: Outcome, now: number): Promise<TelegramStatus> {
  const next = nextStatus(prev, o, now);
  if (next.lastOkAt === prev.lastOkAt && next.lastErrorCode === prev.lastErrorCode && next.lastErrorAt === prev.lastErrorAt) return prev;
  await db
    .prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(TELEGRAM_SETTING_KEYS.status, JSON.stringify(next), now)
    .run();
  return next;
}

// ---------------------------------------------------------------------------------------------
// The order as the message shows it
// ---------------------------------------------------------------------------------------------

interface OrderRow {
  id: number;
  ref: string;
  name: string;
  phone_e164: string;
  wilaya_code: number;
  address: string | null;
  fee_dzd: number;
  total_dzd: number;
  created_at: number;
  wilaya_fr: string | null;
  wilaya_ar: string | null;
  commune_fr: string | null;
  commune_ar: string | null;
  note: string | null;
}
interface ItemRow {
  name_fr: string;
  name_ar: string;
  variant_label_fr: string | null;
  variant_label_ar: string | null;
  qty: number;
  line_total_dzd: number;
}

export interface LoadedOrder {
  id: number;
  createdAt: number;
  view: TelegramOrderView;
}

/**
 * One D1 round trip. `note`: the orders table has no customer note; the only note that exists when
 * an order is created is the `note` of its `created` order event (NULL today, the storefront form
 * has no note field), so the line appears the day something writes one there.
 */
export async function loadTelegramOrder(db: D1Database, orderId: number): Promise<LoadedOrder | null> {
  const [head, items] = await db.batch([
    db
      .prepare(
        `SELECT o.id, o.ref, o.name, o.phone_e164, o.wilaya_code, o.address, o.fee_dzd, o.total_dzd, o.created_at,
                w.name_fr AS wilaya_fr, w.name_ar AS wilaya_ar, c.name_fr AS commune_fr, c.name_ar AS commune_ar,
                (SELECT e.note FROM order_events e WHERE e.order_id = o.id AND e.type = 'created' ORDER BY e.id LIMIT 1) AS note
         FROM orders o
         LEFT JOIN wilayas w ON w.code = o.wilaya_code
         LEFT JOIN communes c ON c.id = o.commune_id
         WHERE o.id = ?1`,
      )
      .bind(orderId),
    db.prepare(`SELECT name_fr, name_ar, variant_label_fr, variant_label_ar, qty, line_total_dzd FROM order_items WHERE order_id = ?1 ORDER BY id`).bind(orderId),
  ]);
  const o = (head?.results as OrderRow[] | undefined)?.[0];
  if (!o) return null;
  const code = String(o.wilaya_code).padStart(2, '0');
  return {
    id: o.id,
    createdAt: o.created_at,
    view: {
      ref: o.ref,
      name: o.name,
      phoneE164: o.phone_e164,
      wilayaCode: o.wilaya_code,
      wilaya: { fr: o.wilaya_fr ?? code, ar: o.wilaya_ar ?? code },
      commune: o.commune_fr !== null && o.commune_ar !== null ? { fr: o.commune_fr, ar: o.commune_ar } : null,
      address: o.address,
      items: ((items?.results as ItemRow[] | undefined) ?? []).map((i) => ({
        name: { fr: i.name_fr, ar: i.name_ar },
        variant: i.variant_label_fr !== null || i.variant_label_ar !== null ? { fr: i.variant_label_fr ?? i.variant_label_ar ?? '', ar: i.variant_label_ar ?? i.variant_label_fr ?? '' } : null,
        qty: i.qty,
        lineTotalDzd: i.line_total_dzd,
      })),
      feeDzd: o.fee_dzd,
      totalDzd: o.total_dzd,
      note: o.note,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------------------------

type Ready = Extract<TelegramConfig, { state: 'ready' }>;

/** Orders created before this are never sent to `chat`: switched on later, confirmed later, or too old. */
function cutoff(settings: TelegramSettings, chat: TelegramChat, now: number): number {
  return Math.max(settings.enabledAt ?? 0, chat.confirmedAt ?? 0, now - TELEGRAM_WINDOW_MS);
}

/** claim → send → markSent. A failure gives the claim back with its code in `last_error`. */
async function deliver(cfg: Ready, store: D1DeliveryStore, order: LoadedOrder, chat: TelegramChat, now: () => number): Promise<'sent' | 'skipped' | TelegramStatusCode> {
  const channel = telegramChannel(chat.id);
  const claim = await store.claim(order.id, channel, now(), LEASE_MS);
  if (claim !== 'claimed') return 'skipped';
  try {
    // The settings as they are now: the ticks apply from the next message on.
    await telegramSendMessage(cfg.client, chat.id, formatTelegramOrder(order.view, cfg.settings.fields, cfg.settings.lang));
  } catch (err) {
    const code = statusCodeFor(err instanceof TelegramError ? err.code : 'unreachable');
    await store.release(order.id, channel, `telegram: ${code}`);
    return code;
  }
  await store.markSent(order.id, channel, now());
  return 'sent';
}

export interface TelegramRunResult {
  state: TelegramConfig['state'] | 'error';
  sent: number;
  failed: number;
  error: TelegramStatusCode | null;
}

/**
 * The per-minute sweep. For each confirmed chat: orders inside its cut-off with no `sent` row,
 * oldest first; at most 20 sends per run; the run stops at the first outage, rate limit or rejected
 * token (retry_after is honoured by waiting for the next minute). A rejected chat is recorded and
 * the other chats go on. Off, no token or no confirmed chat: one D1 read, no network. Never throws.
 */
export async function runTelegramSync(env: TelegramEnv, deps: TelegramDeps = {}): Promise<TelegramRunResult> {
  const now = deps.now ?? Date.now;
  try {
    const cfg = await loadTelegramConfig(env, deps);
    if (cfg.state === 'off') return { state: 'off', sent: 0, failed: 0, error: null };
    if (cfg.state === 'key_missing') {
      await saveStatus(env.DB, cfg.status, { sent: 0, error: 'key_missing', complete: false }, now());
      log('telegram.key_missing');
      return { state: 'key_missing', sent: 0, failed: 0, error: 'key_missing' };
    }
    const store = new D1DeliveryStore(env.DB);
    const budget = deps.maxSends ?? TELEGRAM_MAX_SENDS_PER_RUN;
    const orders = new Map<number, LoadedOrder | null>();
    let attempts = 0;
    let sent = 0;
    let failed = 0;
    let error: TelegramStatusCode | null = null;
    let complete = true;

    chats: for (const chat of cfg.chats) {
      const left = budget - attempts;
      if (left <= 0) {
        complete = false;
        break;
      }
      const channel = telegramChannel(chat.id);
      const waiting = (
        await env.DB.prepare(
          `SELECT o.id FROM orders o
           WHERE o.created_at >= ?1
             AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.order_id = o.id AND d.channel = ?2 AND d.status IN ('sent', 'dead'))
           ORDER BY o.created_at, o.id LIMIT ?3`,
        )
          .bind(cutoff(cfg.settings, chat, now()), channel, left + 1)
          .all<{ id: number }>()
      ).results;
      if (waiting.length > left) complete = false;
      for (const { id } of waiting.slice(0, left)) {
        if (!orders.has(id)) orders.set(id, await loadTelegramOrder(env.DB, id));
        const order = orders.get(id);
        if (!order) continue;
        const r = await deliver(cfg, store, order, chat, now);
        if (r === 'skipped') continue;
        attempts += 1;
        if (r === 'sent') {
          sent += 1;
          log('telegram.sent', { ref: order.view.ref, via: 'sweep' });
          continue;
        }
        failed += 1;
        complete = false;
        log('telegram.failed', { ref: order.view.ref, via: 'sweep', error: r });
        if (stopsRun(r)) {
          error = r;
          break chats;
        }
        // This chat refuses the bot: its other orders would fail the same way. Next chat.
        error ??= r;
        continue chats;
      }
    }
    await saveStatus(env.DB, cfg.status, { sent, error, complete }, now());
    if (attempts > 0) log('telegram.sync', { chats: cfg.chats.length, sent, failed, error });
    return { state: 'ready', sent, failed, error };
  } catch (err) {
    // D1 trouble: the next minute tries again. Class name only.
    log('telegram.sync_error', { error: err instanceof Error ? err.name : typeof err });
    return { state: 'error', sent: 0, failed: 0, error: null };
  }
}

/**
 * For the queue consumer: returns a function that sends one new order to every confirmed chat right
 * away. The configuration is read once per batch, on the first order. It never throws and never asks
 * for a queue retry: whatever fails here is picked up by the sweep.
 */
export function createTelegramNotifier(env: TelegramEnv, deps: TelegramDeps = {}): (orderId: number) => Promise<void> {
  const now = deps.now ?? Date.now;
  let loading: Promise<TelegramConfig> | null = null;
  let status: TelegramStatus | null = null;
  /** Set by an outage, a rate limit or a rejected token: the rest of the batch is left to the sweep. */
  let stopped = false;
  return async (orderId) => {
    try {
      if (stopped) return;
      loading ??= loadTelegramConfig(env, deps);
      const cfg = await loading;
      if (cfg.state !== 'ready') return;
      status ??= cfg.status;
      const order = await loadTelegramOrder(env.DB, orderId);
      if (!order) return;
      const store = new D1DeliveryStore(env.DB);
      let sent = 0;
      let error: TelegramStatusCode | null = null;
      for (const chat of cfg.chats) {
        if (order.createdAt < cutoff(cfg.settings, chat, now())) continue;
        const r = await deliver(cfg, store, order, chat, now);
        if (r === 'skipped') continue;
        if (r === 'sent') {
          sent += 1;
          log('telegram.sent', { ref: order.view.ref, via: 'queue' });
          continue;
        }
        log('telegram.failed', { ref: order.view.ref, via: 'queue', error: r });
        if (stopsRun(r)) {
          error = r;
          stopped = true;
          break;
        }
        error ??= r;
      }
      if (sent > 0 || error !== null) status = await saveStatus(env.DB, status, { sent, error, complete: false }, now());
    } catch (err) {
      log('telegram.notify_error', { error: err instanceof Error ? err.name : typeof err });
    }
  };
}

/**
 * Staff alerts (backup failures) go to the confirmed chats too when Telegram is on. Returns null
 * when Telegram is off or not usable. The sender never throws.
 */
export async function telegramAlerter(env: TelegramEnv, deps: TelegramDeps = {}): Promise<((subject: string, text: string) => Promise<void>) | null> {
  let cfg: TelegramConfig;
  try {
    cfg = await loadTelegramConfig(env, deps);
  } catch (err) {
    log('telegram.alert_error', { error: err instanceof Error ? err.name : typeof err });
    return null;
  }
  if (cfg.state !== 'ready') return null;
  const { client, chats } = cfg;
  return async (subject, text) => {
    const body = `${subject}\n${text}`.slice(0, ALERT_MAX);
    const results = await Promise.allSettled(chats.map((c) => telegramSendMessage(client, c.id, body)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    log('telegram.alert', { chats: chats.length, failed });
  };
}
