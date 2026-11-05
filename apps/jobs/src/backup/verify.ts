// Interim shim of DB-5's `verifyRestore(db, manifest)` (owner `db`), same signature and digest
// rules (backup/digest.ts). Swapped for the @hb/db export when DB-5 lands.
import { createRowDigest, type TableDigest } from './digest.ts';
import { discover, orderBy, type TableInfo } from './schema.ts';
import { quoteIdent } from './sql.ts';

export interface VerifiableManifest {
  schemaVersion: string | null;
  tables: ({ name: string } & TableDigest)[];
}

export interface Mismatch {
  table: string;
  expected: TableDigest | string | null;
  actual: TableDigest | string | null;
}

export async function tableDigest(db: D1Database, table: string, pageSize = 1000): Promise<TableDigest> {
  const schema = await discover(db);
  const t = schema.tables.find((x) => x.name === table);
  if (!t) throw new Error(`no such table ${table}`);
  return digestTable(db, t, pageSize);
}

async function digestTable(db: D1Database, t: TableInfo, pageSize = 1000): Promise<TableDigest> {
  const digest = createRowDigest(t.columns);
  for (let offset = 0; ; offset += pageSize) {
    const { results } = await db
      .prepare(`SELECT * FROM ${quoteIdent(t.name)} ORDER BY ${orderBy(t)} LIMIT ?1 OFFSET ?2`)
      .bind(pageSize, offset)
      .all<Record<string, unknown>>();
    for (const row of results) digest.add(row);
    if (results.length < pageSize) break;
  }
  return digest.finish();
}

export async function verifyRestore(db: D1Database, manifest: VerifiableManifest): Promise<{ ok: boolean; mismatches: Mismatch[] }> {
  const schema = await discover(db);
  const byName = new Map(schema.tables.map((t) => [t.name, t]));
  const present = new Set(byName.keys());
  const mismatches: Mismatch[] = [];
  for (const expected of manifest.tables) {
    if (!present.has(expected.name)) {
      mismatches.push({ table: expected.name, expected: { rows: expected.rows, digest: expected.digest }, actual: null });
      continue;
    }
    const actual = await digestTable(db, byName.get(expected.name)!);
    if (actual.rows !== expected.rows || actual.digest !== expected.digest) {
      mismatches.push({ table: expected.name, expected: { rows: expected.rows, digest: expected.digest }, actual });
    }
  }
  const inManifest = new Set(manifest.tables.map((t) => t.name));
  for (const t of schema.tables) if (!inManifest.has(t.name)) mismatches.push({ table: t.name, expected: null, actual: 'present' });
  if (present.has('d1_migrations')) {
    const last = await db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first<{ name: string }>();
    if ((last?.name ?? null) !== manifest.schemaVersion) {
      mismatches.push({ table: '(schemaVersion)', expected: manifest.schemaVersion, actual: last?.name ?? null });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
