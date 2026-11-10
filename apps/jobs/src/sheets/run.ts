// The Sheets sync (SHEET-0 §2): per-minute, behind a lease, D1 only until there is work to send.
// Nothing here runs in an order or admin request. All Google traffic goes through ./google.ts.
import { importSecretBoxKey, SecretBoxOpenError, type SecretBoxKey } from '@hb/db/secret-box';
import { log } from '../log.ts';
import { failure, GoogleError, type Failure } from './classify.ts';
import { buildRow, colLetters, FILE_NAME, freeTitle, HEADERS, hashRow, layoutRow, locateColumns, quoteTitle, type CellValue, type OrderItemRow, type OrderRowSource, type SheetLang } from './columns.ts';
import { GoogleApi, openRefreshToken, refreshAccessToken, resolveGoogleEndpoints, revokeToken, sealRefreshToken, type GoogleContext, type GoogleEndpoints, type OAuthClient, type TabProperties } from './google.ts';

export const BATCH_SIZE = 300;
const LEASE_MS = 5 * 60_000;
const RUN_BUDGET_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const FORCED_SCAN_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const BACKOFF_BASE_MS = 2 * 60_000;
const BACKOFF_JITTER_MS = 30_000;
const REVOCATIONS_PER_RUN = 2;
const REVOKE_MAX_ATTEMPTS = 8;
const REVOKE_BASE_MS = 15 * 60_000;
const ITEM_CHUNK = 90;
const STATE_CHUNK = 100;
const PROBE_COLUMNS = 26;
const PROBE_ROWS = 100;

export interface SheetsEnv {
  DB: D1Database;
  ENV?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_STANDIN_URL?: string;
  COURIER_KEYS_KEY?: string;
}

export interface SheetsDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** 0..1, for jitter. */
  random?: () => number;
  /** Replaces the resolved endpoints (tests of the guard). */
  endpoints?: GoogleEndpoints;
  timeoutMs?: number;
  runBudgetMs?: number;
}

interface Connection {
  status: string;
  google_sub: string | null;
  refresh_token_enc: string | null;
  create_key: string | null;
  spreadsheet_id: string | null;
  tab_id: number | null;
  lang: SheetLang | null;
  generation: number;
  failure_count: number;
  next_attempt_at: number | null;
  scan_fingerprint: string | null;
  last_scan_at: number | null;
}

interface Revocation {
  id: number;
  token_enc: string;
  attempts: number;
}

interface SelectedOrder extends OrderRowSource {
  id: number;
  version: number;
  row_hash: string | null;
}

interface Config {
  client: OAuthClient;
  key: SecretBoxKey;
  endpoints: GoogleEndpoints;
}

/** A lost lease, or a disconnect or resync during the run: stop, and let nothing further count. */
class LeaseLost extends Error {}

const readConnection = (db: D1Database): Promise<Connection | null> => db.prepare('SELECT * FROM sheets_connection WHERE id = 1').first<Connection>();

async function jobConfig(env: SheetsEnv, deps: SheetsDeps): Promise<Config | null> {
  const endpoints = deps.endpoints ?? resolveGoogleEndpoints(env);
  if (!endpoints || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  let key: SecretBoxKey;
  try {
    key = await importSecretBoxKey(env.COURIER_KEYS_KEY);
  } catch {
    return null;
  }
  return { client: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }, key, endpoints };
}

const KEEP_REVOKE_NOTICE =
  "last_error_code = CASE WHEN last_error_code = 'revoke_abandoned' THEN last_error_code END, last_error_at = CASE WHEN last_error_code = 'revoke_abandoned' THEN last_error_at END";

class Run {
  readonly db: D1Database;
  readonly owner = crypto.randomUUID();
  readonly now: () => number;
  readonly random: () => number;
  generation = 0;

