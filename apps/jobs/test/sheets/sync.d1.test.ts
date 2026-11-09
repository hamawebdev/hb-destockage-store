// SHEET-2: the sync against the real stand-in and a local D1, with the real migrations. Numbers in
// test names are the contract's checks (artifacts/SHEET-0/contract.md §4).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { importSecretBoxKey } from '@hb/db/secret-box';
import { BATCH_SIZE, runSheetsSync, type SheetsDeps, type SheetsEnv } from '../../src/sheets/run.ts';
import { HEADERS } from '../../src/sheets/columns.ts';
import { sealRefreshToken } from '../../src/sheets/google.ts';
import { localPlatform, type LocalPlatform } from '../helpers/platform.ts';
import { applyMigrations, insertOrders } from '../helpers/schema.ts';
import { startStandin, type Standin, type StandinCall } from './standin-harness.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const EMAIL = 'owner@gmail.com';
const MIN = 60_000;
const REDIRECT = 'http://127.0.0.1:9/sheets/callback';
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';

let p: LocalPlatform<{ DB: D1Database }>;
let s: Standin;
let db: D1Database;
let clock: number;
let env: SheetsEnv;
const deps = (): SheetsDeps => ({ now: () => clock, random: () => 0 });

beforeAll(async () => {
  p = await localPlatform();
  db = p.env.DB;
  await applyMigrations(db);
  s = await startStandin();
});
afterAll(async () => {
  await s?.stop();
  await p?.dispose();
});

