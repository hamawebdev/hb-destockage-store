import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildMime, EmailProvider } from '../src/notify/email.ts';
import { TransientError } from '../src/notify/provider.ts';
import { buildProviders } from '../src/notify/providers.ts';

const n = { id: 'order-7', subject: 'Nouvelle commande HB-ABCD1', text: 'Nouvelle commande HB-ABCD1\nTotal : 1 000 DA' };
const TOKEN = '123456:TEST-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

afterEach(() => vi.restoreAllMocks());

describe('buildProviders: disabled unless secrets are set', () => {
  test.each([
    ['nothing set', {}],
    ['email binding without addresses', { NOTIFY_EMAIL: { send: vi.fn() } }],
    ['email addresses without binding', { NOTIFY_EMAIL_FROM: 'a@x.dz', NOTIFY_EMAIL_TO: 'b@x.dz' }],
    ['blank addresses', { NOTIFY_EMAIL: { send: vi.fn() }, NOTIFY_EMAIL_FROM: '  ', NOTIFY_EMAIL_TO: '' }],
  ])('%s → no providers', (_l, env) => {
    expect(buildProviders(env, { makeEmailMessage: () => ({}) })).toEqual([]);
  });

  test('email when fully configured', () => {
    const ps = buildProviders({ NOTIFY_EMAIL: { send: vi.fn() }, NOTIFY_EMAIL_FROM: 'a@x.dz', NOTIFY_EMAIL_TO: 'b@x.dz' }, { makeEmailMessage: () => ({}) });
    expect(ps.map((p) => p.channel)).toEqual(['email']);
  });

  test('TGS-2: the old Telegram env secrets enable nothing (the admin is the only source)', () => {
    const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-100' } as Record<string, string>;
    expect(buildProviders(env, { makeEmailMessage: () => ({}) })).toEqual([]);
    const both = buildProviders({ ...env, NOTIFY_EMAIL: { send: vi.fn() }, NOTIFY_EMAIL_FROM: 'a@x.dz', NOTIFY_EMAIL_TO: 'b@x.dz' }, { makeEmailMessage: () => ({}) });
    expect(both.map((p) => p.channel)).toEqual(['email']);
  });
});

// The Telegram HTTP client (status → code, the token never in an error) is tested in
// packages/shared/test/telegram-api.test.ts; delivery in notify-telegram.d1.test.ts.

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
