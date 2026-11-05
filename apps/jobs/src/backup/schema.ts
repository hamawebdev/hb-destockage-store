// Discovers every user table from sqlite_master (nothing hard-coded) plus the DDL to recreate it.
import { quoteIdent } from './sql.ts';

export interface MasterRow {
  type: 'table' | 'index' | 'view' | 'trigger';
  name: string;
  tbl_name: string;
  sql: string | null;
}

export interface TableInfo {
  name: string;
  sql: string;
  /** Insertable columns in table_xinfo order (hidden/generated excluded). */
  columns: string[];
  /** Primary-key columns in key order (empty = none declared). */
  pk: string[];
  withoutRowid: boolean;
  hasUpdatedAt: boolean;
  /** Parent tables referenced by foreign keys (self-references excluded). */
  parents: string[];
}

export interface DiscoveredSchema {
  master: MasterRow[];
  /** User tables in sqlite_master (creation) order. */
  tables: TableInfo[];
  /** Same tables, parents before children (for INSERT order). */
  insertOrder: string[];
  hasSequence: boolean;
  /** D1-reported database size in bytes (meta.size_after), null if unknown. */
  sizeBytes: number | null;
}

export class UnsupportedSchemaError extends Error {
  override readonly name = 'UnsupportedSchemaError';
}

export const MASTER_SQL = `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid`;

/** D1 internals and SQLite internals are never exported (sqlite_sequence is handled separately). */
export function isUserTable(name: string): boolean {
  return !/^sqlite_/i.test(name) && !/^_cf_/i.test(name);
}

export async function discover(db: D1Database): Promise<DiscoveredSchema> {
  const masterRes = await db.prepare(MASTER_SQL).all<MasterRow>();
  const master = masterRes.results;
  const sizeAfter = (masterRes.meta as { size_after?: unknown }).size_after;
  const tableRows = master.filter((m) => m.type === 'table' && isUserTable(m.name));
  for (const t of tableRows) {
    if (!t.sql || /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql)) {
      throw new UnsupportedSchemaError(`virtual table ${t.name} is not supported by the backup`);
    }
  }
  const pragmas = tableRows.length
    ? await db.batch(
        tableRows.flatMap((t) => [
          db.prepare(`PRAGMA table_xinfo(${quoteIdent(t.name)})`),
          db.prepare(`PRAGMA foreign_key_list(${quoteIdent(t.name)})`),
        ]),
      )
    : [];
  const tables: TableInfo[] = tableRows.map((t, i) => {
    const xinfo = pragmas[2 * i]!.results as { name: string; hidden: number; pk: number }[];
    const fks = pragmas[2 * i + 1]!.results as { table: string }[];
    const columns = xinfo.filter((c) => c.hidden === 0).map((c) => c.name);
    return {
      name: t.name,
      sql: t.sql!,
      columns,
      pk: xinfo.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
      withoutRowid: /\)\s*WITHOUT\s+ROWID\s*$/i.test(t.sql!),
      hasUpdatedAt: columns.includes('updated_at'),
      parents: [...new Set(fks.map((f) => f.table).filter((p) => p !== t.name))],
    };
  });
  return {
    master,
    tables,
    insertOrder: topoOrder(tables),
    hasSequence: master.some((m) => m.type === 'table' && m.name === 'sqlite_sequence'),
    sizeBytes: typeof sizeAfter === 'number' ? sizeAfter : null,
  };
}

/** Parents before children; cycles and unknown parents fall back to name order (FKs are deferred anyway). */
export function topoOrder(tables: readonly TableInfo[]): string[] {
  const names = new Set(tables.map((t) => t.name));
  const remaining = new Map(tables.map((t) => [t.name, t.parents.filter((p) => names.has(p))]));
  const out: string[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(([, ps]) => ps.every((p) => !remaining.has(p))).map(([n]) => n).sort();
    const next = ready.length ? ready : [[...remaining.keys()].sort()[0]!];
    for (const n of next) {
      out.push(n);
      remaining.delete(n);
    }
  }
  return out;
}

/** Rows whose INTEGER values D1 would silently round (|v| > 2^53 − 1). */
export function precisionCheckSql(t: TableInfo): string | null {
  if (t.columns.length === 0) return null;
  const cond = t.columns
    .map((c) => {
      const q = quoteIdent(c);
      return `(typeof(${q}) = 'integer' AND (${q} > 9007199254740991 OR ${q} < -9007199254740991))`;
    })
    .join(' OR ');
  return `SELECT count(*) AS n FROM ${quoteIdent(t.name)} WHERE ${cond}`;
}

export function orderBy(t: TableInfo): string {
  return t.withoutRowid ? t.pk.map(quoteIdent).join(', ') : 'rowid';
}

/** DDL that is replayed after the data: indexes, views, triggers (append-only triggers last). */
export function postDataDdl(master: readonly MasterRow[]): string[] {
  const userObj = (m: MasterRow) => m.sql !== null && isUserTable(m.name) && isUserTable(m.tbl_name);
  return [
    ...master.filter((m) => m.type === 'index' && userObj(m)),
    ...master.filter((m) => m.type === 'view' && userObj(m)),
    ...master.filter((m) => m.type === 'trigger' && userObj(m)),
  ].map((m) => m.sql!);
}