async function connectRow(opts: { lang?: 'fr' | 'ar'; email?: string } = {}): Promise<string> {
  const email = opts.email ?? EMAIL;
  await s.post('/consent', { email });
  const auth = new URLSearchParams({ client_id: 'cid', redirect_uri: REDIRECT, response_type: 'code', scope: `openid email ${DRIVE_FILE}`, access_type: 'offline', prompt: 'consent', state: 'st' });
  const location = (await fetch(`${s.url}/o/oauth2/v2/auth?${auth}`, { redirect: 'manual' })).headers.get('location') ?? '';
  const code = new URL(location).searchParams.get('code') ?? '';
  const res = await fetch(`${s.url}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'cid', client_secret: 'sec', grant_type: 'authorization_code', code, redirect_uri: REDIRECT }) });
  const tokens = (await res.json()) as { refresh_token: string };
  const enc = await sealRefreshToken(await importSecretBoxKey(KEY), tokens.refresh_token);
  await db
    .prepare(
      `UPDATE sheets_connection SET status='connected', google_email=?, google_sub='sub-x', refresh_token_enc=?, create_key=?, spreadsheet_id=NULL, tab_id=NULL, lang=?, generation=generation+1,
       failure_count=0, next_attempt_at=NULL, last_error_code=NULL, last_error_at=NULL, layout_note=NULL, scan_fingerprint=NULL, last_scan_at=NULL, lease_owner=NULL, lease_until=NULL, connected_at=?, updated_at=? WHERE id=1`,
    )
    .bind(email, enc, `ck-${crypto.randomUUID()}`, opts.lang ?? 'fr', clock, clock)
    .run();
  return tokens.refresh_token;
}

const conn = async () => (await db.prepare('SELECT * FROM sheets_connection WHERE id=1').first<Record<string, unknown>>())!;
const setConn = (sqlSet: string, ...binds: unknown[]) => db.prepare(`UPDATE sheets_connection SET ${sqlSet} WHERE id=1`).bind(...binds).run();

/** One cron tick, a few minutes after the last, past any backoff or forced-scan window. */
async function tick(extra: SheetsDeps = {}, advance = 20 * MIN): Promise<void> {
  clock += advance;
  await runSheetsSync(env, { ...deps(), ...extra });
}

/** Connect and finish setup; returns the spreadsheet id. */
async function ready(opts: { lang?: 'fr' | 'ar' } = {}): Promise<string> {
  await connectRow(opts);
  await tick();
  const id = (await conn())['spreadsheet_id'] as string;
  expect(id).toBeTruthy();
  await s.post('/calls/clear');
  return id;
}

/** Runs `action` once, immediately before the first request whose URL contains `match`. */
function hookOn(match: string, action: () => Promise<void>): typeof fetch {
  let done = false;
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (!done && String(url).includes(match)) {
      done = true;
      await action();
    }
    return fetch(url, init);
  }) as typeof fetch;
}

const refsInSheet = async () => (await s.sheet()).rows.slice(1).map((r) => r[0]);
const googleCalls = async (): Promise<StandinCall[]> => (await s.calls()).filter((c) => !c.path.startsWith('/__control'));
const bump = (id: number, set: string, ...binds: unknown[]) => {
  clock += 1;
  return db.prepare(`UPDATE orders SET ${set}, version = version + 1, updated_at = ? WHERE id = ?`).bind(...binds, clock, id).run();
};
const rowOf = async (ref: string) => (await s.sheet()).rows.find((r) => r[0] === ref);
const col = (name: string, lang: 'fr' | 'ar' = 'fr') => HEADERS[lang].indexOf(name);

beforeEach(async () => {
  clock = 1_800_000_000_000;
  await s.reset();
  await db.batch([
    db.prepare('DELETE FROM sheets_rows'),
    db.prepare('DELETE FROM sheets_revocations'),
    db.prepare('DELETE FROM shipments'),
    db.prepare('DELETE FROM order_items'),
    db.prepare('DELETE FROM orders'),
    db.prepare(`UPDATE sheets_connection SET status='disconnected', google_email=NULL, google_sub=NULL, refresh_token_enc=NULL, create_key=NULL, spreadsheet_id=NULL, tab_id=NULL, lang=NULL, generation=1, lease_owner=NULL, lease_until=NULL, failure_count=0, next_attempt_at=NULL, last_error_code=NULL, last_error_at=NULL, layout_note=NULL, scan_fingerprint=NULL, last_scan_at=NULL WHERE id=1`),
  ]);
  env = { DB: db, ENV: 'test', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_STANDIN_URL: s.url, COURIER_KEYS_KEY: KEY };
});

afterEach(() => vi.restoreAllMocks());

describe('off state', () => {
  test('6: not connected, no pending revocation: no HTTP, no lease, nothing written', async () => {
    await insertOrders(db, [1, 2]);
    await tick();
    expect(await googleCalls()).toEqual([]);
    expect((await conn())['lease_owner']).toBeNull();
    expect((await db.prepare('SELECT COUNT(*) AS n FROM sheets_rows').first<{ n: number }>())!.n).toBe(0);
  });

  test.each([
    ['client id', { GOOGLE_CLIENT_ID: '' }],
    ['client secret', { GOOGLE_CLIENT_SECRET: '' }],
    ['key', { COURIER_KEYS_KEY: '' }],
    ['bad key', { COURIER_KEYS_KEY: 'bm90LWEta2V5' }],
    ['non-loopback stand-in', { GOOGLE_STANDIN_URL: 'https://sheets.googleapis.com' }],
    ['no stand-in', { GOOGLE_STANDIN_URL: '' }],
  ])('6c: connected but job env incomplete (%s): no HTTP, config_missing, status unchanged', async (_name, over) => {
    await connectRow();
    await s.post('/calls/clear');
    env = { ...env, ...over };
    await tick();
    expect(await googleCalls()).toEqual([]);
    expect(await conn()).toMatchObject({ status: 'connected', last_error_code: 'config_missing' });
  });
});

describe('setup and sync', () => {
  test('creates the sheet, then one row per order with the §3 columns', async () => {
    await insertOrders(db, [1, 2]);
    await connectRow();
    await tick();
    const c = await conn();
    expect(c['spreadsheet_id']).toBeTruthy();
    expect(c['tab_id']).toBe(0);
    expect(c['failure_count']).toBe(0);
    const sheet = await s.sheet();
    expect(sheet).toMatchObject({ tab: 'Commandes', frozenRowCount: 1, rightToLeft: false });
    expect(sheet.rows[0]).toEqual([...HEADERS.fr]);
    expect(sheet.rows).toHaveLength(1); // creation is a run of its own

    await tick();
    const rows = (await s.sheet()).rows;
    expect(rows.map((r) => r[0])).toEqual([HEADERS.fr[0], 'HB-T0001', 'HB-T0002']);
    const row = rows[1]!;
    expect(row[col('Téléphone')]).toBe('0560417403');
    expect(row[col('Code wilaya')]).toBe(16);
    expect(row[col('Wilaya')]).toBe('Alger');
    expect(row[col('Commune')]).toBe('Alger Centre');
    expect(row[col('Produits')]).toBe('Pack cuisine × 1');
    expect(row[col('Quantité')]).toBe(1);
    expect(row[col('Total (DZD)')]).toBe(15400);
    expect(row[col('Statut')]).toBe('Nouvelle');
  });

  test('24: Arabic sheet', async () => {
    await insertOrders(db, [1]);
    await ready({ lang: 'ar' });
    await tick();
    const sheet = await s.sheet();
    expect(sheet).toMatchObject({ tab: 'الطلبات', rightToLeft: true });
    expect(sheet.rows[0]).toEqual([...HEADERS.ar]);
    const row = sheet.rows[1]!;
    expect(row[col('الحالة', 'ar')]).toBe('جديدة');
    expect(row[col('الولاية', 'ar')]).toBe('الجزائر');
    expect(row[col('المنتجات', 'ar')]).toBe('طقم مطبخ × 1');
  });

  test('7: status, tracking and a sync-only parcel update each update the one row', async () => {
    await insertOrders(db, [1]);
    await ready();
    await tick();
    await bump(1, "status = 'confirmed'");
    await tick();
    expect((await rowOf('HB-T0001'))![col('Statut')]).toBe('Confirmée');
    await bump(1, "status = 'shipped', courier_name = 'yalidine', courier_tracking = 'YAL-1'");
    await tick();
    let row = await rowOf('HB-T0001');
    expect(row![col('Statut')]).toBe('Expédiée');
    expect(row![col('Suivi')]).toBe('YAL-1');

    await insertShipment(1, 'in_transit', clock + 1);
    clock += 2;
    await tick();
    row = await rowOf('HB-T0001');
    expect(row![col('État du colis')]).toBe('En transit');
    expect(await refsInSheet()).toEqual(['HB-T0001']);
  });

  test('7a: an order changing mid-run stores the version written, and the next run updates it', async () => {
    await insertOrders(db, [1]);
    await ready();
    clock += 20 * MIN;
    await runSheetsSync(env, { ...deps(), fetch: hookOn('values:batchUpdate', () => bump(1, "status = 'confirmed'").then(() => undefined)) });
    expect(await db.prepare('SELECT source_version FROM sheets_rows WHERE order_id = 1').first()).toEqual({ source_version: 0 });
    await tick();
    expect((await rowOf('HB-T0001'))![col('Statut')]).toBe('Confirmée');
  });

  test('7b: a stamp-only change with the row unchanged writes nothing, advances state and is not reselected', async () => {
    await insertOrders(db, [1]);
    await ready();
    await insertShipment(1, 'in_transit', clock);
    await tick();
    const before = await db.prepare('SELECT shipment_stamp, row_hash FROM sheets_rows WHERE order_id=1').first<{ shipment_stamp: number; row_hash: string }>();
    await s.post('/calls/clear');
    // Same minute and status: the row's values cannot change, only the stamp.
    await db.prepare('UPDATE shipments SET updated_at = updated_at + 1 WHERE order_id = 1').run();
    await tick();
    const calls = await googleCalls();
    expect(calls.filter((c) => c.path.endsWith('values:batchUpdate') || c.path.endsWith(':batchUpdate'))).toEqual([]);
    const after = await db.prepare('SELECT shipment_stamp, row_hash FROM sheets_rows WHERE order_id=1').first<{ shipment_stamp: number; row_hash: string }>();
    expect(after!.shipment_stamp).toBe(before!.shipment_stamp + 1);
    expect(after!.row_hash).toBe(before!.row_hash);
    await s.post('/calls/clear');
    await tick();
    expect(await googleCalls()).toEqual([]);
  });

  test('20: a formula-looking name is sent RAW and stored as text', async () => {
    await insertOrders(db, [1]);
    await db.prepare(`UPDATE orders SET name = '=IMPORTXML("http://x","//a")' WHERE id = 1`).run();
    await ready();
    await tick();
    const row = await rowOf('HB-T0001');
    expect(row![col('Client')]).toBe('=IMPORTXML("http://x","//a")');
    const write = (await googleCalls()).find((c) => c.path.endsWith('values:batchUpdate'));
    expect((write!.body as { valueInputOption: string }).valueInputOption).toBe('RAW');
    expect(JSON.stringify((await s.sheet()).rows)).not.toContain('"formula"');
  });

  test('strings are capped at 1,000 characters', async () => {
    await insertOrders(db, [1]);
    await db.prepare('UPDATE orders SET address = ? WHERE id = 1').bind('x'.repeat(5000)).run();
    await ready();
    await tick();
    expect(((await rowOf('HB-T0001'))![col('Adresse')] as string).length).toBe(1000);
  });

  test('re-seals a rotated refresh token', async () => {
    await insertOrders(db, [1]);
    await ready();
    await s.post('/settings', { rotateRefresh: true });
    const before = (await conn())['refresh_token_enc'];
    await tick();
    expect((await conn())['refresh_token_enc']).not.toBe(before);
    await tick();
    await bump(1, "status = 'confirmed'");
    await tick();
    expect((await rowOf('HB-T0001'))![col('Statut')]).toBe('Confirmée');
  });
});

describe('backoff and failures', () => {
  test('9: down over several runs, then up: backoff respected, rows once, counters reset', async () => {
    await insertOrders(db, [1, 2]);
    await ready();
    await s.mode({ path: '', mode: 'down' });
    clock += 20 * MIN;
    await runSheetsSync(env, deps());
    let c = await conn();
    expect(c).toMatchObject({ failure_count: 1, last_error_code: 'network' });
    expect(c['next_attempt_at']).toBe(clock + 4 * MIN);
    await s.post('/calls/clear');
    clock += 3 * MIN;
    await runSheetsSync(env, deps());
    expect(await googleCalls()).toEqual([]);
    clock += 2 * MIN;
    await runSheetsSync(env, deps());
    c = await conn();
    expect(c['failure_count']).toBe(2);
    expect(c['next_attempt_at']).toBe(clock + 8 * MIN);
    await s.post('/mode/clear');
    await tick();
    expect(await refsInSheet()).toEqual(['HB-T0001', 'HB-T0002']);
    expect(await conn()).toMatchObject({ failure_count: 0, next_attempt_at: null, last_error_code: null });
  });

  test('backoff is capped at 60 minutes plus jitter', async () => {
    await insertOrders(db, [1]);
    await ready();
    await setConn('failure_count = 20');
    await s.mode({ path: '', mode: 'down' });
    clock += 20 * MIN;
    await runSheetsSync(env, { ...deps(), random: () => 0.999 });
    const c = await conn();
    expect(c['next_attempt_at'] as number).toBeLessThanOrEqual(clock + 60 * MIN + 30_000);
    expect(c['next_attempt_at'] as number).toBeGreaterThanOrEqual(clock + 60 * MIN);
  });

  test.each([
    ['seconds', '600', 600_000],
    ['huge is capped', '99999999', 3_600_000],
    ['garbage is ignored', 'soon-ish', 0],
  ])('10: Retry-After %s', async (_name, retryAfter, expected) => {
    await insertOrders(db, [1]);
    await ready();
    await s.mode({ path: '/v4/', mode: '429', retryAfter, times: 1 });
    clock += 20 * MIN;
    await runSheetsSync(env, deps());
    const c = await conn();
    expect(c['status']).toBe('connected');
    expect(Number.isFinite(c['next_attempt_at'])).toBe(true);
    expect(c['next_attempt_at']).toBe(clock + Math.max(4 * MIN, expected));
  });

  test('10: Retry-After as an HTTP date', async () => {
    await insertOrders(db, [1]);
    await ready();
    clock = Date.now();
    await s.mode({ path: '/v4/', mode: '429', retryAfter: new Date(clock + 600_000).toUTCString(), times: 1 });
    await runSheetsSync(env, { random: () => 0, now: () => clock });
    const next = (await conn())['next_attempt_at'] as number;
    expect(next).toBeGreaterThanOrEqual(clock + 590_000);
    expect(next).toBeLessThanOrEqual(clock + 610_000);
  });

  test('10: Drive 403 rate-limit backs off, not needs_reconnect', async () => {
    await insertOrders(db, [1]);
    await ready();
    await s.mode({ path: '/drive/', mode: '403rate', times: 1 });
    clock += 20 * MIN;
    await runSheetsSync(env, deps());
    expect(await conn()).toMatchObject({ status: 'connected', last_error_code: 'rate_limited' });
  });

  test.each([
    ['HTML 502', 'nonJson', 'server_error'],
    ['truncated JSON on 200', 'truncatedJson', 'bad_response'],
  ])('10a: %s at the token endpoint', async (_name, mode, code) => {
    await insertOrders(db, [1]);
    await ready();
    await s.mode({ path: '/token', mode, times: 1 });
    clock += 20 * MIN;
    await runSheetsSync(env, deps());
    expect(await conn()).toMatchObject({ status: 'connected', last_error_code: code, failure_count: 1 });
  });

  test('10a: 200 without access_token is bad_response; invalid_client is operator config', async () => {
    await insertOrders(db, [1]);
    await ready();
    await s.post('/claims', { omit: ['access_token'] });
    clock += 20 * MIN;
    await runSheetsSync(env, deps());
    expect((await conn())['last_error_code']).toBe('bad_response');
    await s.post('/claims', {});
    await s.mode({ path: '/token', mode: 'tokenError', value: 'invalid_client', times: 1 });
    clock += 60 * MIN;
    await runSheetsSync(env, deps());
    expect(await conn()).toMatchObject({ status: 'connected', last_error_code: 'google_client_config' });
  });

  test('10b: a refresh token that will not open: needs_reconnect, no call, no crash', async () => {
    await insertOrders(db, [1]);
    await ready();
    await setConn('refresh_token_enc = ?', 'AAAA.BBBB');
    await s.post('/calls/clear');
    await tick();
    expect(await conn()).toMatchObject({ status: 'needs_reconnect', last_error_code: 'token_unreadable' });
    expect(await googleCalls()).toEqual([]);
  });

  test('21: real hosts are refused by the guard outside production; the failure is recorded', async () => {
    await insertOrders(db, [1]);
    await ready();
    const endpoints = { auth: 'https://accounts.google.com/x', token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke', sheets: 'https://sheets.googleapis.com/v4/spreadsheets', drive: 'https://www.googleapis.com/drive/v3/files' };
    const spy = vi.fn(globalThis.fetch);
    for (const ENV of ['development', 'test', '', undefined]) {
      await setConn('next_attempt_at = NULL, failure_count = 0');
      const { ENV: _drop, ...rest } = env;
      clock += 20 * MIN;
      await runSheetsSync(ENV === undefined ? rest : { ...rest, ENV }, { ...deps(), endpoints, fetch: spy });
      expect(await conn()).toMatchObject({ status: 'connected', last_error_code: 'guard_refused' });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  test('21a: a redirect to a real host is not followed', async () => {
    await insertOrders(db, [1]);
    await ready();
    await s.mode({ path: '/token', mode: 'redirect', value: 'https://sheets.googleapis.com/x', times: 1 });
    await tick();
    expect((await conn())['last_error_code']).toBe('redirect');
  });

  test('22: production uses the real hosts and ignores the stand-in', async () => {
    await insertOrders(db, [1]);
    await ready();
    const seen: string[] = [];
    const fake = (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }) as typeof fetch;
    clock += 20 * MIN;
    await runSheetsSync({ ...env, ENV: 'production' }, { ...deps(), fetch: fake });
    expect(seen).toEqual(['https://oauth2.googleapis.com/token']);
  });

  test('run budget stops a slow run with a backoff', async () => {
    await insertOrders(db, [1]);
    await ready();
    let t = clock + 20 * MIN;
    await runSheetsSync(env, { random: () => 0, runBudgetMs: 1000, now: () => (t += 700) });
    expect((await conn())['last_error_code']).toBe('run_budget');
  });

  test('a timeout on one request backs off', async () => {
    await insertOrders(db, [1]);
    await ready();
    await s.mode({ path: '/v4/', mode: 'slow', value: 400, times: 1 });
    await tick({ timeoutMs: 100 });
    expect(await conn()).toMatchObject({ status: 'connected', last_error_code: 'timeout' });
  });
});

async function insertShipment(orderId: number, status: string, updatedAt: number): Promise<void> {
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO admin_users (id, email, name, role, active, ui_lang) VALUES (900, 'ops@test.local', 'Ops', 'owner', 1, 'fr')`),
    db.prepare(`INSERT OR IGNORE INTO courier_accounts (id, courier) VALUES (900, 'yalidine')`),
    db
      .prepare(
        `INSERT INTO shipments (order_id, courier, account_id, state, reference, tracking, courier_status, cod_amount_dzd, fee_dzd, wilaya_code, commune_id, applied_at, created_by, created_at, updated_at)
         VALUES (?1, 'yalidine', 900, 'accepted', 'ref', ?2, ?3, 15400, 400, 16, 1601, ?4, 900, ?4, ?4)`,
      )
      .bind(orderId, `TRK-${orderId}-${updatedAt}`, status, updatedAt),
  ]);
}

