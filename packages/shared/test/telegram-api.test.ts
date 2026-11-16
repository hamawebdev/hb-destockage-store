import { describe, expect, test } from 'vitest';
import { TelegramError, resolveTelegramBase, telegramGetMe, telegramGetUpdates, telegramSendMessage, type TelegramFailure } from '../src/telegram-api.ts';

const TOKEN = '123456:TEST-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = 'http://127.0.0.1:4430';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}
function fake(respond: (c: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = { url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> };
    calls.push(c);
    return respond(c);
  }) as typeof fetch;
  return { fetch: f, calls };
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const opts = (f: typeof fetch) => ({ base: BASE, token: TOKEN, fetch: f });

async function failure(p: Promise<unknown>): Promise<TelegramError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TelegramError);
    const e = err as TelegramError;
    // Nothing a log line or a response could leak: no token, no URL, no host, no upstream text.
    const visible = `${e.message} ${String(e)} ${e.stack ?? ''} ${JSON.stringify(e)} ${String((e as { cause?: unknown }).cause ?? '')}`;
    expect(visible).not.toContain(TOKEN);
    expect(visible).not.toContain('TEST-aaaa');
    expect(visible).not.toMatch(/https?:|127\.0\.0\.1|\/bot/);
    expect(e.message).toBe(`telegram: ${e.code}`);
    return e;
  }
  throw new Error('expected a TelegramError');
}

describe('resolveTelegramBase', () => {
  test('production always talks to Telegram, whatever the stand-in variable says', () => {
    expect(resolveTelegramBase({ ENV: 'production' })).toBe('https://api.telegram.org');
    expect(resolveTelegramBase({ ENV: 'production', TELEGRAM_STANDIN_URL: 'http://127.0.0.1:4430' })).toBe('https://api.telegram.org');
  });
  test('outside production only a literal loopback URL is accepted', () => {
    expect(resolveTelegramBase({ ENV: 'development', TELEGRAM_STANDIN_URL: 'http://127.0.0.1:4430' })).toBe('http://127.0.0.1:4430');
    expect(resolveTelegramBase({ TELEGRAM_STANDIN_URL: 'http://localhost:4430/' })).toBe('http://localhost:4430');
    for (const bad of [undefined, '', 'https://api.telegram.org', 'http://127.0.0.1.evil.example:80', 'http://127.0.0.1:4430/x', 'http://user@127.0.0.1:4430', 'https://127.0.0.1:4430', 'http://10.0.0.1:4430', 'http://localhost:4430?x=1'])
      expect(resolveTelegramBase({ ENV: 'development', ...(bad === undefined ? {} : { TELEGRAM_STANDIN_URL: bad }) }), String(bad)).toBeNull();
    expect(resolveTelegramBase({ ENV: 'staging', TELEGRAM_STANDIN_URL: 'https://api.telegram.org' })).toBeNull();
  });
});

describe('status → code', () => {
  const cases: [number, unknown, TelegramFailure][] = [
    [401, { ok: false, description: 'Unauthorized' }, 'token_rejected'],
    [404, { ok: false, description: 'Not Found' }, 'token_rejected'],
    [400, { ok: false, description: 'Bad Request: chat not found' }, 'chat_rejected'],
    [403, { ok: false, description: 'Forbidden: bot was blocked by the user' }, 'chat_rejected'],
    [429, { ok: false, parameters: { retry_after: 17 } }, 'rate_limited'],
    [409, { ok: false }, 'conflict'],
    [500, 'oops', 'unreachable'],
    [502, { ok: false }, 'unreachable'],
    [302, '', 'bad_response'],
    [200, { ok: false }, 'bad_response'],
    [200, 'not json', 'bad_response'],
  ];
  test.each(cases)('sendMessage HTTP %i %j → %s', async (status, body, code) => {
    const f = fake(() => (typeof body === 'string' ? new Response(body, { status, headers: status === 302 ? { location: 'https://elsewhere.example/' } : {} }) : json(status, body)));
    const e = await failure(telegramSendMessage(opts(f.fetch), '42', 'hello'));
    expect(e.code).toBe(code);
    expect(e.retryAfterSeconds).toBe(code === 'rate_limited' ? 17 : undefined);
  });

  test('a network error or a timeout is "unreachable" and the cause (which quotes the URL) is dropped', async () => {
    const f = (async (input: RequestInfo | URL) => {
      throw new TypeError(`fetch failed: ${String(input)}`);
    }) as typeof fetch;
    expect((await failure(telegramSendMessage(opts(f), '42', 'x'))).code).toBe('unreachable');
    const slow = ((_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error(`aborted ${BASE}/bot${TOKEN}`))))) as typeof fetch;
    expect((await failure(telegramGetMe({ base: BASE, token: TOKEN, fetch: slow, timeoutMs: 20 }))).code).toBe('unreachable');
  });

  test('400/403 on getMe or getUpdates is not a chat problem', async () => {
    const f = fake(() => json(400, { ok: false }));
    expect((await failure(telegramGetMe(opts(f.fetch)))).code).toBe('bad_response');
    expect((await failure(telegramGetUpdates(opts(f.fetch), null))).code).toBe('bad_response');
  });
});

