// SHIP-5: what every courier sync step shares. Courier keys are opened here and only here in jobs;
// they never reach a log line (see `errorClass`).
import { getCourier, type CourierAdapter, type CourierContext, type CourierCredentials } from '@hb/couriers';
import { courierAccounts, importSecretBoxKey, openSecret, type CourierAccount, type Db } from '@hb/db';
import { log } from '../log.ts';

export const SYNC_LIMITS = {
  /** The whole run; the cron fires every minute. */
  BUDGET_MS: 40_000,
  /** Each account's courier steps, run concurrently with the other accounts'. */
  ACCOUNT_MS: 20_000,
  /** One courier request. */
  CALL_MS: 8_000,
  INBOX_BATCH: 50,
  LEASE_MS: 120_000,
  INBOX_MAX_ATTEMPTS: 5,
  /** A webhook whose tracking we don't hold yet is retried this long before a person sees it. */
  HOLD_MS: 30 * 60_000,
  EVENT_SHIPMENTS: 100,
  STALE_MS: 5 * 60_000,
  /** Before the first lookup of an uncertain send, and between lookups. */
  VERIFY_DELAY_MS: 60_000,
  VERIFY_BATCH: 10,
  INCONCLUSIVE_MS: 30 * 60_000,
  ABSENT_MS: 3 * 86_400_000,
  DRAFT_AGE_MS: 5 * 60_000,
  /** The admin's own accept retries run first; the cron picks up only what they left. */
  UNAPPLIED_GRACE_MS: 30_000,
  POLL_BACKOFF_MS: 60_000,
  PURGE_MS: 14 * 86_400_000,
  REFRESH_BUDGET_MS: 5_000,
  REFRESH_WILAYAS: 10,
} as const;

export type SyncLimits = { -readonly [K in keyof typeof SYNC_LIMITS]: number };

export interface SyncEnv {
  readonly ENV?: string | undefined;
  readonly COURIER_KEYS_KEY?: string | undefined;
  readonly COURIER_STANDIN_URL?: string | undefined;
}

export interface SyncContext {
  readonly db: Db;
  /** The raw binding, for the inbox claim (BLOB column, `RETURNING`). */
  readonly d1: D1Database;
  readonly env: SyncEnv;
  readonly now: () => number;
  readonly limits: SyncLimits;
  /** Injected in tests; the adapters' own `fetch` otherwise. */
  readonly fetch?: typeof fetch;
}

/** An account whose courier exists. `credentials` null = keys missing or unreadable. */
export interface SyncAccount {
  readonly row: CourierAccount;
  readonly adapter: CourierAdapter;
  readonly credentials: CourierCredentials | null;
  /** Enabled, with readable keys: courier calls are allowed. */
  readonly usable: boolean;
}

export function courierCtx(ctx: SyncContext, timeoutMs: number): CourierContext {
  return {
    env: ctx.env.ENV,
    timeoutMs,
    deadlineMs: timeoutMs,
    ...(ctx.env.COURIER_STANDIN_URL ? { standinUrl: ctx.env.COURIER_STANDIN_URL } : {}),
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    now: ctx.now,
  };
}

/** Every account row with a registered courier, keys opened when the key allows. */
export async function loadAccounts(ctx: SyncContext): Promise<SyncAccount[]> {
  const rows = await ctx.db.select().from(courierAccounts);
  let key: Awaited<ReturnType<typeof importSecretBoxKey>> | null = null;
  try {
    key = await importSecretBoxKey(ctx.env.COURIER_KEYS_KEY);
  } catch {
    key = null;
  }
  const out: SyncAccount[] = [];
  for (const row of rows) {
    const adapter = getCourier(row.courier);
    if (!adapter) continue;
    let credentials: CourierCredentials | null = null;
    if (key && row.credentialsCipher && row.credentialsIv) {
      try {
        const parsed: unknown = JSON.parse(await openSecret(key, { cipher: row.credentialsCipher, iv: row.credentialsIv }, row.courier));
        credentials = parsed !== null && typeof parsed === 'object' ? (parsed as CourierCredentials) : null;
      } catch {
        credentials = null;
      }
    }
    out.push({ row, adapter, credentials, usable: row.enabled && credentials !== null });
  }
  return out;
}

/** Error class or D1's own message head: never Drizzle's "Failed query … params" text (bound values). */
export function errorClass(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown';
  return err.name === 'Error' ? 'Error' : err.name;
}

export function logStepError(step: string, err: unknown, fields: Record<string, string | number> = {}): void {
  log('courier_sync.step_failed', { step, error: errorClass(err), ...fields });
}

export const changesOf = (result: unknown): number => (result as { meta?: { changes?: number } }).meta?.changes ?? 0;

export const SYSTEM_ACTOR = { system: 'courier_sync' } as const;
