// MSET-1 (ledger M-1): the Meta access token is stored encrypted, the stored value holds no plaintext,
// and a wrong key or any tampering fails closed. Plus the one D1 read the Worker does at send time.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  META_SETTING_KEYS,
  META_TOKEN_VERSION,
  MetaTokenError,
  importSettingsKey,
  metaServerSettingsFrom,
  metaTokenHint,
  openMetaToken,
  readMetaServerSettings,
  sealMetaToken,
} from '../src/meta-settings.ts';
import { sealSecret, SecretBoxKeyError } from '../src/secret-box.ts';
import { freshD1, type RawD1 } from './d1.ts';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
const SENTINEL = 'SENTINEL_mset1_EAAB0123456789abcdefghijklmnopqrstuvwxyzZZ9876';

const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
const b64Of = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
/** Every substring of `s` of length n. */
const grams = (s: string, n: number) => Array.from({ length: s.length - n + 1 }, (_, i) => s.slice(i, i + n));

describe('sealMetaToken / openMetaToken', () => {
  test('round trip; format = version byte, 12-byte IV, ciphertext and 16-byte tag', async () => {
    const key = await importSettingsKey(KEY);
    const stored = await sealMetaToken(key, SENTINEL);
    const raw = bytesOf(stored);
    expect(raw[0]).toBe(META_TOKEN_VERSION);
    expect(raw.length).toBe(1 + 12 + new TextEncoder().encode(SENTINEL).length + 16);
    expect(await openMetaToken(key, stored)).toBe(SENTINEL);
  });

  test('a fresh random IV per write: the same token never seals the same way twice', async () => {
    const key = await importSettingsKey(KEY);
    const seen = new Set<string>();
    const ivs = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const s = await sealMetaToken(key, SENTINEL);
      seen.add(s);
      ivs.add(b64Of(bytesOf(s).subarray(1, 13)));
    }
    expect(seen.size).toBe(20);
    expect(ivs.size).toBe(20);
  });

  test('the stored value holds no plaintext: no 6-character piece of the token, as text or as bytes', async () => {
    const key = await importSettingsKey(KEY);
    const stored = await sealMetaToken(key, SENTINEL);
    const asJson = JSON.stringify(stored);
    const decoded = new TextDecoder('latin1').decode(bytesOf(stored));
    for (const g of grams(SENTINEL, 6)) {
      expect(asJson).not.toContain(g);
      expect(decoded).not.toContain(g);
    }
  });

  test('the wrong key fails closed with a constant message', async () => {
    const stored = await sealMetaToken(await importSettingsKey(KEY), SENTINEL);
    const err = await openMetaToken(await importSettingsKey(OTHER), stored).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaTokenError);
    expect((err as Error).message).toBe('stored Meta access token is unreadable');
  });

  test('flipping any single bit, in the version, IV, ciphertext or tag, fails closed', async () => {
    const key = await importSettingsKey(KEY);
    const raw = bytesOf(await sealMetaToken(key, SENTINEL));
    let checked = 0;
    for (let i = 0; i < raw.length; i++) {
      for (const bit of [0x01, 0x80]) {
        const t = raw.slice();
        t[i]! ^= bit;
        const err = await openMetaToken(key, b64Of(t)).catch((e: unknown) => e);
        expect(err, `byte ${i} bit ${bit}`).toBeInstanceOf(MetaTokenError);
        checked++;
      }
    }
    expect(checked).toBe(raw.length * 2);
  });

  test.each<[string, unknown]>([
    ['a number', 42],
    ['null', null],
    ['an object', { cipher: 'x', iv: 'y' }],
    ['an empty string', ''],
    ['not base64', '%%%not-base64%%%'],
    ['too short', b64Of(new Uint8Array([1, 2, 3]))],
  ])('a stored value that is %s fails closed', async (_label, value) => {
    await expect(openMetaToken(await importSettingsKey(KEY), value)).rejects.toBeInstanceOf(MetaTokenError);
  });

  test('truncated blobs and an unknown version fail closed', async () => {
    const key = await importSettingsKey(KEY);
    const raw = bytesOf(await sealMetaToken(key, SENTINEL));
    for (const cut of [1, 13, 29, raw.length - 1]) {
      await expect(openMetaToken(key, b64Of(raw.subarray(0, cut)))).rejects.toBeInstanceOf(MetaTokenError);
    }
    const v2 = raw.slice();
    v2[0] = 2;
    await expect(openMetaToken(key, b64Of(v2))).rejects.toBeInstanceOf(MetaTokenError);
  });

  test('a ciphertext sealed for something else (courier keys, other additional data) does not open', async () => {
    const key = await importSettingsKey(KEY);
    const sealed = await sealSecret(key, SENTINEL, 'yalidine');
    const foreign = b64Of(new Uint8Array([META_TOKEN_VERSION, ...bytesOf(sealed.iv), ...bytesOf(sealed.cipher)]));
    await expect(openMetaToken(key, foreign)).rejects.toBeInstanceOf(MetaTokenError);
  });

  test('an empty token is refused at seal time', async () => {
    await expect(sealMetaToken(await importSettingsKey(KEY), '')).rejects.toBeInstanceOf(RangeError);
  });
});

