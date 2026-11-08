// DB-7 (lead: fix the class). Every migration in packages/db/migrations is checked step by step:
//  1. every `INSERT INTO t (…) SELECT "c", … FROM s` copy (drizzle-kit table rebuilds) names only
//     columns that exist in `s` at that point. D1 accepts an unknown double-quoted identifier as a
//     STRING literal and silently writes it into every row (0006 shipped from drizzle-kit like that).
//  2. after each step, PRAGMA table_info equals drizzle-kit's snapshot for that step
//     (meta/NNNN_snapshot.json: column names and NOT NULL).
//  3. with one row in every table loaded right after 0000, applying every later migration leaves no
//     text cell equal to a column name of its table. Run on SQLite AND on workerd D1, which is where
//     the literal fallback happens.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test, vi } from 'vitest';
import { MIGRATIONS_DIR, migrationFiles } from './helpers.ts';
import { freshD1Empty } from './d1.ts';

// The D1 case applies every migration statement by statement over RPC: slow on a loaded machine.
vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });

const files = migrationFiles();
const statements = (file: string) =>
  readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
const fixture = readFileSync(new URL('./fixtures/data-at-0000.sql', import.meta.url), 'utf8')
  .split(/;\n/)
  .map((s) => s.replace(/^--.*$/gm, '').trim())
  .filter(Boolean);

interface Snapshot {
  tables: Record<string, { columns: Record<string, { name: string; notNull: boolean }> }>;
}
const snapshot = (idx: number): Snapshot =>
  JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', `${String(idx).padStart(4, '0')}_snapshot.json`), 'utf8')) as Snapshot;

const INSERT_SELECT = /INSERT INTO\s+[`"]?(\w+)[`"]?\s*\(([^)]*)\)\s*SELECT\s+([\s\S]*?)\s+FROM\s+[`"]?(\w+)[`"]?/i;
const idents = (list: string) => [...list.matchAll(/"([^"]+)"|`([^`]+)`/g)].map((m) => m[1] ?? m[2]!);

function columnsOf(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare('select name from pragma_table_info(?)').all(table) as { name: string }[]).map((r) => r.name);
}

/** Problems with one INSERT … SELECT copy against the live schema; [] when fine. */
export function copyProblems(sqlite: Database.Database, stmt: string): string[] {
  const m = INSERT_SELECT.exec(stmt);
  if (!m) return [];
  const [, target, targetList, selectList, source] = m as unknown as [string, string, string, string, string];
  const out: string[] = [];
  const srcCols = new Set(columnsOf(sqlite, source));
  const tgtCols = new Set(columnsOf(sqlite, target));
  for (const c of idents(selectList)) if (!srcCols.has(c)) out.push(`${source}.${c} does not exist (copy into ${target})`);
  for (const c of idents(targetList)) if (!tgtCols.has(c)) out.push(`${target}.${c} does not exist`);
  return out;
}

describe('every migration, step by step (SQLite)', () => {
  test('copies name only existing columns, and the schema equals the drizzle-kit snapshot after each step', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const problems: string[] = [];
    files.forEach((file, idx) => {
      for (const stmt of statements(file)) {
        problems.push(...copyProblems(sqlite, stmt).map((p) => `${file}: ${p}`));
        try {
          sqlite.exec(stmt);
        } catch (e) {
          problems.push(`${file}: ${(e as Error).message}`);
        }
      }
      const snap = snapshot(idx);
      for (const [table, def] of Object.entries(snap.tables)) {
        const live = (sqlite.prepare('select name, "notnull" nn, pk from pragma_table_info(?)').all(table) as { name: string; nn: number; pk: number }[]).map(
          (r) => `${r.name}:${r.nn || r.pk ? 'NN' : ''}`,
        );
        const want = Object.values(def.columns).map((c) => `${c.name}:${c.notNull ? 'NN' : ''}`);
        if (JSON.stringify([...live].sort()) !== JSON.stringify([...want].sort())) problems.push(`${file}: ${table} is ${live.join(',')} but snapshot says ${want.join(',')}`);
      }
    });
    expect(problems).toEqual([]);
    // Migrations leave no scratch objects behind (0009's _db8_printed_prices_check is dropped):
    // the schema, the drizzle snapshot and backup dumps only hold Drizzle's tables.
    const live = (sqlite.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[]).map((r) => r.name).sort();
    expect(live).toEqual(Object.keys(snapshot(files.length - 1).tables).sort());
  });

  test('the lint catches the 0006 bug drizzle-kit generated (regression)', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('create table t (a integer, b text)');
    sqlite.exec('create table __new_t (a integer, b text, dead_at integer)');
    expect(copyProblems(sqlite, 'INSERT INTO `__new_t`("a", "b", "dead_at") SELECT "a", "b", "dead_at" FROM `t`;')).toEqual(['t.dead_at does not exist (copy into __new_t)']);
    expect(copyProblems(sqlite, 'INSERT INTO `__new_t`("a", "b") SELECT "a", "b" FROM `t`;')).toEqual([]);
  });
});