describe('manual changes', () => {
  async function withRows(): Promise<string> {
    await insertOrders(db, [1, 2, 3]);
    const id = await ready();
    await tick();
    await s.post('/calls/clear');
    return id;
  }

  test('11: sort, hide, filter, edit, rename, insert column, reorder: no new rows, the right rows change', async () => {
    await withRows();
    await s.action({ action: 'sort', column: 1, desc: true });
    await s.action({ action: 'hide', row: 2 });
    await s.action({ action: 'filter', column: 2, equals: 'x' });
    await s.action({ action: 'edit', row: 2, column: 3, value: 'typed by hand' });
    await s.action({ action: 'renameTab', to: 'Mes commandes' });
    await s.action({ action: 'insertColumn', at: 1, header: 'Mes notes' });
    await s.action({ action: 'moveColumn', from: 4, to: 3 });
    await bump(2, "status = 'confirmed'");
    await tick();
    const sheet = await s.sheet();
    expect(sheet.rows).toHaveLength(4);
    const header = sheet.rows[0] as string[];
    const refCol = header.indexOf(HEADERS.fr[0]!);
    const statusCol = header.indexOf('Statut');
    expect(refCol).toBe(1);
    const row2 = sheet.rows.find((r) => r[refCol] === 'HB-T0002')!;
    expect(row2[statusCol]).toBe('Confirmée');
    expect(row2[0]).toBeNull(); // the added column is untouched
    expect(sheet.rows.filter((r) => r[refCol] === 'HB-T0001')).toHaveLength(1);
    expect(sheet.rows.filter((r) => r[refCol] === 'HB-T0003')[0]![statusCol]).toBe('Nouvelle');
    expect((await googleCalls()).some((c) => c.path.endsWith(':batchUpdate') && !c.path.endsWith('values:batchUpdate'))).toBe(false);
  });

  test('11a: a totals row and a formula below the data survive new orders, pushed down', async () => {
    await withRows();
    const before = (await s.sheet()).rows.length;
    await s.action({ action: 'edit', row: before + 1, column: 2, value: 'TOTAL' });
    await s.action({ action: 'edit', row: before + 1, column: 11, value: 12345 });
    await s.action({ action: 'edit', row: before + 3, column: 11, value: '=SUM(K2:K4)', formula: true });
    await insertOrders(db, [4, 5]);
    await tick();
    const rows = (await s.sheet()).rows;
    const totalAt = rows.findIndex((r) => r[1] === 'TOTAL');
    expect(rows[totalAt]![10]).toBe(12345);
    expect(rows.findIndex((r) => r[0] === 'HB-T0004')).toBeLessThan(totalAt);
    expect(rows.flat().filter((c) => typeof c === 'object' && c !== null)).toEqual([{ formula: '=SUM(K2:K4)' }]);
    expect(rows.map((r) => r[0]).filter((r) => r === 'HB-T0004')).toHaveLength(1);
  });

  test('11b: a deleted row returns on its next change and on resync; a hand copy is updated, never deleted', async () => {
    await withRows();
    await s.action({ action: 'deleteRow', row: 2 });
    expect(await refsInSheet()).toEqual(['HB-T0002', 'HB-T0003']);
    await bump(1, "status = 'confirmed'");
    await tick();
    expect((await refsInSheet()).sort()).toEqual(['HB-T0001', 'HB-T0002', 'HB-T0003']);

    await s.action({ action: 'duplicateRow', row: 2 });
    const target = await refsInSheet();
    await bump(2, "status = 'cancelled'");
    await tick();
    const after = await refsInSheet();
    expect(after).toHaveLength(target.length);
    const copies = (await s.sheet()).rows.filter((r) => r[0] === 'HB-T0002');
    expect(copies).toHaveLength(2);
    expect(copies.every((r) => r[col('Statut')] === 'Annulée')).toBe(true);

    await s.action({ action: 'deleteRow', row: 2 });
    await setConn('generation = generation + 1, scan_fingerprint = NULL, failure_count = 0, next_attempt_at = NULL');
    await tick();
    expect(new Set(await refsInSheet())).toEqual(new Set(['HB-T0001', 'HB-T0002', 'HB-T0003']));
  });

  test('11c: non-ref header renamed: column skipped and named; rest still written', async () => {
    await withRows();
    await s.action({ action: 'renameHeader', column: 3, to: 'Nom du client' });
    await bump(1, "name = 'Nouveau', status = 'confirmed'");
    await tick();
    const row = await rowOf('HB-T0001');
    expect(row![2]).toBe('Test Client'); // skipped
    expect(row![col('Statut')]).toBe('Confirmée');
    expect((await conn())['layout_note']).toBe('Client');
  });

  test('11c: columns deleted: no write past the grid, remaining columns still written', async () => {
    await withRows();
    await s.action({ action: 'deleteColumn', at: 19 });
    await s.action({ action: 'deleteColumn', at: 18 });
    await bump(1, "status = 'confirmed'");
    await tick();
    expect(await conn()).toMatchObject({ status: 'connected', last_error_code: null });
    expect((await rowOf('HB-T0001'))![col('Statut')]).toBe('Confirmée');
  });

  test.each([
    ['ref header renamed', { action: 'renameHeader', column: 1, to: 'Code' }],
    ['ref header duplicated', { action: 'duplicateHeader', column: 1, to: 25 }],
    ['row inserted above the header', { action: 'insertRowAbove', row: 1 }],
  ])('16/11c: %s: layout_changed and no writes', async (_name, change) => {
    await withRows();
    await s.action(change);
    await bump(1, "status = 'confirmed'");
    await s.post('/calls/clear');
    await tick();
    expect(await conn()).toMatchObject({ status: 'layout_changed', last_error_code: 'ref_header' });
    expect((await googleCalls()).some((c) => c.method === 'POST' && c.path.includes('/v4/'))).toBe(false);
  });

  test('11d: a sort armed after the ref read re-queues what it lost, and no fingerprint is stored', async () => {
    await withRows();
    const fpBefore = (await conn())['scan_fingerprint'];
    await bump(1, "status = 'confirmed'");
    await s.post('/arm', { path: 'values:batchUpdate', action: 'deleteRow', row: 3 });
    await tick();
    expect((await conn())['scan_fingerprint']).toBe(fpBefore);
    const state = await db.prepare('SELECT order_id FROM sheets_rows ORDER BY order_id').all<{ order_id: number }>();
    expect(state.results.map((r) => r.order_id)).not.toContain(2);
    await s.post('/mode/clear');
    await tick();
    expect(new Set(await refsInSheet())).toEqual(new Set(['HB-T0001', 'HB-T0002', 'HB-T0003']));
  });

  test('11d: a column inserted after the read re-queues the batch and stores no fingerprint', async () => {
    await withRows();
    const fpBefore = (await conn())['scan_fingerprint'];
    await bump(1, "status = 'confirmed'");
    await s.post('/arm', { path: 'values:batchUpdate', action: 'insertColumn', at: 1, header: 'Notes' });
    await tick();
    expect(await db.prepare('SELECT 1 FROM sheets_rows WHERE order_id = 1').first()).toBeNull();
    expect((await conn())['scan_fingerprint']).toBe(fpBefore);
    await tick();
    const header = (await s.sheet()).rows[0] as string[];
    const statusCol = header.indexOf('Statut');
    const refCol = header.indexOf(HEADERS.fr[0]!);
    expect((await s.sheet()).rows.find((r) => r[refCol] === 'HB-T0001')![statusCol]).toBe('Confirmée');
  });

  test('re-read failure records confirmed rows and backs off', async () => {
    await insertOrders(db, [1]);
    await ready();
    let batchGets = 0;
    const counting = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('values:batchGet') && ++batchGets === 3) throw new TypeError('fetch failed');
      return fetch(url, init);
    }) as typeof fetch;
    await tick({ fetch: counting });
    expect(await refsInSheet()).toEqual(['HB-T0001']);
    expect(await db.prepare('SELECT 1 AS ok FROM sheets_rows WHERE order_id = 1').first()).toEqual({ ok: 1 });
    expect(await conn()).toMatchObject({ failure_count: 1, last_error_code: 'network' });
  });
});

