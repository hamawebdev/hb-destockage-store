// Shared bits for the /telegram tests (TGS-4): a fake Bot API behind the route's fetch seam, and
// D1 helpers. No network, and the only "token" is the stand-in below.
import type { Harness } from '../helpers.ts';

export const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
export const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
/** Stand-in tokens (never real). Anything containing a piece of one must never leave the server. */
export const TOKEN = '123456:TEST-q7Zk2mPx9LrT4vBn8sWd3HfJ6yGc1VuE';
export const TOKEN_OTHER_BOT = '654321:TEST-n5Rw8cYp3KdS6tMb1zQg9XhL4jFa7UoI';
export const BASE = 'http://127.0.0.1:4430';

export const pieces = (s: string, n: number): string[] => Array.from({ length: s.length - n + 1 }, (_, i) => s.slice(i, i + n));

export interface FakeTelegram {
  fetch: typeof fetch;
  /** token → bot. Unknown tokens get 401. */
  bots: Map<string, { id: number; username: string; first_name: string }>;
  updates: unknown[];
  sent: { chatId: string; text: string }[];
  calls: { method: string; body: Record<string, unknown> }[];
  down: boolean;
  webhook: boolean;
  rejectChats: Set<string>;
}

export function fakeTelegram(): FakeTelegram {
  const t: FakeTelegram = {
    bots: new Map([
      [TOKEN, { id: 123456, username: 'comptoir_test_bot', first_name: 'Comptoir Test' }],
      [TOKEN_OTHER_BOT, { id: 654321, username: 'other_test_bot', first_name: 'Other' }],
    ]),
    updates: [],
    sent: [],
    calls: [],
    down: false,
    webhook: false,
    rejectChats: new Set(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      // A thrown error that quotes the URL (and so the token), as a real fetch failure may.
      if (t.down) throw new TypeError(`fetch failed: ${url.href}`);
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.origin !== BASE || !m) return json(404, { ok: false });
      const [, token, method] = m as unknown as [string, string, string];
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      t.calls.push({ method, body });
      const bot = t.bots.get(token);
      if (!bot) return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      if (method === 'getMe') return json(200, { ok: true, result: { ...bot, is_bot: true } });
      if (method === 'getUpdates') {
        if (t.webhook) return json(409, { ok: false, error_code: 409, description: 'Conflict: webhook is active' });
        const offset = typeof body['offset'] === 'number' ? body['offset'] : 0;
        return json(200, { ok: true, result: t.updates.filter((u) => (u as { update_id: number }).update_id >= offset) });
      }
      if (method === 'sendMessage') {
        const chatId = String(body['chat_id']);
        if (t.rejectChats.has(chatId)) return json(403, { ok: false, error_code: 403, description: 'Forbidden: bot was kicked' });
        t.sent.push({ chatId, text: String(body['text']) });
        return json(200, { ok: true, result: { message_id: t.sent.length } });
      }
      return json(404, { ok: false });
    }) as typeof fetch,
  };
  return t;
}

export const message = (updateId: number, chat: Record<string, unknown>) => ({ update_id: updateId, message: { message_id: updateId, chat, text: 'bonjour' } });

export async function telegramRows(h: Harness): Promise<Record<string, string>> {
  const { results } = await h.db.prepare(`SELECT key, value FROM settings WHERE key IN ('telegram', 'telegramBotTokenEnc', 'jobs.telegram_status') ORDER BY key`).all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function settingsRow(h: Harness): Promise<Record<string, unknown>> {
  const raw = (await telegramRows(h))['telegram'];
  return raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

export async function putSetting(h: Harness, key: string, value: unknown): Promise<void> {
  await h.db.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2').bind(key, JSON.stringify(value)).run();
}

export async function clearTelegram(h: Harness): Promise<void> {
  await h.db.prepare(`DELETE FROM settings WHERE key IN ('telegram', 'telegramBotTokenEnc', 'jobs.telegram_status')`).run();
}

export async function lastAuditId(h: Harness): Promise<number> {
  return (await h.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log').first<{ n: number }>())!.n;
}

export async function auditSince(h: Harness, id: number): Promise<{ action: string; entity_id: string | null; before: string | null; after: string | null }[]> {
  return (await h.db.prepare('SELECT action, entity_id, before, after FROM audit_log WHERE id > ? ORDER BY id').bind(id).all<{ action: string; entity_id: string | null; before: string | null; after: string | null }>()).results;
}

/** Headers and body of a response as one string, for leak greps. */
export async function wholeResponse(res: Response): Promise<string> {
  return `${res.status}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${await res.text()}`;
}

/** One order (with the rows it needs), for delivery and sheet-row dates. Returns its id. */
export async function seedOrder(h: Harness): Promise<number> {
  const db = h.db;
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO wilayas (code, name_fr, name_ar) VALUES (16, 'Alger', 'الجزائر')"),
    db.prepare("INSERT OR IGNORE INTO communes (id, wilaya_code, name_fr, name_ar) VALUES (1601, 16, 'Alger Centre', 'الجزائر الوسطى')"),
    db.prepare("INSERT OR IGNORE INTO customers (phone_e164, name) VALUES ('+213550000000', 'Client Exemple')"),
    db.prepare(
      "INSERT OR IGNORE INTO orders (ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, status, subtotal_dzd, fee_dzd, total_dzd, fee_source, flags, created_at) VALUES ('HB-TGS41', 'idem-tgs4', (SELECT id FROM customers WHERE phone_e164 = '+213550000000'), 'Client Exemple', '+213550000000', 16, 1601, 'fr', 'new', 5000, 400, 5400, 'table', '[]', 1794000000000)",
    ),
  ]);
  return (await db.prepare("SELECT id FROM orders WHERE ref = 'HB-TGS41'").first<{ id: number }>())!.id;
}
