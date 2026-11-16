// TGS-3: the Telegram stand-in speaks enough Bot API for the shared client, and the local live
// proxy forwards only the known paths and never prints a token or a query string.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { TelegramError, resolveTelegramBase, telegramGetMe, telegramGetUpdates, telegramSendMessage } from '@hb/shared/telegram-api';

const TOKEN = '123456:TEST-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
interface Started {
  server: Server;
  port: number;
}
// The tools are plain .mjs without types: loaded by URL.
const load = async (rel: string) => (await import(/* @vite-ignore */ new URL(rel, import.meta.url).href)) as Record<string, unknown>;
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof TelegramError ? e.code : 'other'));

describe('tools/standins/telegram/server.mjs', () => {
  let s: Started;
  let base: string;
  const control = (path: string, body?: unknown) => fetch(`${base}/__control/${path}`, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  const read = (path: string) => fetch(`${base}/__control/${path}`).then((r) => r.json() as Promise<unknown>);
  const o = () => ({ base, token: TOKEN, timeoutMs: 3000 });

  beforeAll(async () => {
    s = await ((await load('../../../tools/standins/telegram/server.mjs'))['startStandin'] as (port: number) => Promise<Started>)(0);
    base = `http://127.0.0.1:${s.port}`;
  });
  afterAll(() => new Promise<void>((r) => void s.server.close(() => r())));

  test('binds loopback, and its URL passes the Workers\' stand-in rule', () => {
    expect(s.server.address()).toMatchObject({ address: '127.0.0.1' });
    expect(resolveTelegramBase({ ENV: 'development', TELEGRAM_STANDIN_URL: base })).toBe(base);
  });

  test('getMe, queued updates → chats, offsets confirm, sendMessage is recorded', async () => {
    await control('reset');
    expect(await telegramGetMe(o())).toMatchObject({ username: 'standin_orders_bot' });
    await control('update', { private: { id: 42, first_name: 'Karim', last_name: 'B' } });
    await control('update', { group: { id: -1005, title: 'Équipe' } });
    await control('update', { left: { id: -1006 } });
    const first = await telegramGetUpdates(o(), null);
    expect(first.chats).toEqual([
      { id: '42', title: 'Karim B', type: 'private' },
      { id: '-1005', title: 'Équipe', type: 'group' },
    ]);
    expect(await telegramGetUpdates(o(), first.nextOffset)).toEqual({ chats: [], nextOffset: first.nextOffset });
    await telegramSendMessage(o(), '42', 'Nouvelle commande HB-TEST1');
    expect(await read('sent')).toMatchObject([{ chat_id: '42', text: 'Nouvelle commande HB-TEST1' }]);
    // The token is not kept anywhere the control API shows.
    expect(JSON.stringify([await read('calls'), await read('state')])).not.toContain('TEST-aaaa');
  });

  test('down, rate limit, rejected chat, pinned token and webhook give the codes the Workers act on', async () => {
    await control('reset');
    await control('down');
    expect(await code(telegramSendMessage(o(), '42', 'x'))).toBe('unreachable');
    await control('up');
    await control('mode', { mode: '429', retryAfter: 7, times: 1 });
    expect(await code(telegramSendMessage(o(), '42', 'x'))).toBe('rate_limited');
    expect(await code(telegramSendMessage(o(), '42', 'x'))).toBe('ok');
    await control('chat', { id: 42, reject: true });
    expect(await code(telegramSendMessage(o(), '42', 'x'))).toBe('chat_rejected');
    await control('settings', { token: '654321:OTHER-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', webhook: true });
    expect(await code(telegramGetMe(o()))).toBe('token_rejected');
    await control('settings', { token: null });
    expect(await code(telegramGetUpdates(o(), null))).toBe('conflict');
    expect(await code(telegramGetMe({ ...o(), token: 'nope' }))).toBe('token_rejected');
  });
});

describe('tools/standins/live-proxy.mjs', () => {
  let p: Started;
  let base: string;
  const lines: string[] = [];
  const upstream: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  let failUpstream = false;

  beforeAll(async () => {
    const mod = await load('../../../tools/standins/live-proxy.mjs');
    const fakeFetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => {
      if (failUpstream) throw new TypeError(`fetch failed ${url}`);
      upstream.push({ url, method: init.method, headers: init.headers, body: init.body ? new TextDecoder().decode(init.body) : '' });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } });
    };
    p = await (mod['startLiveProxy'] as (port: number, o: unknown) => Promise<Started>)(0, { fetch: fakeFetch, log: (l: string) => void lines.push(l) });
    base = `http://127.0.0.1:${p.port}`;
  });
  afterAll(() => new Promise<void>((r) => void p.server.close(() => r())));

  test('binds 127.0.0.1 only', () => {
    expect(p.server.address()).toMatchObject({ address: '127.0.0.1' });
  });

  test('Telegram: same path on api.telegram.org; the client works through it', async () => {
    await telegramSendMessage({ base, token: TOKEN }, '42', 'Bonjour');
    expect(upstream.at(-1)).toMatchObject({ url: `https://api.telegram.org/bot${TOKEN}/sendMessage`, method: 'POST' });
    expect(JSON.parse(upstream.at(-1)!.body)).toMatchObject({ chat_id: '42', text: 'Bonjour' });
    expect(Object.keys(upstream.at(-1)!.headers).sort()).toEqual(['accept', 'content-type']);
  });

  test('Google paths map to the real hosts; the consent URL and the sheet link are redirects', async () => {
    const hit = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init });
    const auth = await hit('/o/oauth2/v2/auth?client_id=abc&state=SECRETSTATE');
    expect([auth.status, auth.headers.get('location')]).toEqual([302, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=SECRETSTATE']);
    const sheet = await hit('/__control/sheet?id=1AbCdEfGhIjKlMnOp');
    expect([sheet.status, sheet.headers.get('location')]).toEqual([302, 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit']);
    expect((await hit('/__control/sheet?id=../x')).status).toBe(400);
    const r = await hit('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'a=b', authorization: 'Bearer SECRETBEARER' }, body: 'refresh_token=SECRETREFRESH' });
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(upstream.at(-1)).toMatchObject({ url: 'https://oauth2.googleapis.com/token', body: 'refresh_token=SECRETREFRESH' });
    // Only the allowlisted headers travel: no cookie, no host.
    expect(upstream.at(-1)!.headers).toEqual({ accept: '*/*', authorization: 'Bearer SECRETBEARER', 'content-type': 'application/x-www-form-urlencoded' });
    await hit('/revoke', { method: 'POST', body: 'token=SECRETREFRESH' });
    await hit('/v4/spreadsheets/1AbC/values:batchUpdate?valueInputOption=RAW', { method: 'POST', body: '{}' });
    await hit(`/v4/spreadsheets/1AbC/values/${encodeURIComponent("'Commandes'!A1:B2")}`);
    await hit('/drive/v3/files?q=SECRETQUERY');
    await hit('/drive/v3/files/1AbC?fields=id');
    expect(upstream.slice(-5).map((u) => u.url)).toEqual([
      'https://oauth2.googleapis.com/revoke',
      'https://sheets.googleapis.com/v4/spreadsheets/1AbC/values:batchUpdate?valueInputOption=RAW',
      `https://sheets.googleapis.com/v4/spreadsheets/1AbC/values/${encodeURIComponent("'Commandes'!A1:B2")}`,
      'https://www.googleapis.com/drive/v3/files?q=SECRETQUERY',
      'https://www.googleapis.com/drive/v3/files/1AbC?fields=id',
    ]);
  });

  test('anything else is refused and never forwarded', async () => {
    const before = upstream.length;
    for (const path of ['/', '/bot123/getMe', `/bot${TOKEN}/get/Me`, '/v4/other', '/drive/v3/filesx', '/v4/spreadsheets/a/../../x', '/tokens', '/https://evil.example/'])
      expect((await fetch(`${base}${path}`, { method: 'POST', body: '{}' })).status, path).toBe(404);
    expect(upstream.length).toBe(before);
  });

  test('down/up rehearse an outage; an upstream failure also closes the connection', async () => {
    await fetch(`${base}/__control/down`, { method: 'POST' });
    expect(await code(telegramSendMessage({ base, token: TOKEN }, '42', 'x'))).toBe('unreachable');
    await fetch(`${base}/__control/up`, { method: 'POST' });
    expect(await code(telegramSendMessage({ base, token: TOKEN }, '42', 'x'))).toBe('ok');
    failUpstream = true;
    expect(await code(telegramSendMessage({ base, token: TOKEN }, '42', 'x'))).toBe('unreachable');
    failUpstream = false;
  });

  test('the log holds method, a token-free and query-free path, and the status; nothing else', () => {
    const out = lines.join('\n');
    expect(lines).toContain('POST /bot<token>/sendMessage 200');
    expect(lines).toContain('POST /bot<token>/sendMessage dropped');
    expect(lines).toContain('POST /bot<token>/sendMessage unreachable');
    expect(lines).toContain('GET /o/oauth2/v2/auth 302');
    expect(lines).toContain('GET /drive/v3/files 200');
    expect(lines.filter((l) => l === 'POST /<not-proxied> 404')).toHaveLength(8);
    expect(out).not.toMatch(/TEST-aaaa|123456:|SECRET|\?|https?:|Bearer|api\.telegram/);
    for (const l of lines) expect(l).toMatch(/^(GET|POST) \/\S* (\d{3}|dropped|unreachable|error)$/);
  });
});