describe('lease', () => {
  test('12: two runs at the write step: one takes the lease, the other exits', async () => {
    await insertOrders(db, [1, 2]);
    await ready();
    let callsDuringSecondRun = -1;
    clock += 20 * MIN;
    await runSheetsSync(env, {
      ...deps(),
      fetch: hookOn('values:batchUpdate', async () => {
        const before = (await googleCalls()).length;
        await runSheetsSync(env, deps());
        callsDuringSecondRun = (await googleCalls()).length - before;
      }),
    });
    expect(callsDuringSecondRun).toBe(0);
    expect(await refsInSheet()).toEqual(['HB-T0001', 'HB-T0002']);
    expect((await conn())['lease_owner']).toBeNull();
  });

  test('12: two runs at the creation step make one spreadsheet', async () => {
    await connectRow();
    clock += MIN;
    await runSheetsSync(env, { ...deps(), fetch: hookOn('/drive/v3/files?fields=id', () => runSheetsSync(env, deps())) });
    expect((await s.state()).files).toHaveLength(1);
  });

  test('12: an expired lease is reclaimed; a live one is not', async () => {
    await insertOrders(db, [1]);
    await ready();
    await setConn('lease_owner = ?, lease_until = ?', 'other', clock + 25 * MIN);
    await s.post('/calls/clear');
    await tick();
    expect(await googleCalls()).toEqual([]);
    expect((await conn())['lease_owner']).toBe('other');
    await setConn('lease_until = ?', clock - 1);
    await tick();
    expect(await refsInSheet()).toEqual(['HB-T0001']);
  });

  test('12: a lost lease stops writes, nothing from the run counts', async () => {
    await insertOrders(db, [1]);
    await ready();
    clock += 20 * MIN;
    await runSheetsSync(env, { ...deps(), fetch: hookOn('/token', () => setConn('lease_owner = ?', 'thief').then(() => undefined)) });
    expect((await googleCalls()).filter((c) => c.path.endsWith('values:batchUpdate'))).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM sheets_rows').first()).toEqual({ n: 0 });
    expect((await conn())['lease_owner']).toBe('thief');
  });

  test('19: disconnect, and resync, during a run stop it and nothing from it counts', async () => {
    await insertOrders(db, [1]);
    await ready();
    clock += 20 * MIN;
    await runSheetsSync(env, { ...deps(), fetch: hookOn('/token', () => setConn('generation = generation + 1').then(() => undefined)) });
    expect((await googleCalls()).filter((c) => c.path.endsWith('values:batchUpdate'))).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM sheets_rows').first()).toEqual({ n: 0 });

    clock += 20 * MIN;
    await runSheetsSync(env, { ...deps(), fetch: hookOn('/token', () => setConn("status = 'disconnected'").then(() => undefined)) });
    expect((await googleCalls()).filter((c) => c.path.endsWith('values:batchUpdate'))).toEqual([]);
  });
});