  constructor(db: D1Database, deps: SheetsDeps) {
    this.db = db;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  async acquire(): Promise<boolean> {
    const now = this.now();
    const r = await this.db
      .prepare('UPDATE sheets_connection SET lease_owner = ?, lease_until = ? WHERE id = 1 AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until < ?)')
      .bind(this.owner, now + LEASE_MS, now)
      .run();
    return r.meta.changes === 1;
  }

  async release(): Promise<void> {
    await this.db.prepare('UPDATE sheets_connection SET lease_owner = NULL, lease_until = NULL WHERE id = 1 AND lease_owner = ?').bind(this.owner).run();
  }

  /** Before every Google write. Fails if the lease, the status or the generation moved. */
  async renew(): Promise<void> {
    const r = await this.db
      .prepare("UPDATE sheets_connection SET lease_until = ? WHERE id = 1 AND lease_owner = ? AND status = 'connected' AND generation = ?")
      .bind(this.now() + LEASE_MS, this.owner, this.generation)
      .run();
    if (r.meta.changes !== 1) throw new LeaseLost();
  }

  /** Runs one update that only counts while this run still owns a live connection. */
  async owned(setSql: string, ...binds: unknown[]): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE sheets_connection SET ${setSql} WHERE id = 1 AND lease_owner = ? AND status = 'connected' AND generation = ?`)
      .bind(...binds, this.owner, this.generation)
      .run();
    return r.meta.changes === 1;
  }

  async success(layoutNote: string | null, scan: { fingerprint: string } | null): Promise<void> {
    const now = this.now();
    const scanSql = scan ? ', scan_fingerprint = ?, last_scan_at = ?' : '';
    await this.owned(
      // A revocation given up on stays shown until the owner acts (connect, resync, new sheet,
      // disconnect reset it): it asks them to remove access by hand, which no sync run can do.
      `failure_count = 0, next_attempt_at = NULL, last_success_at = ?, ${KEEP_REVOKE_NOTICE}, layout_note = ?, updated_at = ?${scanSql}`,
      now,
      layoutNote,
      now,
      ...(scan ? [scan.fingerprint, now] : []),
    );
  }

  async recordFailure(f: Failure, failureCount: number): Promise<void> {
    const now = this.now();
    if (f.outcome === 'backoff') {
      const n = failureCount + 1;
      const wait = Math.min(2 ** n * BACKOFF_BASE_MS, MAX_BACKOFF_MS) + Math.floor(this.random() * BACKOFF_JITTER_MS);
      const retry = f.retryAfterMs !== null && Number.isFinite(f.retryAfterMs) ? Math.min(f.retryAfterMs, MAX_BACKOFF_MS) : 0;
      await this.owned('failure_count = ?, next_attempt_at = ?, last_error_code = ?, last_error_at = ?, updated_at = ?', n, now + Math.max(wait, retry), f.code, now, now);
    } else {
      await this.owned('status = ?, failure_count = 0, next_attempt_at = NULL, last_error_code = ?, last_error_at = ?, updated_at = ?', f.outcome, f.code, now, now);
    }
    log('sheets.failure', { code: f.code, outcome: f.outcome });
  }
}

// ---------------------------------------------------------------------------------------------
// Revocations: their own step and backoff, before the sync gate and whatever the status
// ---------------------------------------------------------------------------------------------

async function dueRevocations(db: D1Database, now: number): Promise<Revocation[]> {
  const r = await db
    .prepare('SELECT id, token_enc, attempts FROM sheets_revocations WHERE next_attempt_at IS NULL OR next_attempt_at <= ? ORDER BY id LIMIT ?')
    .bind(now, REVOCATIONS_PER_RUN)
    .all<Revocation>();
  return r.results;
}

async function abandonRevocation(run: Run, id: number): Promise<void> {
  const now = run.now();
  await run.db.batch([
    run.db.prepare('DELETE FROM sheets_revocations WHERE id = ? AND EXISTS (SELECT 1 FROM sheets_connection WHERE id = 1 AND lease_owner = ?)').bind(id, run.owner),
    run.db.prepare("UPDATE sheets_connection SET last_error_code = 'revoke_abandoned', last_error_at = ?, updated_at = ? WHERE id = 1 AND lease_owner = ?").bind(now, now, run.owner),
  ]);
  log('sheets.revoke_abandoned', {});
}

async function processRevocations(run: Run, due: readonly Revocation[], cfg: Config, google: GoogleContext): Promise<void> {
  for (const rev of due) {
    let token: string;
    try {
      token = await openRefreshToken(cfg.key, rev.token_enc);
    } catch {
      await abandonRevocation(run, rev.id);
      continue;
    }
    if ((await revokeToken(google, token)) === 'done') {
      await run.db.prepare('DELETE FROM sheets_revocations WHERE id = ? AND EXISTS (SELECT 1 FROM sheets_connection WHERE id = 1 AND lease_owner = ?)').bind(rev.id, run.owner).run();
      continue;
    }
    const attempts = rev.attempts + 1;
    if (attempts >= REVOKE_MAX_ATTEMPTS) {
      await abandonRevocation(run, rev.id);
      continue;
    }
    const next = run.now() + REVOKE_BASE_MS * 2 ** rev.attempts + Math.floor(run.random() * BACKOFF_JITTER_MS);
    await run.db.prepare('UPDATE sheets_revocations SET attempts = ?, next_attempt_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM sheets_connection WHERE id = 1 AND lease_owner = ?)').bind(attempts, next, rev.id, run.owner).run();
  }
}

// ---------------------------------------------------------------------------------------------
// D1 reads
// ---------------------------------------------------------------------------------------------

async function fingerprint(db: D1Database, generation: number): Promise<string> {
  const row = await db
    .prepare('SELECT (SELECT MAX(updated_at) FROM orders) AS o, (SELECT MAX(updated_at) FROM shipments) AS s, (SELECT MAX(id) FROM orders) AS i')
    .first<{ o: number | null; s: number | null; i: number | null }>();
  return `${generation}|${row?.o ?? ''}|${row?.s ?? ''}|${row?.i ?? ''}`;
}

const SELECT_ORDERS = `
SELECT o.id, o.ref, o.version, o.name, o.phone_e164, o.wilaya_code, o.address, o.subtotal_dzd, o.fee_dzd, o.total_dzd,
       o.status, o.call_attempts, o.courier_name, o.courier_tracking, o.created_at, o.updated_at,
       w.name_fr AS wilaya_fr, w.name_ar AS wilaya_ar, m.name_fr AS commune_fr, m.name_ar AS commune_ar,
       s.courier_status, s.updated_at AS shipment_stamp, r.row_hash
FROM orders o
JOIN wilayas w ON w.code = o.wilaya_code
JOIN communes m ON m.id = o.commune_id
LEFT JOIN sheets_rows r ON r.order_id = o.id AND r.generation = ?1
LEFT JOIN shipments s ON s.id = (SELECT MAX(x.id) FROM shipments x WHERE x.order_id = o.id)
WHERE r.order_id IS NULL OR r.source_version <> o.version OR r.shipment_stamp IS NOT s.updated_at
ORDER BY o.id
LIMIT ?2`;

async function selectOrders(db: D1Database, generation: number): Promise<SelectedOrder[]> {
  return (await db.prepare(SELECT_ORDERS).bind(generation, BATCH_SIZE).all<SelectedOrder>()).results;
}

async function loadItems(db: D1Database, orderIds: readonly number[]): Promise<Map<number, OrderItemRow[]>> {
  const out = new Map<number, OrderItemRow[]>();
  for (let i = 0; i < orderIds.length; i += ITEM_CHUNK) {
    const chunk = orderIds.slice(i, i + ITEM_CHUNK);
    const sql = `SELECT order_id, name_fr, name_ar, variant_label_fr, variant_label_ar, qty FROM order_items WHERE order_id IN (${chunk.map(() => '?').join(',')}) ORDER BY order_id, id`;
    const rows = await db.prepare(sql).bind(...chunk).all<OrderItemRow & { order_id: number }>();
    for (const row of rows.results) {
      const list = out.get(row.order_id) ?? [];
      list.push(row);
      out.set(row.order_id, list);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Row state
// ---------------------------------------------------------------------------------------------

interface RowState {
  orderId: number;
  version: number;
  stamp: number | null;
  hash: string;
}

async function saveRowState(run: Run, rows: readonly RowState[]): Promise<void> {
  const now = run.now();
  for (let i = 0; i < rows.length; i += STATE_CHUNK) {
    await run.db.batch(
      rows.slice(i, i + STATE_CHUNK).map((r) =>
        run.db
          .prepare(
            `INSERT INTO sheets_rows (order_id, generation, source_version, shipment_stamp, row_hash, synced_at)
             SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sheets_connection WHERE id = 1 AND lease_owner = ? AND generation = ? AND status = 'connected')
             ON CONFLICT (order_id) DO UPDATE SET generation = excluded.generation, source_version = excluded.source_version, shipment_stamp = excluded.shipment_stamp, row_hash = excluded.row_hash, synced_at = excluded.synced_at`,
          )
          .bind(r.orderId, run.generation, r.version, r.stamp, r.hash, now, run.owner, run.generation),
      ),
    );
  }
}

async function clearRowState(run: Run, orderIds: readonly number[]): Promise<void> {
  for (let i = 0; i < orderIds.length; i += ITEM_CHUNK) {
    const chunk = orderIds.slice(i, i + ITEM_CHUNK);
    await run.db
      .prepare(`DELETE FROM sheets_rows WHERE order_id IN (${chunk.map(() => '?').join(',')}) AND EXISTS (SELECT 1 FROM sheets_connection WHERE id = 1 AND lease_owner = ? AND generation = ?)`)
      .bind(...chunk, run.owner, run.generation)
      .run();
  }
}

async function orderIdsForRefs(db: D1Database, refs: readonly string[]): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < refs.length; i += ITEM_CHUNK) {
    const chunk = refs.slice(i, i + ITEM_CHUNK);
    const rows = await db.prepare(`SELECT id FROM orders WHERE ref IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ id: number }>();
    ids.push(...rows.results.map((r) => r.id));
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Setup and repairs
// ---------------------------------------------------------------------------------------------

