// Daily D1 → R2 backup (JOBS-1). Plan: artifacts/JOBS-1/plan.md. Restore: apps/jobs/RESTORE.md.
//
// Output per run, in the private BACKUPS bucket:
//   d1/YYYY/MM/DD/HHmmssZ/dump.sql.gz   gzip SQL, restorable with `wrangler d1 execute --file`
//   d1/YYYY/MM/DD/HHmmssZ/manifest.json written last: its presence means the backup is complete
// Logs carry stage, table names, counts, bytes and durations only, never row values.
import { createHash } from 'node:crypto';
import { createRowDigest, type TableDigest } from './digest.ts';
import { GzipSink, type GzipResult } from './gzip.ts';
import {
  discover,
  MASTER_SQL,
  orderBy,
  postDataDdl,
  precisionCheckSql,
  schemaSha256,
  type DiscoveredSchema,
  type MasterRow,
  type TableInfo,
} from './schema.ts';
import { InsertWriter, quoteIdent, sqlLiteral } from './sql.ts';
import { log } from '../log.ts';

export const DATABASE_NAME = 'hb-destockage';
export const BACKUP_PREFIX = 'd1/';
export const FORMAT_VERSION = 2;
/**
 * Written in a run's prefix (before its manifest) when the snapshot is not consistent. Such a dump
 * may not load (FK/UNIQUE violations across tables read at different moments): retention never
 * counts it among the kept-good runs, status records it as a failure, and RESTORE.md says to pick
 * another run.
 */
export const INCONSISTENT_MARKER = 'INCONSISTENT';
/** Above this D1 size the export switches from one atomic batch to keyset pages (Worker memory: 128 MB). */
export const ATOMIC_MAX_BYTES = 16 * 1024 * 1024;

export type BackupMode = 'atomic' | 'paginated';

export interface BackupManifest {
  formatVersion: typeof FORMAT_VERSION;
  database: string;
  runId: string;
  /** The cron's scheduled time (names the run). */
  scheduledAt: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  mode: BackupMode;
  /**
   * false only when paginated mode saw writes on every attempt (see `attempts`). Such a run is
   * treated as FAILED everywhere (marker object, status, alerts, retention).
   */
  consistent: boolean;
  attempts: number;
  /** D1 session bookmark at the snapshot (informational: a Time Travel reference point). */
  bookmark: string | null;
  /** Latest applied migration (d1_migrations.name), null if the table is absent or empty. */
  schemaVersion: string | null;
  /** schemaSha256() of the user DDL (order-independent); verifyRestore recomputes it. */
  schemaSha256: string;
  dbSizeBytes: number | null;
  object: {
    key: string;
    contentType: 'application/gzip';
    format: 'sqlite-sql';
    bytes: number;
    sha256: string;
    rawBytes: number;
    rawSha256: string;
  };
  tables: ({ name: string } & TableDigest)[];
  /** AUTOINCREMENT counters restored from sqlite_sequence. */
  sequences: { name: string; seq: number }[];
}

export interface BackupOptions {
  now?: () => number;
  /** Scheduled time (defaults to now): names the run, so keys are deterministic. Duration uses the wall clock. */
  startedAt?: number;
  mode?: BackupMode;
  atomicMaxBytes?: number;
  pageSize?: number;
  maxAttempts?: number;
  /** Test hook: runs after each page in paginated mode. */
  onPage?: (table: string, page: number) => Promise<void>;
}

export interface BackupEnv {
  DB: D1Database;
  BACKUPS: R2Bucket;
}

export class PrecisionError extends Error {
  override readonly name = 'PrecisionError';
}
class SchemaChangedError extends Error {
  override readonly name = 'SchemaChangedError';
}

export function runIdFor(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // 20261104T020000Z
}

export function runPrefix(runId: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{6})Z$/.exec(runId);
  if (!m) throw new Error(`bad run id ${runId}`);
  return `${BACKUP_PREFIX}${m[1]}/${m[2]}/${m[3]}/${m[4]}Z/`;
}