describe('idempotence', () => {
  test('13: a write applied but its response dropped: next run, same row, no duplicate', async () => {
    await insertOrders(db, [1, 2]);
    await ready();
    await s.mode({ path: 'values:batchUpdate', mode: 'applyThenDrop', times: 1 });
    await tick();
    expect(await conn()).toMatchObject({ failure_count: 1, last_error_code: 'network' });
    expect(await refsInSheet()).toEqual(['HB-T0001', 'HB-T0002']);
    await tick();
    expect(await refsInSheet()).toEqual(['HB-T0001', 'HB-T0002']);
    expect((await conn())['failure_count']).toBe(0);
  });

  test('14: Drive create applied but dropped: the next run adopts it', async () => {
    await connectRow();
    await s.mode({ path: '/drive/v3/files', method: 'POST', mode: 'applyThenDrop', times: 1 });
    await tick();
    expect((await conn())['spreadsheet_id']).toBeNull();
    expect((await s.state()).files).toHaveLength(1);
    await tick();
    expect((await s.state()).files).toHaveLength(1);
    expect((await conn())['spreadsheet_id']).toBe((await s.state()).files[0]!.id);
    expect((await s.sheet()).rows[0]).toEqual([...HEADERS.fr]);
  });

  test('14: two files with the same create_key: adopt the oldest, delete nothing', async () => {
    await connectRow();
    const key = (await conn())['create_key'] as string;
    // Two prior creates under this key.
    const at = ((await (await fetch(`${s.url}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'cid', client_secret: 'sec', grant_type: 'refresh_token', refresh_token: await currentRefresh() }) })).json()) as { access_token: string }).access_token;
    const create = async () => (await (await fetch(`${s.url}/drive/v3/files?fields=id`, { method: 'POST', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', mimeType: 'application/vnd.google-apps.spreadsheet', appProperties: { hb_create_key: key } }) })).json() as { id: string }).id;
    const oldest = await create();
    await create();
    await tick();
    expect((await conn())['spreadsheet_id']).toBe(oldest);
    expect((await s.state()).files).toHaveLength(2);
  });

  test('23/23a: a 900-order backlog: three runs of 300, each row once, ascending; never more than 100 binds', async () => {
    const ids = Array.from({ length: 900 }, (_, i) => i + 1);
    for (let i = 0; i < 900; i += 200) await insertOrders(db, ids.slice(i, i + 200));
    await ready();
    let maxBinds = 0;
    const spying = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            return new Proxy(stmt, {
              get(s2, p2) {
                if (p2 === 'bind') return (...args: unknown[]) => { maxBinds = Math.max(maxBinds, args.length); return s2.bind(...args); };
                const v = Reflect.get(s2, p2);
                return typeof v === 'function' ? v.bind(s2) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as D1Database;
    const spied = { ...env, DB: spying };
    clock += MIN;
    await runSheetsSync(spied, deps());
    expect(await refsInSheet()).toEqual(ids.slice(0, BATCH_SIZE).map((i) => `HB-T${String(i).padStart(4, '0')}`));
    clock += MIN;
    await runSheetsSync(spied, deps());
    clock += MIN;
    await runSheetsSync(spied, deps());
    const refs = await refsInSheet();
    expect(refs).toEqual(ids.map((i) => `HB-T${String(i).padStart(4, '0')}`));
    expect(maxBinds).toBeLessThanOrEqual(100);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM sheets_rows').first()).toEqual({ n: 900 });
  });
});

async function currentRefresh(): Promise<string> {
  const { openRefreshToken } = await import('../../src/sheets/google.ts');
  return openRefreshToken(await importSecretBoxKey(KEY), (await conn())['refresh_token_enc'] as string);
}

describe('connection problems', () => {
  test('15: refresh token revoked: needs_reconnect, no retries; reconnect resumes the sheet (files visible)', async () => {
    await insertOrders(db, [1]);
    const id = await ready();
    await s.post('/revoke', { email: EMAIL });
    await tick();
    expect(await conn()).toMatchObject({ status: 'needs_reconnect', last_error_code: 'invalid_grant' });
    await s.post('/calls/clear');
    await tick();
    expect(await googleCalls()).toEqual([]);
    const { refresh_token: fresh } = await reauth();
    const c = await conn();
    await setConn(`status='connected', refresh_token_enc=?`, await sealRefreshToken(await importSecretBoxKey(KEY), fresh));
    await tick();
    expect((await conn())['spreadsheet_id']).toBe(id);
    expect(c['spreadsheet_id']).toBe(id);
    expect(await refsInSheet()).toEqual(['HB-T0001']);
  });

  test('15b: reconnect after a revoke that dropped file visibility: sheet_lost', async () => {
    await insertOrders(db, [1]);
    await ready();
    await s.post('/revoke', { email: EMAIL, dropFiles: true });
    const { refresh_token: fresh } = await reauth();
    await setConn(`refresh_token_enc=?`, await sealRefreshToken(await importSecretBoxKey(KEY), fresh));
    await tick();
    expect(await conn()).toMatchObject({ status: 'sheet_lost', last_error_code: 'not_found' });
  });

  test('16: trashed and 404: sheet_lost; restore then resync returns to connected', async () => {
    await insertOrders(db, [1]);
    const id = await ready();
    await s.action({ action: 'trash', id });
    await tick();
    expect(await conn()).toMatchObject({ status: 'sheet_lost', last_error_code: 'trashed' });

    await s.action({ action: 'restore', id });
    await setConn("status = 'connected', generation = generation + 1, failure_count = 0, next_attempt_at = NULL");
    await tick();
    expect(await conn()).toMatchObject({ status: 'connected', last_error_code: null });
    expect(await refsInSheet()).toEqual(['HB-T0001']);

    await s.mode({ path: '/v4/', mode: '404', times: 1 });
    await bump(1, "status='confirmed'");
    await tick();
    expect(await conn()).toMatchObject({ status: 'sheet_lost', last_error_code: 'not_found' });
  });

  test('16: trashed with its tab also deleted: sheet_lost, no tab added, nothing refilled', async () => {
    await insertOrders(db, [1]);
    const id = await ready();
    await tick();
    const before = await conn();
    await s.action({ action: 'addTab', title: 'x' });
    await s.action({ action: 'deleteTab', tab: 'Commandes' });
    await s.action({ action: 'trash', id });
    await bump(1, "status='confirmed'");
    await s.post('/calls/clear');
    await tick();
    expect(await conn()).toMatchObject({ status: 'sheet_lost', last_error_code: 'trashed', generation: before['generation'], tab_id: before['tab_id'] });
    expect((await s.state()).files[0]!.tabs).toEqual(['x']);
    expect((await googleCalls()).filter((c) => c.method === 'POST' && c.path !== '/token')).toEqual([]);
  });

  test('16: tab deleted: new tab, new tab_id, refilled; a second tab holding our title', async () => {
    await insertOrders(db, [1, 2]);
    await ready();
    await tick();
    const genBefore = (await conn())['generation'] as number;
    await s.action({ action: 'addTab', title: 'Commandes 2' });
    await s.action({ action: 'addTab', title: 'x' });
    await s.action({ action: 'deleteTab', tab: 'Commandes' });
    await bump(1, "status = 'confirmed'");
    await tick();
    const c = await conn();
    expect(c['generation']).toBe(genBefore + 1);
    expect(c['tab_id']).not.toBe(0);
    expect(c['status']).toBe('connected');
    await tick();
    const sheet = await s.sheet('?tab=Commandes');
    expect(sheet.rows[0]).toEqual([...HEADERS.fr]);
    expect(sheet.rows.slice(1).map((r) => r[0])).toEqual(['HB-T0001', 'HB-T0002']);
    expect(c['last_error_code']).toBeNull();
  });

  test('16: free title when ours is taken by another tab', async () => {
    await insertOrders(db, [1]);
    await ready();
    await s.action({ action: 'addTab', title: 'keep' });
    await s.action({ action: 'deleteTab', tab: 'Commandes' });
    await s.action({ action: 'renameTab', tab: 'keep', to: 'Commandes' });
    await bump(1, "status = 'confirmed'");
    await tick();
    expect((await s.sheet('?tab=Commandes 2')).rows[0]).toEqual([...HEADERS.fr]);
  });

  test('16b: reconnect with spreadsheet_id NULL after a timed-out create adopts the same file', async () => {
    await connectRow();
    await s.mode({ path: '/drive/v3/files', method: 'POST', mode: 'applyThenDrop', times: 1 });
    await tick();
    expect((await conn())['spreadsheet_id']).toBeNull();
    await setConn(`status = 'needs_reconnect'`);
    const key = (await conn())['create_key'];
    await setConn(`status = 'connected', failure_count = 0, next_attempt_at = NULL`);
    await tick();
    expect((await s.state()).files).toHaveLength(1);
    expect((await conn())['create_key']).toBe(key);
  });

  test.each([
    ['down', 'down'],
    ['applyThenDrop', 'applyThenDrop'],
  ])('16d: %s at the creation steps: setup completes, one file, never layout_changed', async (_name, mode) => {
    await insertOrders(db, [1]);
    for (const path of [':batchUpdate', 'values:batchUpdate']) {
      await db.batch([db.prepare('DELETE FROM sheets_rows')]);
      await s.reset();
      await connectRow();
      await s.mode({ path, method: 'POST', mode, times: 1 });
      await tick();
      expect((await conn())['failure_count']).toBe(1);
      await tick();
      await tick();
      const c = await conn();
      expect(c['status']).toBe('connected');
      expect(c['failure_count']).toBe(0);
      const sheet = await s.sheet();
      expect(sheet.rows[0]).toEqual([...HEADERS.fr]);
      expect((await s.state()).files).toHaveLength(1);
    }
  });

  test.each([
    ['down', 'down'],
    ['applyThenDrop', 'applyThenDrop'],
  ])('16d: %s at the tab-recreation header step: repaired on a later run', async (_name, mode) => {
    await insertOrders(db, [1]);
    await ready();
    await tick();
    await s.action({ action: 'addTab', title: 'x' });
    await s.action({ action: 'deleteTab', tab: 'Commandes' });
    await bump(1, "status = 'confirmed'");
    await s.mode({ path: 'values:batchUpdate', method: 'POST', mode, times: 1 });
    await tick();
    expect((await conn())['status']).toBe('connected');
    await tick();
    await tick();
    expect((await conn())['status']).toBe('connected');
    const sheet = await s.sheet('?tab=Commandes');
    expect(sheet.rows[0]).toEqual([...HEADERS.fr]);
    expect(sheet.frozenRowCount).toBe(1);
    expect(sheet.rows.slice(1).map((r) => r[0])).toEqual(['HB-T0001']);
  });

  test.each([
    ['down', 'down'],
    ['applyThenDrop', 'applyThenDrop'],
  ])('16d: %s at the tab-recreation addSheet step: repaired on a later run, one file, rows once', async (_name, mode) => {
    await insertOrders(db, [1]);
    await ready();
    await tick();
    await s.action({ action: 'addTab', title: 'x' });
    await s.action({ action: 'deleteTab', tab: 'Commandes' });
    await bump(1, "status = 'confirmed'");
    await s.mode({ path: ':batchUpdate', method: 'POST', mode, times: 1 });
    await tick();
    expect((await conn())['failure_count']).toBe(1);
    await tick();
    await tick();
    const c = await conn();
    expect(c['status']).toBe('connected');
    expect(c['failure_count']).toBe(0);
    const files = (await s.state()).files;
    expect(files).toHaveLength(1);
    // A dropped addSheet that Google applied leaves an empty `Commandes`; the retry adds `Commandes 2`.
    const tabs = files[0]!.tabs.filter((t) => t !== 'x');
    expect(tabs).toEqual(mode === 'down' ? ['Commandes'] : ['Commandes', 'Commandes 2']);
    const live = await s.sheet(`?tab=${encodeURIComponent(tabs.at(-1)!)}`);
    expect(live.sheetId).toBe(c['tab_id']);
    expect(live.rows[0]).toEqual([...HEADERS.fr]);
    expect(live.rows.slice(1).map((r) => r[0])).toEqual(['HB-T0001']);
  });

  test('a header cleared by hand with rows below is layout_changed, not a new header', async () => {
    await insertOrders(db, [1]);
    await ready();
    await tick();
    for (let c = 1; c <= 19; c++) await s.action({ action: 'edit', row: 1, column: c, value: '' });
    await bump(1, "status = 'confirmed'");
    await tick();
    expect((await conn())['status']).toBe('layout_changed');
    expect((await s.sheet()).rows[0]!.every((cell) => cell === null || cell === '')).toBe(true);
  });

  test('an empty tab with an empty row 1 gets its header and freeze back', async () => {
    await insertOrders(db, [1]);
    await ready();
    await s.action({ action: 'addTab', title: 'autre' });
    for (let c = 1; c <= 19; c++) await s.action({ action: 'edit', tab: 'Commandes', row: 1, column: c, value: '' });
    await tick();
    expect((await conn())['status']).toBe('connected');
    const sheet = await s.sheet('?tab=Commandes');
    expect(sheet.rows[0]).toEqual([...HEADERS.fr]);
    expect(sheet.frozenRowCount).toBe(1);
  });

  async function reauth(): Promise<{ refresh_token: string }> {
    await s.post('/consent', { email: EMAIL });
    const q = new URLSearchParams({ client_id: 'cid', redirect_uri: REDIRECT, response_type: 'code', scope: `openid email ${DRIVE_FILE}`, access_type: 'offline', prompt: 'consent', state: 'st' });
    const location = (await fetch(`${s.url}/o/oauth2/v2/auth?${q}`, { redirect: 'manual' })).headers.get('location') ?? '';
    const code = new URL(location).searchParams.get('code') ?? '';
    return (await (await fetch(`${s.url}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'cid', client_secret: 'sec', grant_type: 'authorization_code', code, redirect_uri: REDIRECT }) })).json()) as { refresh_token: string };
  }
});