function tabPropertiesUpdate(sheetId: number, lang: SheetLang, title?: string): unknown {
  return {
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 }, rightToLeft: lang === 'ar', ...(title === undefined ? {} : { title }) },
      fields: `${title === undefined ? '' : 'title,'}gridProperties.frozenRowCount,rightToLeft`,
    },
  };
}

async function writeHeader(run: Run, api: GoogleApi, spreadsheetId: string, title: string, lang: SheetLang): Promise<void> {
  await run.renew();
  await api.write(spreadsheetId, [{ range: `${quoteTitle(title)}!A1:${colLetters(HEADERS[lang].length - 1)}1`, values: [[...HEADERS[lang]]] }]);
}

/** Creation of the file and its first tab. A run of its own. */
async function setup(run: Run, api: GoogleApi, conn: Connection, lang: SheetLang): Promise<void> {
  let spreadsheetId = conn.spreadsheet_id;
  if (spreadsheetId === null) {
    if (conn.create_key === null) throw new GoogleError(failure('backoff', 'no_create_key'));
    const [existing] = await api.findByCreateKey(conn.create_key);
    if (existing) {
      spreadsheetId = existing.id;
    } else {
      await run.renew();
      spreadsheetId = await api.createSpreadsheet(FILE_NAME[lang], conn.create_key);
    }
    if (!(await run.owned('spreadsheet_id = ?, updated_at = ?', spreadsheetId, run.now()))) throw new LeaseLost();
  }
  if (conn.tab_id === null) {
    const tabs = await api.tabs(spreadsheetId);
    const first = tabs[0];
    if (!first) throw new GoogleError(failure('backoff', 'bad_response'));
    const title = freeTitle(lang, tabs.slice(1).map((t) => t.title));
    await run.renew();
    await api.batchUpdate(spreadsheetId, [tabPropertiesUpdate(first.sheetId, lang, title)]);
    if (!(await run.owned('tab_id = ?, updated_at = ?', first.sheetId, run.now()))) throw new LeaseLost();
    await writeHeader(run, api, spreadsheetId, title, lang);
  }
  await run.success(null, null);
}

