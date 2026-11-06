// DB-5 — `@hb/db/backup`: canonical table digests and restore verification for the daily D1 → R2
// backup (jobs JOBS-1, plan §5). Rules agreed with `jobs` (their interim shim
// apps/jobs/src/backup/{digest,schema,verify}.ts used exactly these, so manifests made with the shim
// verify here):
//  - a table's columns = PRAGMA table_xinfo order, hidden/generated (hidden ≠ 0) excluded;
//  - rows in rowid order (primary-key order for WITHOUT ROWID tables);
//  - each row = JSON.stringify(array of its values); BLOBs as lowercase hex; bigint as decimal text;
//  - rows joined with "\n"; digest = sha256 hex;
//  - user tables = sqlite_master tables except sqlite_* and _cf_* (d1_migrations included);
//  - schemaSha256 = sha256 over the sorted `type\0name\0tbl_name\0sql` of every user object with
//    SQL (order-independent: a restore replays indexes and triggers after the data);
//  - schemaVersion = the last applied migration name in d1_migrations (null when absent).
// Workers (nodejs_compat for node:crypto) and Node. Not re-exported from `@hb/db`, so the storefront
// Worker never bundles node:crypto.
import { createHash } from 'node:crypto';

/** The subset of a D1 binding these helpers use (D1Database satisfies it). */
export interface D1Like {
  prepare(sql: string): D1StmtLike;
  batch(stmts: D1StmtLike[]): Promise<{ results: unknown[] }[]>;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface TableDigest {
  readonly rows: number;
  readonly digest: string;
}

export interface MasterRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

export interface TableInfo {
  readonly name: string;
  /** Columns in table_xinfo order, hidden/generated excluded. */
  readonly columns: readonly string[];
  /** Primary-key columns in key order. */
  readonly pk: readonly string[];
  readonly withoutRowid: boolean;
}

export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export function isUserTable(name: string): boolean {
  return !/^sqlite_/i.test(name) && !/^_cf_/i.test(name);
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** D1 returns BLOBs as number[] (or ArrayBuffer / typed arrays); better-sqlite3 as Buffer. */
function blobBytes(v: unknown): ArrayLike<number> | null {
  if (Array.isArray(v)) return v as number[];
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

/** One cell as it enters the canonical JSON row. */
export function canonicalValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || v === null) return v;
  if (typeof v === 'bigint') return v.toString();
  const bytes = blobBytes(v);
  if (!bytes) return v;
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]! & 0xff];
  return s;
}

/** Incremental digest (stream big tables page by page). */
export function createRowDigest(columns: readonly string[]): { add(row: Record<string, unknown>): void; finish(): TableDigest } {
  const h = createHash('sha256');
  let rows = 0;
  return {
    add(row) {
      if (rows > 0) h.update('\n');
      h.update(JSON.stringify(columns.map((c) => canonicalValue(row[c]))));
      rows++;
    },
    finish() {
      return { rows, digest: h.digest('hex') };
    },
  };
}

/** Digest of rows already read (e.g. from the backup's one atomic read batch). */
export function digestRows(columns: readonly string[], rows: Iterable<Record<string, unknown>>): TableDigest {
  const d = createRowDigest(columns);
  for (const r of rows) d.add(r);
  return d.finish();
}