describe('calls', () => {
  test('sendMessage posts plain text to the bot path, without following redirects', async () => {
    const f = fake(() => json(200, { ok: true, result: { message_id: 1 } }));
    await telegramSendMessage(opts(f.fetch), '-1001234567890', 'Bonjour <b>');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(`${BASE}/bot${TOKEN}/sendMessage`);
    expect(f.calls[0]!.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(f.calls[0]!.body).toMatchObject({ chat_id: '-1001234567890', text: 'Bonjour <b>' });
    expect(f.calls[0]!.body).not.toHaveProperty('parse_mode');
  });

  test('getMe returns id, username and name; a malformed answer is bad_response', async () => {
    const ok = fake(() => json(200, { ok: true, result: { id: 123456, is_bot: true, first_name: 'Comptoir', username: 'comptoir_bot' } }));
    expect(await telegramGetMe(opts(ok.fetch))).toEqual({ id: 123456, username: 'comptoir_bot', name: 'Comptoir' });
    const bad = fake(() => json(200, { ok: true, result: { id: 'x' } }));
    expect((await failure(telegramGetMe(opts(bad.fetch)))).code).toBe('bad_response');
  });

  test('getUpdates collects the chats of every update kind, once each, and the next offset', async () => {
    const f = fake(() =>
      json(200, {
        ok: true,
        result: [
          { update_id: 10, message: { chat: { id: 42, type: 'private', first_name: 'Karim', last_name: 'B' } } },
          { update_id: 11, edited_message: { chat: { id: 42, type: 'private', first_name: 'Karim', last_name: 'Ben' } } },
          { update_id: 12, channel_post: { chat: { id: -1005, type: 'channel', title: 'Annonces' } } },
          { update_id: 13, my_chat_member: { chat: { id: -77, type: 'group', title: 'Équipe\nlivraison' }, new_chat_member: { status: 'member' } } },
          { update_id: 14, my_chat_member: { chat: { id: -88, type: 'group', title: 'Parti' }, new_chat_member: { status: 'kicked' } } },
          { update_id: 15, message: { chat: { id: 43, type: 'private', username: 'solo' } } },
          { update_id: 16, message: { chat: { id: 44, type: 'private', first_name: 'x'.repeat(300) } } },
          { update_id: 17, poll: {} },
          { update_id: 18, message: { chat: { id: 'nope', type: 'private' } } },
        ],
      }),
    );
    const r = await telegramGetUpdates(opts(f.fetch), 10);
    expect(f.calls[0]!.url).toBe(`${BASE}/bot${TOKEN}/getUpdates`);
    expect(f.calls[0]!.body).toEqual({ timeout: 0, limit: 100, offset: 10 });
    expect(r.nextOffset).toBe(19);
    expect(r.chats.slice(0, 4)).toEqual([
      { id: '42', title: 'Karim Ben', type: 'private' },
      { id: '-1005', title: 'Annonces', type: 'channel' },
      { id: '-77', title: 'Équipe livraison', type: 'group' },
      { id: '43', title: '@solo', type: 'private' },
    ]);
    expect(r.chats).toHaveLength(5);
    expect(r.chats[4]!.title.length).toBe(80);
  });

  test('getUpdates with nothing new keeps the offset; the first call sends none', async () => {
    const f = fake(() => json(200, { ok: true, result: [] }));
    expect(await telegramGetUpdates(opts(f.fetch), 55)).toEqual({ chats: [], nextOffset: 55 });
    expect(await telegramGetUpdates(opts(f.fetch), null)).toEqual({ chats: [], nextOffset: null });
    expect(f.calls[1]!.body).toEqual({ timeout: 0, limit: 100 });
  });
});