/** Our tab was deleted: a new one, then a full refill through the new generation. */
async function recreateTab(run: Run, api: GoogleApi, spreadsheetId: string, tabs: readonly TabProperties[], lang: SheetLang): Promise<void> {
  const title = freeTitle(lang, tabs.map((t) => t.title));
  await run.renew();
  const body = await api.batchUpdate(spreadsheetId, [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 }, rightToLeft: lang === 'ar' } } }]);
  const replies = body['replies'] as { addSheet?: { properties?: { sheetId?: number } } }[] | undefined;
  const sheetId = replies?.[0]?.addSheet?.properties?.sheetId;
  if (typeof sheetId !== 'number') throw new GoogleError(failure('backoff', 'bad_response'));
  const next = run.generation + 1;
  if (!(await run.owned('tab_id = ?, generation = ?, scan_fingerprint = NULL, updated_at = ?', sheetId, next, run.now()))) throw new LeaseLost();
  run.generation = next;
  await writeHeader(run, api, spreadsheetId, title, lang);
  await run.success(null, null);
}

// ---------------------------------------------------------------------------------------------
// A write run
// ---------------------------------------------------------------------------------------------

function refPositions(values: readonly string[][] | undefined): { rows: Map<string, number[]>; last: number } {
  const rows = new Map<string, number[]>();
  const list = values ?? [];
  list.forEach((row, i) => {
    const ref = row[0];
    if (i === 0 || ref === undefined || ref === '') return;
    const positions = rows.get(ref) ?? [];
    positions.push(i + 1);
    rows.set(ref, positions);
  });
  return { rows, last: Math.max(list.length, 1) };
}

