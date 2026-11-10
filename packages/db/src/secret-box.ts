// AES-GCM sealing for secrets stored in D1 (courier API keys, the Google refresh token). SHIP-0
// contract rule 15. The key is a Worker secret (`COURIER_KEYS_KEY`: 32 random bytes, base64) shared
// by admin and jobs; `apps/web` never holds it.
//
// `aad` binds a ciphertext to what it belongs to (e.g. the courier id), so swapping two rows in the
// database makes decryption fail instead of handing one courier another's keys.
// Errors never carry key material or plaintext.

export const SECRET_BOX_KEY_BYTES = 32;
const IV_BYTES = 12;

export class SecretBoxKeyError extends Error {
  override readonly name = 'SecretBoxKeyError';
}

export class SecretBoxOpenError extends Error {
  override readonly name = 'SecretBoxOpenError';
}

/** The Web Crypto key type (the global `CryptoKey` name is a value in the Workers types). */
export type SecretBoxKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export interface SealedSecret {
  readonly cipher: string;
  readonly iv: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Throws `SecretBoxKeyError` when the configured key is missing, not base64 or the wrong length. */
export async function importSecretBoxKey(raw: string | undefined): Promise<SecretBoxKey> {
  if (raw === undefined || raw.trim() === '') throw new SecretBoxKeyError('key is not set');
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToBytes(raw.trim());
  } catch {
    throw new SecretBoxKeyError('key is not valid base64');
  }
  if (bytes.length !== SECRET_BOX_KEY_BYTES) throw new SecretBoxKeyError(`key must be ${SECRET_BOX_KEY_BYTES} bytes`);
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealSecret(key: SecretBoxKey, plaintext: string, aad: string): Promise<SealedSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, new TextEncoder().encode(plaintext));
  return { cipher: bytesToBase64(new Uint8Array(cipher)), iv: bytesToBase64(iv) };
}

/** Throws `SecretBoxOpenError` for a wrong key, tampered ciphertext or wrong `aad`. */
export async function openSecret(key: SecretBoxKey, sealed: SealedSecret, aad: string): Promise<string> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(sealed.iv), additionalData: new TextEncoder().encode(aad) },
      key,
      base64ToBytes(sealed.cipher),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new SecretBoxOpenError('secret could not be opened');
  }
}
