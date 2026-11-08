import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildMime, EmailProvider } from '../src/notify/email.ts';
import { PermanentError, TransientError } from '../src/notify/provider.ts';
import { buildProviders } from '../src/notify/providers.ts';
import { TelegramProvider } from '../src/notify/telegram.ts';

const n = { id: 'order-7', subject: 'Nouvelle commande HB-ABCD1', text: 'Nouvelle commande HB-ABCD1\nTotal : 1 000 DA' };
const TOKEN = '123456:SECRET-TOKEN';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.restoreAllMocks());

describe('buildProviders: disabled unless secrets are set', () => {
  test.each([
    ['nothing set', {}],
    ['token only', { TELEGRAM_BOT_TOKEN: TOKEN }],
    ['chat only', { TELEGRAM_CHAT_ID: '-100' }],
    ['blank secrets', { TELEGRAM_BOT_TOKEN: '  ', TELEGRAM_CHAT_ID: '' }],
    ['email binding without addresses', { NOTIFY_EMAIL: { send: vi.fn() } }],
    ['email addresses without binding', { NOTIFY_EMAIL_FROM: 'a@x.dz', NOTIFY_EMAIL_TO: 'b@x.dz' }],
  ])('%s → no providers', (_l, env) => {
    expect(buildProviders(env, { makeEmailMessage: () => ({}) })).toEqual([]);
  });

  test('both channels when fully configured', () => {
    const ps = buildProviders(
      { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-100', NOTIFY_EMAIL: { send: vi.fn() }, NOTIFY_EMAIL_FROM: 'a@x.dz', NOTIFY_EMAIL_TO: 'b@x.dz' },
      { makeEmailMessage: () => ({}) },
    );
    expect(ps.map((p) => p.channel)).toEqual(['telegram', 'email']);
  });
});

describe('TelegramProvider', () => {
  test('posts sendMessage to the chat', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
    await new TelegramProvider({ botToken: TOKEN, chatId: '-100', fetch: f }).send(n);
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ chat_id: '-100', text: n.text });
  });

  test('429 → transient with retry_after', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonResponse(429, { ok: false, parameters: { retry_after: 17 } }));
    const err = await new TelegramProvider({ botToken: TOKEN, chatId: '-100', fetch: f }).send(n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as TransientError).retryAfterSeconds).toBe(17);
  });

  test('5xx → transient; 400/401/403 → permanent', async () => {
    for (const [status, cls] of [[502, TransientError], [400, PermanentError], [401, PermanentError], [403, PermanentError]] as const) {
      const f = vi.fn<typeof fetch>(async () => jsonResponse(status, { ok: false }));
      await expect(new TelegramProvider({ botToken: TOKEN, chatId: '-100', fetch: f }).send(n)).rejects.toBeInstanceOf(cls);
    }
  });

  test('network error → transient, and the bot token never appears in the error', async () => {
    const f = vi.fn<typeof fetch>(async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    const err = await new TelegramProvider({ botToken: TOKEN, chatId: '-100', fetch: f }).send(n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(String((err as Error).message)).not.toContain('SECRET');
  });
});

describe('EmailProvider', () => {
  test('sends a UTF-8 MIME message through the binding', async () => {
    const send = vi.fn(async () => undefined);
    const make = vi.fn((from: string, to: string, raw: string) => ({ from, to, raw }));
    await new EmailProvider({ binding: { send }, from: 'shop@hb.dz', to: 'staff@hb.dz', makeMessage: make, now: () => new Date(0) }).send({
      ...n,
      subject: 'طلب جديد HB-ABCD1',
    });
    expect(send).toHaveBeenCalledOnce();
    const raw = make.mock.calls[0]![2];
    expect(raw).toContain('From: shop@hb.dz\r\n');
    expect(raw).toContain('Message-ID: <order-7.email@hb.dz>');
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
    const body = raw.split('\r\n\r\n')[1]!.replace(/\r\n/g, '');
    expect(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))).toBe(n.text);
  });

  test('binding failure → transient', async () => {
    const p = new EmailProvider({ binding: { send: async () => Promise.reject(new Error('x')) }, from: 'a@x.dz', to: 'b@x.dz', makeMessage: () => ({}) });
    await expect(p.send(n)).rejects.toBeInstanceOf(TransientError);
  });

  test('refuses header injection', () => {
    expect(() => buildMime({ from: 'a@x.dz\r\nBcc: z@y', to: 'b@x.dz', subject: 's', text: 't', messageId: '<m@x>', date: new Date(0) })).toThrow();
  });
});