async function writeRun(run: Run, api: GoogleApi, conn: Connection, lang: SheetLang, orders: readonly SelectedOrder[], fp: string): Promise<void> {
  const spreadsheetId = conn.spreadsheet_id!;
  const tabs = await api.tabs(spreadsheetId);
  // Trash first: a trashed file is lost even if its tab was also deleted, and must not be refilled.
  if (await api.isTrashed(spreadsheetId)) throw new GoogleError(failure('sheet_lost', 'trashed'));
  const tab = tabs.find((t) => t.sheetId === conn.tab_id);
  if (!tab) return recreateTab(run, api, spreadsheetId, tabs, lang);

  const q = quoteTitle(tab.title);
  const [headerRange] = await api.read(spreadsheetId, [`${q}!1:1`]);
  const header = headerRange?.values?.[0] ?? [];
  if (header.length === 0) {
    // An empty tab is an interrupted setup. Data below an empty row 1 means a row was inserted above
    // the header or the header was cleared: writing a header there would be wrong.
    const probeColumns = Math.min(tab.gridProperties?.columnCount ?? PROBE_COLUMNS, PROBE_COLUMNS);
    const probeRows = Math.min(tab.gridProperties?.rowCount ?? PROBE_ROWS, PROBE_ROWS);
    const [probe] = await api.read(spreadsheetId, [`${q}!A1:${colLetters(probeColumns - 1)}${probeRows}`]);
    if ((probe?.values ?? []).some((row) => row.some((cell) => cell !== ''))) throw new GoogleError(failure('layout_changed', 'ref_header'));
    if (tab.gridProperties?.frozenRowCount !== 1) {
      await run.renew();
      await api.batchUpdate(spreadsheetId, [tabPropertiesUpdate(tab.sheetId, lang)]);
    }
    await writeHeader(run, api, spreadsheetId, tab.title, lang);
    return run.success(null, null);
  }
  const layout = locateColumns(header, lang);
  if (!layout.ok) throw new GoogleError(failure('layout_changed', 'ref_header'));
  const layoutNote = layout.missing.length > 0 ? layout.missing.join(', ') : null;

  if (orders.length === 0) return run.success(layoutNote, { fingerprint: fp });

  const refLetter = colLetters(layout.refColumn);
  const refRange = `${q}!${refLetter}:${refLetter}`;
  const [refsRead] = await api.read(spreadsheetId, [refRange]);
  const { rows: positions, last } = refPositions(refsRead?.values);

  const items = await loadItems(run.db, orders.map((o) => o.id));
  const lastCol = colLetters(Math.max(...layout.columns.map((c) => c ?? -1)));
  const data: { range: string; values: (CellValue | null)[][] }[] = [];
  const rangeFor = (row: number): string => `${q}!A${row}:${lastCol}${row}`;
  const written: (RowState & { ref: string })[] = [];
  const suppressed: RowState[] = [];
  let appended = 0;

  for (const o of orders) {
    const row = buildRow(o, items.get(o.id) ?? [], lang);
    const hash = await hashRow(row);
    const state = { orderId: o.id, version: o.version, stamp: o.shipment_stamp, hash };
    const at = positions.get(o.ref);
    if (at && o.row_hash === hash) {
      suppressed.push(state);
      continue;
    }
    const laidOut = layoutRow(layout.columns, row);
    if (at) {
      for (const p of at) data.push({ range: rangeFor(p), values: [laidOut] });
    } else {
      appended++;
      data.push({ range: rangeFor(last + appended), values: [laidOut] });
    }
    written.push({ ...state, ref: o.ref });
  }

  if (data.length === 0) {
    await saveRowState(run, suppressed);
    return run.success(layoutNote, orders.length < BATCH_SIZE ? { fingerprint: fp } : null);
  }

  if (appended > 0) {
    await run.renew();
    await api.batchUpdate(spreadsheetId, [{ insertDimension: { range: { sheetId: tab.sheetId, dimension: 'ROWS', startIndex: last, endIndex: last + appended }, inheritFromBefore: true } }]);
  }
  await run.renew();
  await api.write(spreadsheetId, data);

  // Google confirmed the write. A failure of the re-read below does not undo that.
  let after: { header: string[] | undefined; refs: string[][] | undefined };
  try {
    const [h, r] = await api.read(spreadsheetId, [`${q}!1:1`, refRange]);
    after = { header: h?.values?.[0], refs: r?.values };
  } catch (e) {
    await saveRowState(run, [...suppressed, ...written]);
    throw e;
  }

  const headerMoved = JSON.stringify(after.header ?? []) !== JSON.stringify(header);
  const seen = new Set((after.refs ?? []).slice(1).map((row) => row[0]).filter((ref): ref is string => Boolean(ref)));
  const lostHere = headerMoved ? written : written.filter((w) => !seen.has(w.ref));
  const lostIds = new Set(lostHere.map((w) => w.orderId));
  const lostElsewhere = headerMoved ? [] : [...positions.keys()].filter((ref) => !seen.has(ref));
  const requeue = [...lostIds, ...(lostElsewhere.length > 0 ? await orderIdsForRefs(run.db, lostElsewhere) : [])];

  await saveRowState(run, [...suppressed, ...written.filter((w) => !lostIds.has(w.orderId))]);
  if (requeue.length > 0) await clearRowState(run, requeue);
  await run.success(layoutNote, orders.length < BATCH_SIZE && requeue.length === 0 ? { fingerprint: fp } : null);
}