export function schemaSha256(master: readonly MasterRow[]): string {
  const entries = master
    .filter((m) => m.sql !== null && isUserTable(m.name) && isUserTable(m.tbl_name))
    .map((m) => [m.type, m.name, m.tbl_name, m.sql].join('\0'))
    .sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

export async function readMaster(db: D1Like): Promise<MasterRow[]> {
  return (await db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid').all<MasterRow>()).results;
}

/** User tables in sqlite_master order, with their digest columns and key order. */
export async function discoverTables(db: D1Like, master?: readonly MasterRow[]): Promise<TableInfo[]> {
  const m = master ?? (await readMaster(db));
  const rows = m.filter((x) => x.type === 'table' && isUserTable(x.name));
  if (rows.length === 0) return [];
  const infos = await db.batch(rows.map((t) => db.prepare(`PRAGMA table_xinfo(${quoteIdent(t.name)})`)));
  return rows.map((t, i) => {
    const x = infos[i]!.results as { name: string; hidden: number; pk: number }[];
    return {
      name: t.name,
      columns: x.filter((c) => c.hidden === 0).map((c) => c.name),
      pk: x.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
      withoutRowid: /\)\s*WITHOUT\s+ROWID\s*;?\s*$/i.test(t.sql ?? ''),
    };
  });
}

async function digestTable(db: D1Like, t: TableInfo, pageSize: number): Promise<TableDigest> {
  const d = createRowDigest(t.columns);
  const cols = t.columns.map(quoteIdent).join(', ');
  if (t.withoutRowid) {
    const order = t.pk.map(quoteIdent).join(', ');
    for (let offset = 0; ; offset += pageSize) {
      const { results } = await db.prepare(`SELECT ${cols} FROM ${quoteIdent(t.name)} ORDER BY ${order} LIMIT ?1 OFFSET ?2`).bind(pageSize, offset).all();
      for (const r of results) d.add(r);
      if (results.length < pageSize) break;
    }
    return d.finish();
  }
  // Keyset pagination on rowid (same order as jobs' OFFSET pages, without the O(n²) scan).
  for (let after = Number.MIN_SAFE_INTEGER; ; ) {
    const { results } = await db
      .prepare(`SELECT rowid AS "__hb_rowid", ${cols} FROM ${quoteIdent(t.name)} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`)
      .bind(after, pageSize)
      .all<Record<string, unknown> & { __hb_rowid: number }>();
    for (const r of results) d.add(r);
    if (results.length < pageSize) break;
    after = results[results.length - 1]!.__hb_rowid;
  }
  return d.finish();
}

export async function tableDigest(db: D1Like, table: string, pageSize = 1000): Promise<TableDigest> {
  const t = (await discoverTables(db)).find((x) => x.name === table);
  if (!t) throw new Error(`tableDigest: no such table ${table}`);
  return digestTable(db, t, pageSize);
}

/** Last applied migration (d1_migrations), or null when the table is absent or empty. */
export async function schemaVersion(db: D1Like, master?: readonly MasterRow[]): Promise<string | null> {
  const m = master ?? (await readMaster(db));
  if (!m.some((x) => x.type === 'table' && x.name === 'd1_migrations')) return null;
  return (await db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first<{ name: string }>())?.name ?? null;
}

export interface BackupManifest {
  readonly schemaVersion: string | null;
  readonly schemaSha256: string;
  readonly tables: readonly ({ readonly name: string } & TableDigest)[];
}

export interface RestoreMismatch {
  /** Table name, or `(schema)` / `(schemaVersion)`. */
  readonly table: string;
  readonly expected: TableDigest | string | null;
  readonly actual: TableDigest | string | null;
}

/** The manifest of a database as it is now (what the backup writes; what a restore must equal). */
export async function buildManifest(db: D1Like, pageSize = 1000): Promise<BackupManifest> {
  const master = await readMaster(db);
  const tables = await discoverTables(db, master);
  const out: ({ name: string } & TableDigest)[] = [];
  for (const t of tables) out.push({ name: t.name, ...(await digestTable(db, t, pageSize)) });
  return { schemaVersion: await schemaVersion(db, master), schemaSha256: schemaSha256(master), tables: out };
}

/**
 * Compares a restored database with the backup's manifest: per-table row count + digest, tables
 * missing on either side, the migration version and the schema hash. `ok` only when all match.
 */
export async function verifyRestore(db: D1Like, manifest: BackupManifest, pageSize = 1000): Promise<{ ok: boolean; mismatches: RestoreMismatch[] }> {
  const master = await readMaster(db);
  const tables = await discoverTables(db, master);
  const byName = new Map(tables.map((t) => [t.name, t]));
  const mismatches: RestoreMismatch[] = [];
  for (const exp of manifest.tables) {
    const t = byName.get(exp.name);
    const expected = { rows: exp.rows, digest: exp.digest };
    if (!t) {
      mismatches.push({ table: exp.name, expected, actual: null });
      continue;
    }
    const actual = await digestTable(db, t, pageSize);
    if (actual.rows !== exp.rows || actual.digest !== exp.digest) mismatches.push({ table: exp.name, expected, actual });
  }
  const listed = new Set(manifest.tables.map((t) => t.name));
  for (const t of tables) if (!listed.has(t.name)) mismatches.push({ table: t.name, expected: null, actual: 'present' });
  const version = await schemaVersion(db, master);
  if (version !== manifest.schemaVersion) mismatches.push({ table: '(schemaVersion)', expected: manifest.schemaVersion, actual: version });
  const sha = schemaSha256(master);
  if (sha !== manifest.schemaSha256) mismatches.push({ table: '(schema)', expected: manifest.schemaSha256, actual: sha });
  return { ok: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------------------------
// Dumps (pure; Workers and Node)
// ---------------------------------------------------------------------------------------------

/**
 * Splits SQL text into statements: `;` outside '…' strings, "…"/`…`/[…] identifiers and comments
 * ends a statement, except inside a CREATE TRIGGER body, which ends at its `END;`.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  let depth = 0; // BEGIN … END nesting inside CREATE TRIGGER
  const isTrigger = () =>
    /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(sql.slice(start, i + 1));
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (close !== ']' && sql[i + 1] === close) i += 2; // doubled quote = escaped
          else break;
        } else i++;
      }
      i++;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[A-Za-z0-9_$]/.test(sql[i - 1]!))) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))!;
      const word = m[0].toUpperCase();
      if (word === 'BEGIN' && isTrigger()) depth++;
      else if (word === 'CASE' && depth > 0) depth++; // CASE … END inside a trigger body
      else if (word === 'END' && depth > 0) depth--;
      i += m[0].length;
      continue;
    }
    if (ch === ';' && depth === 0) {
      const stmt = sql.slice(start, i).trim();
      if (stmt) out.push(stmt);
      start = i + 1;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * A `wrangler d1 export` dump writes each table's CREATE TABLE followed by its INSERTs, in
 * sqlite_master order. Restored into a fresh D1 (foreign keys on), a child table's INSERT then fails
 * with "no such table: main.<parent>" when the parent table comes later. Hoisting every CREATE TABLE
 * to the top (original order otherwise kept) makes the dump restorable; PRAGMAs stay first.
 */
export function schemaFirst(sql: string): string {
  const stmts = splitSqlStatements(sql);
  const pragma = stmts.filter((s) => /^PRAGMA\b/i.test(s));
  const tables = stmts.filter((s) => /^CREATE\s+TABLE\b/i.test(s));
  const rest = stmts.filter((s) => !/^PRAGMA\b/i.test(s) && !/^CREATE\s+TABLE\b/i.test(s));
  return [...pragma, ...tables, ...rest].map((s) => `${s};`).join('\n') + '\n';
}

/** Public name (lead): reorder a D1 dump so it restores into a fresh database. Same as schemaFirst. */
export const orderDumpSchemaFirst = schemaFirst;

