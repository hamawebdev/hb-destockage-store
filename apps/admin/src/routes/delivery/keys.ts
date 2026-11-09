// Courier keys (SHIP-0 contract rule 15). Sealed with COURIER_KEYS_KEY, AAD = courier id. A missing
// or malformed key turns couriers off with a reason; it never takes the admin down.
import { importSecretBoxKey, openSecret, SecretBoxOpenError, sealSecret, type CourierAccount, type SecretBoxKey, type SealedSecret } from '@hb/db';
import type { CourierContext, CourierCredentials } from '@hb/couriers';
import type { Env } from '../../env.ts';

/**
 * The owner's webhook signing secret (couriers with `webhook: 'hmac'`), sealed with the other keys and
 * read by apps/jobs to verify webhooks. Optional: without it every webhook is rejected and polling
 * carries the load.
 */
export const WEBHOOK_SECRET_FIELD = 'webhookSecret';

export type KeyState = { ok: true; key: SecretBoxKey } | { ok: false; reason: 'missing' | 'invalid' };

export async function readKeyState(env: Pick<Env, 'COURIER_KEYS_KEY'>): Promise<KeyState> {
  const raw = env.COURIER_KEYS_KEY;
  if (raw === undefined || raw.trim() === '') return { ok: false, reason: 'missing' };
  try {
    return { ok: true, key: await importSecretBoxKey(raw) };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

export async function sealCredentials(key: SecretBoxKey, courier: string, credentials: CourierCredentials): Promise<SealedSecret> {
  return sealSecret(key, JSON.stringify(credentials), courier);
}

/** The stored credentials, or null when there are none or they cannot be opened with this key. */
export async function openCredentials(key: SecretBoxKey, account: Pick<CourierAccount, 'courier' | 'credentialsCipher' | 'credentialsIv'> | undefined): Promise<CourierCredentials | null> {
  if (!account?.credentialsCipher || !account.credentialsIv) return null;
  try {
    const parsed: unknown = JSON.parse(await openSecret(key, { cipher: account.credentialsCipher, iv: account.credentialsIv }, account.courier));
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as CourierCredentials;
  } catch (err) {
    if (err instanceof SecretBoxOpenError || err instanceof SyntaxError) return null;
    throw err;
  }
}

/** Last four characters of a long value, otherwise '' (shown as just "set"). */
export function credentialHint(value: string): string {
  return value.length >= 12 ? value.slice(-4) : '';
}

export function courierContext(env: Pick<Env, 'ENV' | 'COURIER_STANDIN_URL'>, timeoutMs: number): CourierContext {
  return { env: env.ENV, timeoutMs, deadlineMs: timeoutMs, ...(env.COURIER_STANDIN_URL ? { standinUrl: env.COURIER_STANDIN_URL } : {}) };
}
