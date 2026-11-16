// TGS-2: orders to Telegram on a real local D1 (the @hb/db migration chain) with a fake fetch.
// The admin's settings rows are the only configuration; the token is a stand-in, never a real one.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { importSecretBoxKey } from '@hb/db/secret-box';
import { sealTelegramToken } from '@hb/db/telegram-settings';
import { TELEGRAM_FIELDS, type TelegramField } from '@hb/shared/telegram';
import { handleDeadLetters } from '../src/notify/dead.ts';
import { handleOrderNotifications } from '../src/notify/consumer.ts';
import { createTelegramNotifier, loadTelegramOrder, runTelegramSync, telegramAlerter, type TelegramEnv } from '../src/notify/telegram.ts';
import { captureConsole, fakeBatch, fakeMessage } from './helpers/batch.ts';
import { localPlatform, type LocalPlatform } from './helpers/platform.ts';
import { applyMigrations, insertOrders } from './helpers/schema.ts';

const TOKEN = '123456:TEST-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
const BASE = 'http://127.0.0.1:4430';
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const A = '1001';
const B = '-1002003004005';

let p: LocalPlatform<{ DB: D1Database }>;
let db: D1Database;
let env: TelegramEnv;

interface Sent {
  chat: string;
  text: string;
}
/** A fake Telegram: `mode` decides what every call gets; `reject` holds chat ids that answer 403. */
function telegram() {
  const t = {
    mode: 'up' as 'up' | 'down' | 'network' | 'limited' | 'unauthorized',
    reject: new Set<string>(),
    sent: [] as Sent[],
    calls: 0,
    urls: [] as string[],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      t.calls += 1;
      t.urls.push(String(input));
      const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
      const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (t.mode === 'network') throw new TypeError(`fetch failed ${String(input)}`);
      if (t.mode === 'down') return json(502, { ok: false });
      if (t.mode === 'limited') return json(429, { ok: false, parameters: { retry_after: 30 } });
      if (t.mode === 'unauthorized') return json(401, { ok: false, description: 'Unauthorized' });
      if (t.reject.has(body.chat_id)) return json(403, { ok: false, description: 'Forbidden: bot was kicked from the group chat' });
      t.sent.push({ chat: body.chat_id, text: body.text });
      return json(200, { ok: true, result: { message_id: t.sent.length } });
    }) as typeof fetch,
  };
  return t;
}

const chat = (id: string, confirmedAt: number | null = NOW - 10 * HOUR) => ({
  id,
  title: `Chat ${id}`,
  type: id.startsWith('-') ? 'supergroup' : 'private',
  status: confirmedAt === null ? 'pending' : 'confirmed',
  seenAt: NOW - 20 * HOUR,
  confirmedAt,
});

async function put(key: string, value: unknown): Promise<void> {
  await db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, 1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(key, JSON.stringify(value)).run();
}
async function configure(over: Record<string, unknown> = {}, token: string | null = TOKEN): Promise<void> {
  await put('telegram', {
    enabled: true,
    enabledAt: NOW - 10 * HOUR,
    lang: 'fr',
    fields: [...TELEGRAM_FIELDS],
    chats: [chat(A)],
    bot: { id: 123456, username: 'standin_bot', name: 'Stand-in' },
    tokenLast4: 'aaaa',
    updateOffset: null,
    ...over,
  });
  if (token === null) await db.prepare(`DELETE FROM settings WHERE key = 'telegramBotTokenEnc'`).run();
  else await put('telegramBotTokenEnc', await sealTelegramToken(await importSecretBoxKey(KEY), token));
}
/** Orders `ids`, created `agoMs` before NOW. */
async function orders(ids: number[], agoMs = HOUR): Promise<void> {
  await insertOrders(db, ids);
  for (const id of ids) await db.prepare('UPDATE orders SET created_at = ?2 WHERE id = ?1').bind(id, NOW - agoMs + id).run();
}
const ref = (id: number) => `HB-T${String(id).padStart(4, '0')}`;
const ledger = () =>
  db.prepare(`SELECT order_id, channel, status, last_error FROM notification_deliveries ORDER BY order_id, channel`).all<{ order_id: number; channel: string; status: string; last_error: string | null }>().then((r) => r.results);
