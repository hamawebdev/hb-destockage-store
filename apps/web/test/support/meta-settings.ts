// Meta settings rows for the Worker tests (MSET-3): what the admin's /meta screen writes, written
// straight to the harness's D1. Fake values only; the stand-in is the only destination.
import { importSettingsKey, META_SETTING_KEYS, sealMetaToken } from '@hb/db/meta-settings';

/** Test key for SETTINGS_ENCRYPTION_KEY (32 bytes of 0x11). Never a real value. */
export const TEST_SETTINGS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(0x11)));
export const OTHER_SETTINGS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(0x22)));
/** Non-zero fake Pixel ID (the admin and the export refuse all zeros). */
export const FAKE_PIXEL = '100000000000001';
export const FAKE_TOKEN = 'FAKE_TEST_TOKEN_mset3_0123456789abcdef';

interface D1Like {
  prepare(sql: string): { bind(...v: unknown[]): unknown };
  batch(stmts: unknown[]): Promise<unknown>;
}

export interface MetaRows {
  readonly pixelId?: string | null;
  /** Plain token: sealed here with `key`. */
  readonly token?: string | null;
  /** A raw stored value instead of a sealed token (tampering tests). */
  readonly tokenEncRaw?: string;
  readonly testEventCode?: string | null;
  readonly key?: string;
}

/** Replaces every Meta row with `rows` (absent or null = no row). */
export async function setMetaRows(db: D1Like, rows: MetaRows): Promise<void> {
  const put = (k: string, v: unknown) => db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, 1)').bind(k, JSON.stringify(v));
  const stmts: unknown[] = [db.prepare("DELETE FROM settings WHERE key LIKE 'meta%'").bind()];
  if (rows.pixelId) stmts.push(put(META_SETTING_KEYS.pixelId, rows.pixelId));
  if (rows.tokenEncRaw !== undefined) stmts.push(put(META_SETTING_KEYS.tokenEnc, rows.tokenEncRaw));
  else if (rows.token) stmts.push(put(META_SETTING_KEYS.tokenEnc, await sealMetaToken(await importSettingsKey(rows.key ?? TEST_SETTINGS_KEY), rows.token)));
  if (rows.testEventCode) stmts.push(put(META_SETTING_KEYS.testEventCode, rows.testEventCode));
  await db.batch(stmts);
}

/** A sealed token with one byte flipped at `index` (base64 in, base64 out). */
export async function tamperedToken(token: string, index: number, key = TEST_SETTINGS_KEY): Promise<string> {
  const sealed = await sealMetaToken(await importSettingsKey(key), token);
  const bytes = Uint8Array.from(atob(sealed), (ch) => ch.charCodeAt(0));
  bytes[index < 0 ? bytes.length + index : index]! ^= 0x01;
  return btoa(String.fromCharCode(...bytes));
}

/** The settings rows (key → JSON text) the admin would write, token sealed with the test key. */
export async function sealedRows(rows: MetaRows): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (rows.pixelId) out[META_SETTING_KEYS.pixelId] = JSON.stringify(rows.pixelId);
  if (rows.token) out[META_SETTING_KEYS.tokenEnc] = JSON.stringify(await sealMetaToken(await importSettingsKey(rows.key ?? TEST_SETTINGS_KEY), rows.token));
  if (rows.testEventCode) out[META_SETTING_KEYS.testEventCode] = JSON.stringify(rows.testEventCode);
  return out;
}

/** A D1 stand-in for unit tests: answers the settings SELECT from `rows` and records each statement. */
export function fakeSettingsDb(rows: Record<string, string>) {
  const statements: { sql: string; binds: unknown[] }[] = [];
  return {
    statements,
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          statements.push({ sql, binds });
          return {
            async all<T>() {
              return { results: binds.filter((k) => typeof k === 'string' && k in rows).map((k) => ({ key: k, value: rows[k as string] })) as T[] };
            },
          };
        },
      };
    },
  };
}