describe('importSettingsKey (SETTINGS_ENCRYPTION_KEY)', () => {
  test.each<[string, string | undefined]>([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['not base64', 'not base64!!'],
    ['16 bytes', btoa('0123456789abcdef')],
    ['33 bytes', btoa('x'.repeat(33))],
  ])('%s: refused, and the error does not echo the value', async (_label, raw) => {
    const err = await importSettingsKey(raw).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretBoxKeyError);
    if (raw && raw.trim()) expect((err as Error).message).not.toContain(raw.trim());
  });
});

describe('metaTokenHint', () => {
  test('at most the last 4 characters', () => {
    expect(metaTokenHint(SENTINEL)).toBe('····9876');
    expect(metaTokenHint('short123')).toBe('····');
  });
});

describe('metaServerSettingsFrom (pure)', () => {
  const row = (key: string, value: unknown) => ({ key, value: JSON.stringify(value) });
  test('valid rows', () => {
    expect(
      metaServerSettingsFrom([row('metaPixelId', '100000000000001'), row('metaAccessTokenEnc', 'blob'), row('metaTestEventCode', 'TEST1234')]),
    ).toEqual({ pixelId: '100000000000001', tokenEnc: 'blob', testEventCode: 'TEST1234' });
  });
  test.each<[string, { key: string; value: unknown }[]]>([
    ['nothing stored', []],
    ['all-zero Pixel ID, empty blob, bad test code', [row('metaPixelId', '000000000000000'), row('metaAccessTokenEnc', ''), row('metaTestEventCode', 'a b')]],
    ['wrong JSON types', [row('metaPixelId', 100000000000001), row('metaAccessTokenEnc', { v: 1 }), row('metaTestEventCode', 1234)]],
    ['14 and 17 digits', [row('metaPixelId', '10000000000001')]],
    ['unparseable JSON text', [{ key: 'metaPixelId', value: '{' }, { key: 'metaAccessTokenEnc', value: null }]],
  ])('%s: absent', (_label, rows) => {
    const s = metaServerSettingsFrom(rows);
    expect(s.pixelId).toBeNull();
    expect(s.tokenEnc).toBeNull();
    expect(s.testEventCode).toBeNull();
  });
});

describe('readMetaServerSettings (real workerd D1)', () => {
  let d1: RawD1;
  let dispose: () => Promise<void>;
  beforeAll(async () => {
    ({ d1, dispose } = await freshD1());
  }, 120_000);
  afterAll(async () => dispose?.());

  test('reads the three server keys in one statement; never the consent row or unrelated keys', async () => {
    const key = await importSettingsKey(KEY);
    const blob = await sealMetaToken(key, SENTINEL);
    const put = (k: string, v: unknown) => d1.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, 1)').bind(k, JSON.stringify(v));
    await d1.batch([
      put(META_SETTING_KEYS.pixelId, '100000000000001'),
      put(META_SETTING_KEYS.tokenEnc, blob),
      put(META_SETTING_KEYS.testEventCode, 'TEST1234'),
      put(META_SETTING_KEYS.consentRequired, false),
    ]);
    const prepared: string[] = [];
    const spy = { prepare: (sql: string) => (prepared.push(sql), d1.prepare(sql)) };
    const s = await readMetaServerSettings(spy as never);
    expect(prepared).toHaveLength(1);
    expect(s).toEqual({ pixelId: '100000000000001', tokenEnc: blob, testEventCode: 'TEST1234' });
    expect(await openMetaToken(key, s.tokenEnc)).toBe(SENTINEL);

    // The row as stored in D1 is a JSON string with no plaintext piece in it.
    const stored = await d1.prepare('SELECT value FROM settings WHERE key = ?').bind(META_SETTING_KEYS.tokenEnc).first<{ value: string }>();
    expect(typeof JSON.parse(stored!.value)).toBe('string');
    for (const g of grams(SENTINEL, 6)) expect(stored!.value).not.toContain(g);
  });

  test('rows removed: everything absent', async () => {
    await d1.prepare("DELETE FROM settings WHERE key LIKE 'meta%'").run();
    expect(await readMetaServerSettings(d1 as never)).toEqual({ pixelId: null, tokenEnc: null, testEventCode: null });
  });
});