// ---------------------------------------------------------------------------------------------
// One sync pass
// ---------------------------------------------------------------------------------------------

async function accessFor(run: Run, cfg: Config, google: GoogleContext, conn: Connection): Promise<string> {
  let refreshToken: string;
  try {
    if (conn.refresh_token_enc === null) throw new SecretBoxOpenError('no token');
    refreshToken = await openRefreshToken(cfg.key, conn.refresh_token_enc);
  } catch (e) {
    if (e instanceof SecretBoxOpenError) throw new GoogleError(failure('needs_reconnect', 'token_unreadable'));
    throw e;
  }
  const { accessToken, newRefreshToken } = await refreshAccessToken(google, cfg.client, refreshToken);
  if (newRefreshToken !== null) {
    await run.owned('refresh_token_enc = ?, updated_at = ?', await sealRefreshToken(cfg.key, newRefreshToken), run.now());
  }
  return accessToken;
}

async function sync(run: Run, cfg: Config, google: GoogleContext): Promise<void> {
  const conn = await readConnection(run.db);
  if (!conn || conn.status !== 'connected') return;
  if (conn.next_attempt_at !== null && run.now() < conn.next_attempt_at) return;
  run.generation = conn.generation;
  const lang: SheetLang = conn.lang === 'ar' ? 'ar' : 'fr';

  try {
    const settingUp = conn.spreadsheet_id === null || conn.tab_id === null;
    // After a failure the run goes on to Google even with no orders, so an interrupted setup repairs
    // itself and the counters reset as soon as Google answers.
    const probing = conn.failure_count > 0;
    const fp = await fingerprint(run.db, conn.generation);
    if (!settingUp && !probing && fp === conn.scan_fingerprint && conn.last_scan_at !== null && run.now() - conn.last_scan_at < FORCED_SCAN_MS) return;

    const orders = settingUp ? [] : await selectOrders(run.db, conn.generation);
    if (!settingUp && !probing && orders.length === 0) {
      await run.owned('scan_fingerprint = ?, last_scan_at = ?', fp, run.now());
      return;
    }

    const api = new GoogleApi(google, await accessFor(run, cfg, google, conn));
    if (settingUp) await setup(run, api, conn, lang);
    else await writeRun(run, api, conn, lang, orders, fp);
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    if (e instanceof GoogleError) {
      await run.recordFailure(e.failure, conn.failure_count);
      return;
    }
    // Anything else (a D1 error, a bug) still backs off and shows on /sheets instead of failing
    // silently every minute. The cron entry point logs its name.
    await run.recordFailure(failure('backoff', 'internal_error'), conn.failure_count).catch(() => undefined);
    throw e;
  }
}