const status = async () => {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'jobs.telegram_status'`).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as { lastOkAt: number | null; lastErrorCode: string | null; lastErrorAt: number | null }) : null;
};
const sync = (t: ReturnType<typeof telegram>, at = NOW, e: TelegramEnv = env) => runTelegramSync(e, { fetch: t.fetch, now: () => at });
const refsTo = (t: ReturnType<typeof telegram>, chatId: string) => t.sent.filter((s) => s.chat === chatId).map((s) => /HB-T\d{4}/.exec(s.text)?.[0]);
const queueBody = (id: number) => ({ type: 'order.created', v: 1, orderId: id, ref: ref(id), totalDzd: 15400, wilayaCode: 16, lang: 'fr', flags: [], createdAt: NOW });

beforeAll(async () => {
  p = await localPlatform();
  db = p.env.DB;
  await applyMigrations(db);
  env = { DB: db, ENV: 'development', TELEGRAM_STANDIN_URL: BASE, COURIER_KEYS_KEY: KEY };
}, 60_000);
afterAll(async () => p?.dispose());
beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM notification_deliveries'),
    db.prepare('DELETE FROM order_items'),
    db.prepare(`DELETE FROM settings WHERE key IN ('telegram', 'telegramBotTokenEnc', 'jobs.telegram_status')`),
  ]);
  // order_events are append-only and orders are referenced by them: move old orders out of every window instead.
  await db.prepare('UPDATE orders SET created_at = 1').run();
});

describe('runTelegramSync', { timeout: 120_000 }, () => {
  test('sends each waiting order once, oldest first, with the ticked details; a second run sends nothing', async () => {
    await configure();
    await orders([11, 12]);
    const t = telegram();
    expect(await sync(t)).toMatchObject({ state: 'ready', sent: 2, failed: 0, error: null });
    expect(refsTo(t, A)).toEqual([ref(11), ref(12)]);
    expect(t.urls[0]).toBe(`${BASE}/bot${TOKEN}/sendMessage`);
    expect(t.sent[0]!.text.split('\n')).toEqual([
      `Nouvelle commande ${ref(11)}`,
      'Client : Test Client',
      'Téléphone : 0560417403',
      'Wilaya : 16 Alger, Alger Centre',
      'Produits :',
      '1 × Pack cuisine',
      expect.stringMatching(/^Livraison : 400\s?DA$/u),
      expect.stringMatching(/^Total : 15\s?400\s?DA$/u),
    ]);
    expect(await ledger()).toEqual([
      { order_id: 11, channel: `telegram:${A}`, status: 'sent', last_error: null },
      { order_id: 12, channel: `telegram:${A}`, status: 'sent', last_error: null },
    ]);
    expect(await status()).toEqual({ lastOkAt: NOW, lastErrorCode: null, lastErrorAt: null });
    expect(await sync(t, NOW + 60_000)).toMatchObject({ sent: 0 });
    expect(t.sent).toHaveLength(2);
  });

  test('the ticks and the language are read at send time', async () => {
    await orders([13]);
    await configure({ fields: ['ref', 'total'] satisfies TelegramField[], lang: 'ar' });
    const t = telegram();
    await sync(t);
    const lines = t.sent[0]!.text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`طلب جديد ⁦${ref(13)}⁩`);
    expect(lines[1]).toMatch(/^المجموع: /);
    expect(t.sent[0]!.text).not.toMatch(/Test Client|0560417403|Alger|الجزائر/);
  });

  test.each(['down', 'network', 'limited'] as const)('outage (%s) then recovery: one call, then each order once per chat', async (mode) => {
    await configure({ chats: [chat(A), chat(B)] });
    await orders([21, 22]);
    const t = telegram();
    t.mode = mode;
    const code = mode === 'limited' ? 'rate_limited' : 'unreachable';
    expect(await sync(t)).toMatchObject({ sent: 0, failed: 1, error: code });
    // The run stops at the first failure: no hammering while Telegram is down.
    expect(t.calls).toBe(1);
    expect(await status()).toEqual({ lastOkAt: null, lastErrorCode: code, lastErrorAt: NOW });
    expect(await ledger()).toEqual([{ order_id: 21, channel: `telegram:${A}`, status: 'sending', last_error: `telegram: ${code}` }]);
    await sync(t, NOW + 60_000);
    expect(t.sent).toEqual([]);
    expect((await status())!.lastErrorAt).toBe(NOW);

    t.mode = 'up';
    expect(await sync(t, NOW + 120_000)).toMatchObject({ sent: 4, failed: 0, error: null });
    await sync(t, NOW + 180_000);
    expect(refsTo(t, A)).toEqual([ref(21), ref(22)]);
    expect(refsTo(t, B)).toEqual([ref(21), ref(22)]);
    expect(await status()).toEqual({ lastOkAt: NOW + 120_000, lastErrorCode: null, lastErrorAt: null });
    expect((await ledger()).every((r) => r.status === 'sent' && r.last_error === null)).toBe(true);
  });

  test('a rejected token stops the run and is reported', async () => {
    await configure({ chats: [chat(A), chat(B)] });
    await orders([23]);
    const t = telegram();
    t.mode = 'unauthorized';
    expect(await sync(t)).toMatchObject({ sent: 0, error: 'token_rejected' });
    expect(t.calls).toBe(1);
    expect((await status())!.lastErrorCode).toBe('token_rejected');
  });

  test('a chat that rejects the bot is recorded and retried later; the other chats still get every order', async () => {
    await configure({ chats: [chat(A), chat(B)] });
    await orders([31, 32]);
    const t = telegram();
    t.reject.add(A);
    expect(await sync(t)).toMatchObject({ sent: 2, failed: 1, error: 'chat_rejected' });
    expect(refsTo(t, B)).toEqual([ref(31), ref(32)]);
    expect(await ledger()).toContainEqual({ order_id: 31, channel: `telegram:${A}`, status: 'sending', last_error: 'telegram: chat_rejected' });
    expect(await status()).toEqual({ lastOkAt: NOW, lastErrorCode: 'chat_rejected', lastErrorAt: NOW });
    // The owner adds the bot back: the missed orders follow, once, and the problem clears.
    t.reject.clear();
    expect(await sync(t, NOW + 60_000)).toMatchObject({ sent: 2, failed: 0, error: null });
    expect(refsTo(t, A)).toEqual([ref(31), ref(32)]);
    expect(refsTo(t, B)).toEqual([ref(31), ref(32)]);
    expect((await status())!.lastErrorCode).toBeNull();
    expect((await ledger()).filter((r) => r.status === 'dead')).toEqual([]);
  });

  test('removing a chat stops it; a pending chat never receives anything', async () => {
    await configure({ chats: [chat(A), chat(B), chat('777', null)] });
    await orders([41]);
    const t = telegram();
    await sync(t);
    expect(t.sent.map((s) => s.chat).sort()).toEqual([B, A].sort());
    await configure({ chats: [chat(A), chat('777', null)] });
    await orders([42]);
    await sync(t, NOW + 60_000);
    expect(refsTo(t, B)).toEqual([ref(41)]);
    expect(refsTo(t, A)).toEqual([ref(41), ref(42)]);
    expect(refsTo(t, '777')).toEqual([]);
  });

  test.each([
    ['switched off', { enabled: false }, TOKEN],
    ['no token', {}, null],
    ['no confirmed chat', { chats: [chat(A, null)] }, TOKEN],
  ] as const)('%s → nothing sent, no network, no status row, no ledger row', async (_l, over, token) => {
    await configure(over, token);
    await orders([51]);
    const t = telegram();
    expect(await sync(t)).toMatchObject({ state: 'off', sent: 0 });
    expect(t.calls).toBe(0);
    expect(await status()).toBeNull();
    expect(await ledger()).toEqual([]);
  });

  test('outside production without a loopback stand-in URL Telegram is off; a public URL is refused', async () => {
    await configure();
    await orders([52]);
    const t = telegram();
    for (const url of [undefined, 'https://api.telegram.org', 'http://192.168.1.5:4430']) {
      const e: TelegramEnv = { DB: db, ENV: 'development', COURIER_KEYS_KEY: KEY, ...(url ? { TELEGRAM_STANDIN_URL: url } : {}) };
      expect(await sync(t, NOW, e)).toMatchObject({ state: 'off' });
    }
    expect(t.calls).toBe(0);
    await sync(t, NOW, { DB: db, ENV: 'production', COURIER_KEYS_KEY: KEY, TELEGRAM_STANDIN_URL: BASE });
    expect(t.urls).toEqual([`https://api.telegram.org/bot${TOKEN}/sendMessage`]);
  });

  test.each([['unset', undefined], ['another key', OTHER_KEY], ['not a key', 'abc']])('COURIER_KEYS_KEY %s → key_missing, no network; fixed once the key is right', async (_l, key) => {
    await configure();
    await orders([53]);
    const t = telegram();
    const e: TelegramEnv = { DB: db, ENV: 'development', TELEGRAM_STANDIN_URL: BASE, ...(key ? { COURIER_KEYS_KEY: key } : {}) };
    expect(await sync(t, NOW, e)).toMatchObject({ state: 'key_missing', error: 'key_missing' });
    expect(t.calls).toBe(0);
    expect(await status()).toEqual({ lastOkAt: null, lastErrorCode: 'key_missing', lastErrorAt: NOW });
    await sync(t, NOW + 60_000);
    expect(refsTo(t, A)).toEqual([ref(53)]);
    expect(await status()).toEqual({ lastOkAt: NOW + 60_000, lastErrorCode: null, lastErrorAt: null });
  });

  test('cut-offs: enabledAt, each chat\'s confirmedAt, and the 72 h window', async () => {
    await orders([61], 80 * HOUR); // older than 72 h
    await orders([62], 30 * HOUR); // before Telegram was switched on
    await orders([63], 5 * HOUR); // after enabledAt, before B was confirmed
    await orders([64], 1 * HOUR);
    await configure({ enabledAt: NOW - 10 * HOUR, chats: [chat(A, NOW - 40 * HOUR), chat(B, NOW - 2 * HOUR)] });
    const t = telegram();
    await sync(t);
    expect(refsTo(t, A)).toEqual([ref(63), ref(64)]);
    expect(refsTo(t, B)).toEqual([ref(64)]);
    // Switched off and on again later: what was ordered in between is never sent.
    await configure({ enabled: false, chats: [chat(A, NOW - 40 * HOUR)] });
    await orders([65], -1 * HOUR);
    await sync(t, NOW + 2 * HOUR);
    await configure({ enabledAt: NOW + 3 * HOUR, chats: [chat(A, NOW - 40 * HOUR)] });
    await orders([66], -4 * HOUR);
    await sync(t, NOW + 5 * HOUR);
    expect(refsTo(t, A)).toEqual([ref(63), ref(64), ref(66)]);
    // With no enabledAt at all (hand-edited row) the window still bounds what can be sent.
    await configure({ enabledAt: null, chats: [chat('909', 0)] });
    await sync(t, NOW + 5 * HOUR);
    expect(refsTo(t, '909')).not.toContain(ref(61));
  });

  test('at most 20 sends per run; the rest follow on the next runs', async () => {
    await configure();
    await orders(Array.from({ length: 23 }, (_, i) => 100 + i));
    const t = telegram();
    expect(await sync(t)).toMatchObject({ sent: 20 });
    expect(t.calls).toBe(20);
    expect(await sync(t, NOW + 60_000)).toMatchObject({ sent: 3 });
    expect(refsTo(t, A)).toEqual(Array.from({ length: 23 }, (_, i) => ref(100 + i)));
  });

  test('logs: refs, counts and codes only; never the token, a URL, a name, a phone or a chat title', async () => {
    await configure({ chats: [chat(A), chat(B)] });
    await orders([71, 72]);
    const t = telegram();
    const cap = captureConsole();
    try {
      t.mode = 'network';
      await sync(t);
      t.mode = 'up';
      t.reject.add(B);
      await sync(t, NOW + 60_000);
      const notify = createTelegramNotifier(env, { fetch: t.fetch, now: () => NOW });
      await notify(71);
      const alert = await telegramAlerter(env, { fetch: t.fetch });
      await alert?.('Backup FAILED', 'detail');
    } finally {
      cap.restore();
    }
    const out = cap.lines.join('\n');
    expect(out).toContain(ref(71));
    expect(out).toContain('unreachable');
    expect(out).not.toMatch(/TEST-aaaa|123456:|https?:|127\.0\.0\.1|\/bot|Test Client|560417403|Chat |Alger/);
    const stored = JSON.stringify((await db.prepare(`SELECT last_error FROM notification_deliveries`).all()).results) + JSON.stringify(await status());
    expect(stored).not.toMatch(/TEST-aaaa|https?:|\/bot/);
  });
});

