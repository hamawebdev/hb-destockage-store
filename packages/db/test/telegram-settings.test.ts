// TGS-1: the Telegram bot token is stored sealed, the stored value holds no plaintext, a wrong key or
// tampering fails closed, and none of the three Telegram rows can reach the snapshot or a deploy export.
import { describe, expect, test } from 'vitest';
import { SNAPSHOT_SETTINGS_KEYS } from '@hb/catalog';
import { INTERNAL_SETTINGS_KEYS, STOREFRONT_SETTINGS_KEYS } from '../src/enums.ts';
import { importSecretBoxKey, sealSecret, SecretBoxOpenError } from '../src/secret-box.ts';
import { TELEGRAM_SETTING_KEYS, openTelegramToken, sealTelegramToken } from '../src/telegram-settings.ts';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
const TOKEN = '123456:TEST-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('sealTelegramToken / openTelegramToken', () => {
  test('round trip; "<iv>.<cipher>", fresh IV per write, no plaintext in the stored value', async () => {
    const key = await importSecretBoxKey(KEY);
    const a = await sealTelegramToken(key, TOKEN);
    const b = await sealTelegramToken(key, TOKEN);
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*\.[A-Za-z0-9+/]+=*$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('TEST-');
    expect(atob(a.split('.')[1]!)).not.toContain('TEST-');
    expect(await openTelegramToken(key, a)).toBe(TOKEN);
    expect(await openTelegramToken(key, b)).toBe(TOKEN);
  });

  test('fails closed: wrong key, tampering, another secret moved into the row, garbage', async () => {
    const key = await importSecretBoxKey(KEY);
    const stored = await sealTelegramToken(key, TOKEN);
    const fails = async (p: Promise<string>) => {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SecretBoxOpenError);
      expect(String(err)).not.toContain('TEST-');
    };
    await fails(openTelegramToken(await importSecretBoxKey(OTHER), stored));
    const [iv, cipher] = stored.split('.') as [string, string];
    const flipped = (cipher[0] === 'A' ? 'B' : 'A') + cipher.slice(1);
    await fails(openTelegramToken(key, `${iv}.${flipped}`));
    const foreign = await sealSecret(key, TOKEN, 'sheets.refresh_token');
    await fails(openTelegramToken(key, `${foreign.iv}.${foreign.cipher}`));
    for (const bad of [undefined, null, 42, '', 'nodot', '.x', TOKEN, { iv, cipher }]) await fails(openTelegramToken(key, bad));
  });
});

describe('settings key registry', () => {
  test('the three Telegram rows are internal, never storefront or snapshot keys', () => {
    expect(TELEGRAM_SETTING_KEYS).toEqual({ settings: 'telegram', tokenEnc: 'telegramBotTokenEnc', status: 'jobs.telegram_status' });
    expect(INTERNAL_SETTINGS_KEYS).toMatchObject({ telegram: 'telegram', telegramBotTokenEnc: 'telegram', 'jobs.telegram_status': 'jobs' });
    for (const k of Object.values(TELEGRAM_SETTING_KEYS)) {
      expect((STOREFRONT_SETTINGS_KEYS as readonly string[]).includes(k), k).toBe(false);
      expect((SNAPSHOT_SETTINGS_KEYS as readonly string[]).includes(k), k).toBe(false);
    }
    for (const k of [...STOREFRONT_SETTINGS_KEYS, ...SNAPSHOT_SETTINGS_KEYS] as string[]) expect(/telegram/i.test(k), k).toBe(false);
  });
});