describe('revocations', () => {
  const seal = async (token: string) => sealRefreshToken(await importSecretBoxKey(KEY), token);
  const addRevocation = async (enc: string, sub = 'sub-1') => db.prepare('INSERT INTO sheets_revocations (token_enc, google_sub, created_at) VALUES (?, ?, 1)').bind(enc, sub).run();
  const revocations = async () => (await db.prepare('SELECT id, attempts, next_attempt_at FROM sheets_revocations').all()).results;

  test('17: revoke runs while disconnected, with stand-in down retries with its own backoff, then completes', async () => {
    const live = await connectRow();
    await setConn(`status='disconnected', refresh_token_enc=NULL`);
    await addRevocation(await seal(live));
    await s.mode({ path: '', mode: 'down' });
    await tick();
    let rows = await revocations();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 1, next_attempt_at: clock + 15 * MIN });
    await s.post('/calls/clear');
    clock += 5 * MIN;
    await runSheetsSync(env, deps());
    expect(await googleCalls()).toEqual([]);
    await s.post('/mode/clear');
    await tick();
    rows = await revocations();
    expect(rows).toEqual([]);
    expect((await s.state()).liveRefreshTokens).toBe(0);
    expect((await conn())['lease_owner']).toBeNull();
  });

  test('17a: abandoned after 8 attempts; invalid_token counts as done', async () => {
    const live = await connectRow();
    await setConn(`status='disconnected', refresh_token_enc=NULL`);
    await addRevocation(await seal(live));
    await db.prepare('UPDATE sheets_revocations SET attempts = 7').run();
    await s.mode({ path: '/revoke', mode: '500' });
    await tick();
    expect(await revocations()).toEqual([]);
    expect((await conn())['last_error_code']).toBe('revoke_abandoned');
    await s.post('/mode/clear');

    await addRevocation(await seal('standin-rt-already-dead'));
    await tick();
    expect(await revocations()).toEqual([]);
  });

  test('19c: a revocation whose token will not open is deleted at once, abandoned', async () => {
    await addRevocation('AAAA.BBBB');
    await tick();
    expect(await revocations()).toEqual([]);
    expect((await conn())['last_error_code']).toBe('revoke_abandoned');
    expect(await googleCalls()).toEqual([]);
  });

  test('at most 2 revocations per run', async () => {
    for (const t of ['a', 'b', 'c']) await addRevocation(await seal(`standin-rt-${t}`));
    await tick();
    expect(await revocations()).toHaveLength(1);
  });

  test('19: no sync writes while disconnected even with a revocation pending', async () => {
    await insertOrders(db, [1]);
    const live = await connectRow();
    await setConn(`status='disconnected', refresh_token_enc=NULL`);
    await addRevocation(await seal(live));
    await s.post('/calls/clear');
    await tick();
    const calls = await googleCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.path === '/revoke')).toBe(true);
  });

  test('18b: job read a revocation, same account reconnects, revoke lands: invalid_grant then needs_reconnect', async () => {
    await insertOrders(db, [1]);
    const live = await connectRow();
    await tick();
    await addRevocation(await seal(live));
    await tick();
    expect(await conn()).toMatchObject({ status: 'needs_reconnect', last_error_code: 'invalid_grant' });
  });
});