async function recordConfigMissing(db: D1Database, now: number): Promise<void> {
  await db
    .prepare("UPDATE sheets_connection SET last_error_code = 'config_missing', last_error_at = ?, updated_at = ? WHERE id = 1 AND status = 'connected' AND last_error_code IS NOT 'config_missing'")
    .bind(now, now)
    .run();
}

/** The cron entry point. Never rejects: a failure here must not affect the courier sync beside it. */
export async function runSheetsSync(env: SheetsEnv, deps: SheetsDeps = {}): Promise<void> {
  try {
    const db = env.DB;
    const now = deps.now ?? Date.now;
    const conn = await readConnection(db);
    if (!conn) return;
    const due = await dueRevocations(db, now());
    const connected = conn.status === 'connected';
    if (!connected && due.length === 0) return;
    const inBackoff = conn.next_attempt_at !== null && now() < conn.next_attempt_at;
    if (due.length === 0 && inBackoff) return;

    const cfg = await jobConfig(env, deps);
    if (!cfg) {
      if (connected) await recordConfigMissing(db, now());
      return;
    }

    const run = new Run(db, deps);
    if (!(await run.acquire())) return;
    try {
      const deadline = now() + (deps.runBudgetMs ?? RUN_BUDGET_MS);
      const google: GoogleContext = {
        env: env.ENV,
        endpoints: cfg.endpoints,
        timeoutMs: deps.timeoutMs ?? REQUEST_TIMEOUT_MS,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        beforeCall: () => {
          if (now() > deadline) throw new GoogleError(failure('backoff', 'run_budget'));
        },
      };
      if (due.length > 0) await processRevocations(run, due, cfg, google);
      await sync(run, cfg, google);
    } catch (e) {
      if (!(e instanceof LeaseLost) && !(e instanceof GoogleError)) throw e;
    } finally {
      await run.release();
    }
  } catch (e) {
    log('sheets.error', { error: e instanceof Error ? e.name : 'unknown' });
  }
}