/** Thrown out of runBackup: carries the stage for status/alerts; message has no data. */
export class BackupError extends Error {
  override readonly name = 'BackupError';
  readonly stage: string;
  readonly causeClass: string;
  readonly detail: string | null;
  constructor(stage: string, causeClass: string, detail: string | null) {
    super(`backup failed at ${stage}: ${causeClass}${detail ? ` (${detail})` : ''}`);
    this.stage = stage;
    this.causeClass = causeClass;
    this.detail = detail;
  }
}

/** Our own error classes have data-free messages; anything else (D1, R2) is reduced to its class. */
function describe(err: unknown): { causeClass: string; detail: string | null } {
  if (err instanceof PrecisionError || err instanceof SchemaChangedError) return { causeClass: err.name, detail: err.message };
  if (err instanceof Error && ['OversizedRowError', 'UnsupportedValueError', 'UnsupportedSchemaError'].includes(err.name)) {
    return { causeClass: err.name, detail: err.message };
  }
  return { causeClass: err instanceof Error ? err.name : typeof err, detail: null };
}

export async function runBackup(env: BackupEnv, opts: BackupOptions = {}): Promise<BackupManifest> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const scheduledAt = opts.startedAt ?? t0;
  const runId = runIdFor(scheduledAt);
  const prefix = runPrefix(runId);
  const maxAttempts = opts.maxAttempts ?? 3;
  let stage = 'discover';
  try {
    log('backup.start', { runId });
    let schema = await discover(env.DB);
    const mode: BackupMode = opts.mode ?? (schema.sizeBytes !== null && schema.sizeBytes > (opts.atomicMaxBytes ?? ATOMIC_MAX_BYTES) ? 'paginated' : 'atomic');

    let snap: Snapshot | null = null;
    let attempts = 0;
    stage = 'export';
    while (attempts < maxAttempts) {
      attempts++;
      try {
        snap = mode === 'atomic' ? await exportAtomic(env.DB, schema, runId) : await exportPaginated(env.DB, schema, runId, opts);
      } catch (err) {
        if (err instanceof SchemaChangedError && attempts < maxAttempts) {
          log('backup.schema_changed', { runId, attempt: attempts });
          schema = await discover(env.DB);
          continue;
        }
        throw err;
      }
      if (snap.consistent || attempts >= maxAttempts) break;
      log('backup.writes_during_export', { runId, attempt: attempts });
    }
    if (!snap) throw new SchemaChangedError('schema kept changing');

    stage = 'upload';
    if (!snap.consistent) {
      // Marker first: a manifest must never be visible without it.
      await env.BACKUPS.put(`${prefix}${INCONSISTENT_MARKER}`, 'writes during export; this dump may not load', {
        httpMetadata: { contentType: 'text/plain' },
      });
    }
    const key = `${prefix}dump.sql.gz`;
    await env.BACKUPS.put(key, snap.gz.gz, {
      httpMetadata: { contentType: 'application/gzip' },
      sha256: snap.gz.sha256,
      customMetadata: { runId, format: 'sqlite-sql', rawSha256: snap.gz.rawSha256 },
    });
    const finishedAt = now();
    const manifest: BackupManifest = {
      formatVersion: FORMAT_VERSION,
      database: DATABASE_NAME,
      runId,
      scheduledAt: new Date(scheduledAt).toISOString(),
      startedAt: new Date(t0).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - t0,
      mode,
      consistent: snap.consistent,
      attempts,
      bookmark: snap.bookmark,
      schemaVersion: snap.schemaVersion,
      schemaSha256: schemaSha256(snap.master),
      dbSizeBytes: schema.sizeBytes,
      object: {
        key,
        contentType: 'application/gzip',
        format: 'sqlite-sql',
        bytes: snap.gz.gz.byteLength,
        sha256: snap.gz.sha256,
        rawBytes: snap.gz.rawBytes,
        rawSha256: snap.gz.rawSha256,
      },
      tables: snap.tables,
      sequences: snap.sequences,
    };
    const manifestText = JSON.stringify(manifest, null, 2);
    await env.BACKUPS.put(`${prefix}manifest.json`, manifestText, {
      httpMetadata: { contentType: 'application/json' },
      sha256: createHash('sha256').update(manifestText).digest('hex'),
    });
    log('backup.done', {
      runId,
      mode,
      consistent: snap.consistent,
      attempts,
      tables: manifest.tables.length,
      rows: manifest.tables.reduce((s, t) => s + t.rows, 0),
      bytes: manifest.object.bytes,
      rawBytes: manifest.object.rawBytes,
      durationMs: manifest.durationMs,
    });
    return manifest;
  } catch (err) {
    const d = describe(err);
    log('backup.failed', { runId, stage, error: d.causeClass, detail: d.detail });
    throw new BackupError(stage, d.causeClass, d.detail);
  }
}