describe('queue consumer + sweep', { timeout: 120_000 }, () => {
  const consume = (t: ReturnType<typeof telegram>, ids: number[], at = NOW) => {
    const msgs = ids.map((id) => fakeMessage(queueBody(id)));
    const dlq: unknown[] = [];
    return handleOrderNotifications(fakeBatch(msgs), {
      providers: [],
      store: null,
      dlq: { send: async (b: unknown) => void dlq.push(b) } as unknown as Queue<unknown>,
      telegram: createTelegramNotifier(env, { fetch: t.fetch, now: () => at }),
    }).then(() => ({ msgs, dlq }));
  };

  test('a new order goes to every confirmed chat right away; the sweep does not send it again', async () => {
    await configure({ chats: [chat(A), chat(B)] });
    await orders([81], 0);
    const t = telegram();
    const { msgs } = await consume(t, [81]);
    expect(msgs[0]!.outcome).toBe('ack');
    expect(t.sent.map((s) => s.chat)).toEqual([A, B]);
    expect(await status()).toEqual({ lastOkAt: NOW, lastErrorCode: null, lastErrorAt: null });
    await sync(t, NOW + 60_000);
    // A queue redelivery of the same message does nothing either.
    await consume(t, [81], NOW + 90_000);
    expect(t.sent).toHaveLength(2);
  });

  test('Telegram down: the message is still acked, nothing goes to the DLQ, no dead row; the sweep delivers once it is back', async () => {
    await configure({ chats: [chat(A), chat(B)] });
    await orders([82, 83], 0);
    const t = telegram();
    t.mode = 'network';
    const { msgs, dlq } = await consume(t, [82, 83]);
    expect(msgs.map((m) => m.outcome)).toEqual(['ack', 'ack']);
    expect(msgs.every((m) => m.retryDelay === undefined)).toBe(true);
    expect(dlq).toEqual([]);
    // One failed call for the whole batch, then the batch stops trying.
    expect(t.calls).toBe(1);
    expect(await ledger()).toEqual([{ order_id: 82, channel: `telegram:${A}`, status: 'sending', last_error: 'telegram: unreachable' }]);
    expect((await status())!.lastErrorCode).toBe('unreachable');
    t.mode = 'up';
    await sync(t, NOW + 60_000);
    await sync(t, NOW + 120_000);
    expect(refsTo(t, A)).toEqual([ref(82), ref(83)]);
    expect(refsTo(t, B)).toEqual([ref(82), ref(83)]);
    expect((await ledger()).map((r) => r.status)).toEqual(['sent', 'sent', 'sent', 'sent']);
  });

  test('Telegram off: the consumer reads the settings, calls nothing and writes nothing', async () => {
    await configure({ enabled: false });
    await orders([84], 0);
    const t = telegram();
    const { msgs } = await consume(t, [84]);
    expect(msgs[0]!.outcome).toBe('ack');
    expect(t.calls).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  test('a dead-lettered email never turns a Telegram row dead: the sweep still delivers it', async () => {
    await configure();
    await orders([85], 0);
    const t = telegram();
    t.mode = 'down';
    await consume(t, [85]);
    await handleDeadLetters(fakeBatch([fakeMessage(queueBody(85))], 'hb-order-notifications-dlq'), { db, now: () => NOW, channels: ['email'] });
    expect(await ledger()).toEqual([
      { order_id: 85, channel: '*', status: 'dead', last_error: 'no delivery recorded' },
      { order_id: 85, channel: `telegram:${A}`, status: 'sending', last_error: 'telegram: unreachable' },
    ]);
    t.mode = 'up';
    await sync(t, NOW + 60_000);
    expect(refsTo(t, A)).toEqual([ref(85)]);
  });
});

describe('order view and staff alerts', { timeout: 60_000 }, () => {
  test('loadTelegramOrder: names in both languages, variant, address; the note of the "created" event when there is one', async () => {
    await orders([91, 92], 0);
    await db.prepare(`UPDATE orders SET address = 'Cité Test 3' WHERE id = 91`).run();
    await db.prepare(`UPDATE order_items SET variant_label_fr = 'Rouge', variant_label_ar = 'أحمر' WHERE order_id = 91`).run();
    await db.prepare(`INSERT INTO order_events (order_id, type, to_status, note, actor_type, at) VALUES (91, 'created', 'new', 'Livrer le matin', 'customer', 1)`).run();
    // A later staff note is not the customer's note.
    await db.prepare(`INSERT INTO order_events (order_id, type, note, actor_type, at) VALUES (92, 'note', 'interne', 'system', 2)`).run();
    const o = await loadTelegramOrder(db, 91);
    expect(o!.view).toMatchObject({
      ref: ref(91),
      name: 'Test Client',
      phoneE164: '+213560417403',
      wilayaCode: 16,
      wilaya: { fr: 'Alger', ar: 'الجزائر' },
      commune: { fr: 'Alger Centre', ar: 'الجزائر الوسطى' },
      address: 'Cité Test 3',
      items: [{ name: { fr: 'Pack cuisine', ar: 'طقم مطبخ' }, variant: { fr: 'Rouge', ar: 'أحمر' }, qty: 1, lineTotalDzd: 15000 }],
      feeDzd: 400,
      totalDzd: 15400,
      note: 'Livrer le matin',
    });
    expect((await loadTelegramOrder(db, 92))!.view.note).toBeNull();
    expect(await loadTelegramOrder(db, 999_999)).toBeNull();
  });

  test('staff alerts go to the confirmed chats when Telegram is on, to nobody when it is off, and never throw', async () => {
    await configure({ chats: [chat(A), chat(B), chat('777', null)] });
    const t = telegram();
    const alert = await telegramAlerter(env, { fetch: t.fetch });
    await alert!('Comptoir de Luxe backup FAILED', 'Sauvegarde D1 : échec.');
    expect(t.sent).toEqual([
      { chat: A, text: 'Comptoir de Luxe backup FAILED\nSauvegarde D1 : échec.' },
      { chat: B, text: 'Comptoir de Luxe backup FAILED\nSauvegarde D1 : échec.' },
    ]);
    t.mode = 'network';
    await expect(alert!('s', 't')).resolves.toBeUndefined();
    await configure({ enabled: false });
    expect(await telegramAlerter(env, { fetch: t.fetch })).toBeNull();
    expect(await telegramAlerter({ DB: {} as D1Database }, { fetch: t.fetch })).toBeNull();
  });
});
