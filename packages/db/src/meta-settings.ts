// Meta settings in D1 (MSET-1, artifacts/MSET-0/plan.md §1, D-016). The admin is the only source of
// truth for the Pixel ID, the Conversions API access token, the test event code and the consent
// setting; they live as key/value rows in `settings`.
//
// The access token is stored encrypted under `metaAccessTokenEnc` as ONE JSON string:
//   base64( 0x01 ‖ IV (12 random bytes, fresh per write) ‖ AES-256-GCM ciphertext ‖ tag (16) )
// with additional data binding it to this key name and version. The key is the Worker secret
// `SETTINGS_ENCRYPTION_KEY` (32 random bytes, base64), parsed by secret-box's importSecretBoxKey,
// bound to hb-admin (encrypts) and hb-web (decrypts). It is never stored in D1.
//
// Nothing here logs, and no error carries key material, plaintext or the stored value.
// Key rotation is out of scope (D-016): a changed key makes the stored token unreadable, which every
// reader treats as "no token" (fail closed) until the owner enters it again.
import { isMetaPixelId } from '@hb/shared';
import { importSecretBoxKey, type SecretBoxKey } from './secret-box.ts';

export const META_SETTING_KEYS = {
  pixelId: 'metaPixelId',
  consentRequired: 'metaConsentRequired',
  tokenEnc: 'metaAccessTokenEnc',
  testEventCode: 'metaTestEventCode',
} as const;

/** Keys only the server may read: never exported, never in the snapshot, never shown in full. */
export const META_SERVER_ONLY_KEYS = [META_SETTING_KEYS.tokenEnc, META_SETTING_KEYS.testEventCode] as const;

export const META_TOKEN_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = new TextEncoder().encode(`hb.settings.${META_SETTING_KEYS.tokenEnc}.v${META_TOKEN_VERSION}`);

export const META_TEST_EVENT_CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** Any reason the stored token cannot be used. The message is constant on purpose. */
export class MetaTokenError extends Error {
  override readonly name = 'MetaTokenError';
  constructor() {
    super('stored Meta access token is unreadable');
  }
}

/** Parses `SETTINGS_ENCRYPTION_KEY`. Throws `SecretBoxKeyError` when missing, not base64 or not 32 bytes. */
export function importSettingsKey(raw: string | undefined): Promise<SecretBoxKey> {
  return importSecretBoxKey(raw);
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The value to store under `metaAccessTokenEnc` (a string; the caller stores it as JSON). */
export async function sealMetaToken(key: SecretBoxKey, token: string): Promise<string> {
  if (token === '') throw new RangeError('sealMetaToken: refusing an empty token');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(token)));
  const out = new Uint8Array(1 + IV_BYTES + ct.length);
  out[0] = META_TOKEN_VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + IV_BYTES);
  return toBase64(out);
}

/**
 * The token from the stored value (already JSON-parsed). Throws `MetaTokenError` for anything that is
 * not a blob this module wrote with this key: not a string, bad base64, too short, unknown version,
 * wrong key, any tampered byte.
 */
export async function openMetaToken(key: SecretBoxKey, stored: unknown): Promise<string> {
  if (typeof stored !== 'string') throw new MetaTokenError();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(stored);
  } catch {
    throw new MetaTokenError();
  }
  if (bytes.length < 1 + IV_BYTES + TAG_BYTES + 1 || bytes[0] !== META_TOKEN_VERSION) throw new MetaTokenError();
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(1, 1 + IV_BYTES), additionalData: AAD },
      key,
      bytes.subarray(1 + IV_BYTES),
    );
    const token = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain);
    if (token === '') throw new MetaTokenError();
    return token;
  } catch {
    throw new MetaTokenError();
  }
}

/** What the admin may show of a token: its last 4 characters, and none for a short one. */
export function metaTokenHint(token: string): string {
  return token.length >= 12 ? `····${token.slice(-4)}` : '····';
}

/** The server's Meta settings, read at send time. Anything malformed reads as absent. */
export interface MetaServerSettings {
  readonly pixelId: string | null;
  /** The stored blob, still sealed; null when absent. */
  readonly tokenEnc: string | null;
  readonly testEventCode: string | null;
}

/** The slice of a D1 binding this module needs (works with the Workers type and test proxies). */
export interface SettingsReader {
  prepare(sql: string): { bind(...values: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> } };
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Coerces raw `settings` rows (key, JSON text) to the server settings. Pure. */
export function metaServerSettingsFrom(rows: readonly { key: unknown; value: unknown }[]): MetaServerSettings {
  const m = new Map(rows.map((r) => [r.key, parseJson(r.value)]));
  const pixel = m.get(META_SETTING_KEYS.pixelId);
  const enc = m.get(META_SETTING_KEYS.tokenEnc);
  const code = m.get(META_SETTING_KEYS.testEventCode);
  return {
    pixelId: isMetaPixelId(pixel) ? pixel : null,
    tokenEnc: typeof enc === 'string' && enc !== '' ? enc : null,
    testEventCode: typeof code === 'string' && META_TEST_EVENT_CODE_RE.test(code) ? code : null,
  };
}

/** One D1 statement for the three server keys. Throws only what D1 throws; callers catch. */
export async function readMetaServerSettings(d1: SettingsReader): Promise<MetaServerSettings> {
  const { results } = await d1
    .prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?)')
    .bind(META_SETTING_KEYS.pixelId, META_SETTING_KEYS.tokenEnc, META_SETTING_KEYS.testEventCode)
    .all<{ key: string; value: string }>();
  return metaServerSettingsFrom(results);
}