interface Snapshot {
  gz: GzipResult;
  master: MasterRow[];
  tables: ({ name: string } & TableDigest)[];
  sequences: { name: string; seq: number }[];
  schemaVersion: string | null;
  bookmark: string | null;
  consistent: boolean;
}

function sameMaster(a: readonly MasterRow[], b: readonly MasterRow[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function header(runId: string, mode: BackupMode): string {
  return [
    `-- ${DATABASE_NAME} D1 backup ${runId} (format ${FORMAT_VERSION}, ${mode})`,
    `-- Restore into an EMPTY database: wrangler d1 execute <db> --file dump.sql (see apps/jobs/RESTORE.md)`,
    `PRAGMA defer_foreign_keys = ON;`,
    '',
  ].join('\n');
}

async function writeCreateTables(sink: GzipSink, schema: DiscoveredSchema): Promise<void> {
  for (const t of schema.tables) await sink.write(`${t.sql};\n`);
}

async function writeTail(sink: GzipSink, schema: DiscoveredSchema, sequences: { name: string; seq: number }[]): Promise<void> {
  if (schema.hasSequence) {
    await sink.write('DELETE FROM sqlite_sequence;\n');
    for (const s of sequences) {
      await sink.write(`INSERT INTO sqlite_sequence (name, seq) VALUES (${sqlLiteral(s.name)}, ${sqlLiteral(s.seq)});\n`);
    }
  }
  for (const ddl of postDataDdl(schema.master)) await sink.write(`${ddl};\n`);
}

function schemaVersionFrom(rows: readonly Record<string, unknown>[] | undefined): string | null {
  if (!rows || rows.length === 0) return null;
  const last = rows.reduce((a, b) => (Number(b['id']) > Number(a['id']) ? b : a));
  return typeof last['name'] === 'string' ? last['name'] : null;
}

/** One D1 batch = one SQL transaction: every table is read at the same instant. */
async function exportAtomic(db: D1Database, schema: DiscoveredSchema, runId: string): Promise<Snapshot> {
  const session = db.withSession('first-primary');
  const checks = schema.tables.map(precisionCheckSql);
  const stmts: D1PreparedStatement[] = [
    session.prepare(MASTER_SQL),
    ...schema.tables.map((t) => session.prepare(`SELECT * FROM ${quoteIdent(t.name)} ORDER BY ${orderBy(t)}`)),
    ...checks.map((sql) => session.prepare(sql ?? 'SELECT 0 AS n')),
    session.prepare(schema.hasSequence ? 'SELECT name, seq FROM sqlite_sequence ORDER BY name' : 'SELECT NULL AS name, NULL AS seq WHERE 0'),
  ];
  const res = await session.batch<Record<string, unknown>>(stmts);
  const bookmark = session.getBookmark();
  const master = res[0]!.results as unknown as MasterRow[];
  if (!sameMaster(master, schema.master)) throw new SchemaChangedError('schema changed since discovery');
  const n = schema.tables.length;
  schema.tables.forEach((t, i) => {
    if (Number(res[1 + n + i]!.results[0]?.['n'] ?? 0) > 0) {
      throw new PrecisionError(`table ${t.name} holds integers beyond 2^53 that D1 would round`);
    }
  });
  const sequences = (res[1 + 2 * n]!.results as { name: string; seq: number }[]).filter((s) => s.name !== null);
  const byName = new Map(schema.tables.map((t, i) => [t.name, i]));

  const sink = new GzipSink();
  try {
    await sink.write(header(runId, 'atomic'));
    await writeCreateTables(sink, schema);
    const digests = new Map<string, TableDigest>();
    let schemaVersion: string | null = null;
    for (const name of schema.insertOrder) {
      const i = byName.get(name)!;
      const t = schema.tables[i]!;
      const rows = res[1 + i]!.results;
      if (name === 'd1_migrations') schemaVersion = schemaVersionFrom(rows);
      digests.set(name, await writeRows(sink, t, rows));
      (res[1 + i] as { results: unknown[] }).results = []; // release memory as we go
    }
    await writeTail(sink, schema, sequences);
    return {
      gz: await sink.finish(),
      master,
      tables: schema.tables.map((t) => ({ name: t.name, ...digests.get(t.name)! })),
      sequences,
      schemaVersion,
      bookmark,
      consistent: true,
    };
  } catch (err) {
    await sink.abort();
    throw err;
  }
}

async function writeRows(sink: GzipSink, t: TableInfo, rows: Iterable<Record<string, unknown>>): Promise<TableDigest> {
  const digest = createRowDigest(t.columns);
  const w = new InsertWriter(t.name, t.columns, (stmt) => sink.write(stmt));
  for (const row of rows) {
    await w.add(row);
    digest.add(row);
  }
  await w.flush();
  return digest.finish();
}

interface Watermark {
  master: string;
  tables: Record<string, { maxRowid: number | null; n: number; sumRowid: number; sumUpdatedAt: number | null }>;
}

/**
 * Change detector over the rows that existed when the export started (review r1 N1): per table,
 * count, total(rowid) and total(updated_at) over `rowid <= bound`. New rows past the bound are
 * excluded from the export anyway, so they no longer flip the run; deletes, delete+reinsert and
 * updates that bump updated_at are caught. Not caught: an in-place UPDATE of a table without
 * updated_at (in DB-1: notification_deliveries, publish_runs, rum_daily: operational tables).
 * `bounds` = the first call's max(rowid) per table.
 */
async function watermark(s: D1DatabaseSession, schema: DiscoveredSchema, bounds?: Watermark): Promise<Watermark> {
  const res = await s.batch<Record<string, unknown>>([
    s.prepare(MASTER_SQL),
    ...schema.tables.map((t) => {
      const u = t.hasUpdatedAt ? 'total("updated_at")' : 'NULL';
      if (t.withoutRowid) return s.prepare(`SELECT NULL AS m, count(*) AS n, 0 AS sr, ${u} AS su FROM ${quoteIdent(t.name)}`);
      const bound = bounds?.tables[t.name]?.maxRowid;
      return bounds
        ? s.prepare(`SELECT ?1 AS m, count(*) AS n, total(rowid) AS sr, ${u} AS su FROM ${quoteIdent(t.name)} WHERE rowid <= ?1`).bind(bound ?? Number.MIN_SAFE_INTEGER)
        : s.prepare(`SELECT max(rowid) AS m, count(*) AS n, total(rowid) AS sr, ${u} AS su FROM ${quoteIdent(t.name)}`);
    }),
  ]);
  const tables: Watermark['tables'] = {};
  schema.tables.forEach((t, i) => {
    const r = res[1 + i]!.results[0]!;
    const m = bounds ? (bounds.tables[t.name]?.maxRowid ?? null) : (r['m'] as number | null);
    tables[t.name] = { maxRowid: m, n: Number(r['n']), sumRowid: Number(r['sr']), sumUpdatedAt: r['su'] as number | null };
  });
  return { master: JSON.stringify(res[0]!.results), tables };
}

/**
 * Keyset pages bounded by the starting watermark. Consistency: the watermark (see watermark()) is
 * read before and after; any difference means existing rows changed during the export and the
 * caller retries.
 */
async function exportPaginated(db: D1Database, schema: DiscoveredSchema, runId: string, opts: BackupOptions): Promise<Snapshot> {
  const pageSize = opts.pageSize ?? 1000;
  const s = db.withSession('first-primary');
  const before = await watermark(s, schema);
  if (before.master !== JSON.stringify(schema.master)) throw new SchemaChangedError('schema changed since discovery');
  const bookmark = s.getBookmark();

  const checks = await s.batch<{ n: number }>(schema.tables.map((t) => s.prepare(precisionCheckSql(t) ?? 'SELECT 0 AS n')));
  schema.tables.forEach((t, i) => {
    if (Number(checks[i]!.results[0]?.n ?? 0) > 0) throw new PrecisionError(`table ${t.name} holds integers beyond 2^53 that D1 would round`);
  });

  const sink = new GzipSink();
  try {
    await sink.write(header(runId, 'paginated'));
    await writeCreateTables(sink, schema);
    const byName = new Map(schema.tables.map((t) => [t.name, t]));
    const digests = new Map<string, TableDigest>();
    let migrationRows: Record<string, unknown>[] | undefined;
    for (const name of schema.insertOrder) {
      const t = byName.get(name)!;
      const digest = createRowDigest(t.columns);
      const w = new InsertWriter(t.name, t.columns, (stmt) => sink.write(stmt));
      const maxRowid = before.tables[name]!.maxRowid;
      let page = 0;
      let lastRowid = Number.MIN_SAFE_INTEGER;
      for (;;) {
        let rows: Record<string, unknown>[];
        if (t.withoutRowid) {
          rows = (await s.prepare(`SELECT * FROM ${quoteIdent(name)} ORDER BY ${orderBy(t)} LIMIT ?1 OFFSET ?2`).bind(pageSize, page * pageSize).all()).results;
        } else {
          if (maxRowid === null) break; // empty at the watermark
          rows = (
            await s
              .prepare(`SELECT rowid AS "__hb_rowid", * FROM ${quoteIdent(name)} WHERE rowid > ?1 AND rowid <= ?2 ORDER BY rowid LIMIT ?3`)
              .bind(lastRowid, maxRowid, pageSize)
              .all()
          ).results;
        }
        for (const row of rows) {
          await w.add(row);
          digest.add(row);
        }
        if (name === 'd1_migrations') (migrationRows ??= []).push(...rows);
        page++;
        if (opts.onPage) await opts.onPage(name, page);
        if (rows.length < pageSize) break;
        if (!t.withoutRowid) lastRowid = Number(rows[rows.length - 1]!['__hb_rowid']);
      }
      await w.flush();
      digests.set(name, digest.finish());
    }
    const seq = schema.hasSequence ? (await s.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all<{ name: string; seq: number }>()).results : [];
    await writeTail(sink, schema, seq);
    const after = await watermark(s, schema, before);
    const consistent = JSON.stringify(after) === JSON.stringify(before);
    return {
      gz: await sink.finish(),
      master: schema.master,
      tables: schema.tables.map((t) => ({ name: t.name, ...digests.get(t.name)! })),
      sequences: seq,
      schemaVersion: schemaVersionFrom(migrationRows),
      bookmark,
      consistent,
    };
  } catch (err) {
    await sink.abort();
    throw err;
  }
}