describe('request budget (23c)', () => {
  const calls = async () => (await googleCalls()).length;

  test('first run with a backlog: setup alone is at most 6 calls', async () => {
    await insertOrders(db, [1, 2, 3]);
    await connectRow();
    await s.post('/calls/clear');
    await tick();
    expect(await calls()).toBeLessThanOrEqual(6);
    await s.post('/calls/clear');
    await tick();
    const n = await calls();
    expect(n).toBeLessThanOrEqual(8);
    expect(n).toBeGreaterThan(0);
  });

  test('tab recreation is at most 6 and a run of its own; revocations add at most 2', async () => {
    await insertOrders(db, [1]);
    const live = await connectRow();
    await tick();
    await tick();
    await s.action({ action: 'addTab', title: 'x' });
    await s.action({ action: 'deleteTab', tab: 'Commandes' });
    await bump(1, "status = 'confirmed'");
    await s.post('/calls/clear');
    await db.prepare('INSERT INTO sheets_revocations (token_enc, google_sub, created_at) VALUES (?, ?, 1)').bind(await sealRefreshToken(await importSecretBoxKey(KEY), `${live}-other`), 'sub-other').run();
    await tick();
    expect(await calls()).toBeLessThanOrEqual(7);
  });
});

test('gate: nothing changed: no Google call; a new order wakes it', async () => {
  await insertOrders(db, [1]);
  await ready();
  await tick();
  await s.post('/calls/clear');
  await tick({}, MIN);
  await tick({}, MIN);
  expect(await googleCalls()).toEqual([]);
  await insertOrders(db, [2]);
  await tick({}, MIN);
  expect(await refsInSheet()).toEqual(['HB-T0001', 'HB-T0002']);
});