/** Text values (in any column) equal to a column name of their table: the trace of a double-quoted literal copy. */
async function columnNameValues(
  tables: string[],
  cols: (t: string) => Promise<{ name: string; type: string }[]>,
  count: (sql: string, names: string[]) => Promise<number>,
): Promise<string[]> {
  const out: string[] = [];
  for (const t of tables) {
    const c = await cols(t);
    const names = c.map((x) => x.name);
    // Every column, whatever its declared type (rev-c DB-7 r1 nit): the 0006 literal landed in an
    // INTEGER column; SQLite stores the text value there anyway.
    for (const col of c) {
      const n = await count(`select count(*) n from "${t}" where typeof("${col.name}") = 'text' and "${col.name}" in (${names.map(() => '?').join(', ')})`, names);
      if (n > 0) out.push(`${t}.${col.name}: ${n} row(s) hold a column name`);
    }
  }
  return out;
}

describe('0009 refuses existing rows that break the new printed-price rule', () => {
  test('a row printing 0 makes the migration abort (nothing silently kept or dropped)', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    for (const f of files.filter((f) => f < '0009')) for (const s of statements(f)) sqlite.exec(s);
    for (const s of fixture) sqlite.exec(s);
    sqlite.exec(`update images set printed_prices_dzd = '[0]' where id = 1`); // allowed by 0008
    const run0009 = () => {
      for (const f of files.filter((f) => f.startsWith('0009'))) for (const s of statements(f)) sqlite.exec(s);
    };
    expect(run0009).toThrow(/printed_prices_positive_existing_rows/);
  });
});

describe('data loaded at 0000 survives every later migration', () => {
  test('SQLite: no text cell equals a column name, no FK violation, every fixture row kept', async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    for (const s of statements(files[0]!)) sqlite.exec(s);
    for (const s of fixture) sqlite.exec(s);
    const tables = (sqlite.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    const before = Object.fromEntries(tables.map((t) => [t, (sqlite.prepare(`select count(*) n from "${t}"`).get() as { n: number }).n]));
    expect(Object.values(before).every((n) => n >= 1)).toBe(true);
    for (const f of files.slice(1)) for (const s of statements(f)) sqlite.exec(s);
    const bad = await columnNameValues(
      tables,
      async (t) => sqlite.prepare('select name, type from pragma_table_info(?)').all(t) as { name: string; type: string }[],
      async (q, names) => (sqlite.prepare(q).get(...names) as { n: number }).n,
    );
    expect(bad).toEqual([]);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    for (const t of tables) expect((sqlite.prepare(`select count(*) n from "${t}"`).get() as { n: number }).n, t).toBe(before[t]);
  });

  test('the generic check sees a column-name string in an INTEGER column (rev-c nit regression)', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec("create table t (a integer, dead_at integer); insert into t values (1, 'dead_at')");
    const bad = await columnNameValues(
      ['t'],
      async (t) => sqlite.prepare('select name, type from pragma_table_info(?)').all(t) as { name: string; type: string }[],
      async (q, names) => (sqlite.prepare(q).get(...names) as { n: number }).n,
    );
    expect(bad).toEqual(['t.dead_at: 1 row(s) hold a column name']);
  });

  test('workerd D1: the same, where an unknown "identifier" would silently become a string', async () => {
    const { d1, dispose } = await freshD1Empty();
    try {
      for (const s of statements(files[0]!)) await d1.prepare(s).run();
      for (const s of fixture) await d1.prepare(s).run();
      const tables = (await d1.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' and name <> 'd1_migrations'").all<{ name: string }>()).results.map((r) => r.name);
      for (const f of files.slice(1)) for (const s of statements(f)) await d1.prepare(s).run();
      const bad = await columnNameValues(
        tables,
        async (t) => (await d1.prepare('select name, type from pragma_table_info(?)').bind(t).all<{ name: string; type: string }>()).results,
        async (q, names) => (await d1.prepare(q).bind(...names).first<{ n: number }>())!.n,
      );
      expect(bad).toEqual([]);
      expect((await d1.prepare('select count(*) n from notification_deliveries where dead_at is null').first<{ n: number }>())!.n).toBe(1);
      // After the whole chain on real D1, the triggers still fire (DB-8 r1: 0009 replaced only triggers).
      await expect(d1.prepare("update images set printed_prices_dzd = '[0]' where id = 1").run()).rejects.toThrow(/positive integers/);
      await expect(d1.prepare('update audit_log set action = action').run()).rejects.toThrow(/append-only/);
      await expect(d1.prepare("update orders set ref = 'bad'").run()).rejects.toThrow(/orders.ref must match/);
      expect((await d1.prepare("select count(*) n from sqlite_master where name = '_db8_printed_prices_check'").first<{ n: number }>())!.n).toBe(0);
    } finally {
      await dispose();
    }
  });
});
