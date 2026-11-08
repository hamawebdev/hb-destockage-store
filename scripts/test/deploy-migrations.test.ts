import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyMigration, MigrationOrderError, parseStatements, pendingSetHash, planMigrations, type MigrationFile } from '../deploy/migrations.ts';

const add: MigrationFile = { name: '0010_add.sql', content: 'ALTER TABLE `products` ADD `note` text;' };
const drop: MigrationFile = { name: '0011_drop.sql', content: 'DROP TABLE `old_things`;' };

describe('classifyMigration', () => {
  const destructive: [string, string][] = [
    ['DROP TABLE', 'DROP TABLE products;'],
    ['DROP TABLE lower case', 'drop table if exists "products";'],
    ['DROP COLUMN', 'ALTER TABLE products DROP COLUMN note;'],
    ['DROP without COLUMN keyword', 'ALTER TABLE products DROP note;'],
    ['RENAME table', 'ALTER TABLE products RENAME TO goods;'],
    ['RENAME column', 'ALTER TABLE products RENAME COLUMN a TO b;'],
    ['DELETE', 'DELETE FROM orders WHERE 1;'],
    ['UPDATE', "UPDATE variants SET stock = 0;"],
    ['REPLACE', "REPLACE INTO settings (key, value) VALUES ('a', '1');"],
    ['INSERT OR REPLACE', "INSERT OR REPLACE INTO settings (key, value) VALUES ('a', '1');"],
    ['upsert', "INSERT INTO settings (key, value) VALUES ('a', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value;"],
    ['unknown statement', 'VACUUM;'],
    ['CTE write', 'WITH x AS (SELECT 1) DELETE FROM orders;'],
    ['unknown pragma', 'PRAGMA writable_schema = ON;'],
  ];
  it.each(destructive)('flags %s', (_label, sql) => {
    expect(classifyMigration(sql).length).toBeGreaterThan(0);
  });

  it('flags a drizzle table rebuild and names it', () => {
    const sql = [
      'PRAGMA defer_foreign_keys = on;',
      'CREATE TABLE `__new_products` (`id` integer PRIMARY KEY);',
      'INSERT INTO `__new_products` (`id`) SELECT `id` FROM `products`;',
      'DROP TABLE `products`;',
      'ALTER TABLE `__new_products` RENAME TO `products`;',
    ].join('\n--> statement-breakpoint\n');
    const reasons = classifyMigration(sql);
    expect(reasons[0]).toMatch(/rebuild/);
    expect(reasons.some((r) => r.startsWith('DROP TABLE'))).toBe(true);
    expect(reasons.some((r) => r.includes('RENAME'))).toBe(true);
  });

  it.each([
    ['CREATE TABLE', 'CREATE TABLE t (id integer primary key);'],
    ['ADD COLUMN', 'ALTER TABLE t ADD COLUMN c text;'],
    ['CREATE INDEX', 'CREATE UNIQUE INDEX i ON t (c);'],
    ['plain INSERT', "INSERT INTO t (id) VALUES (1);"],
    ['INSERT OR IGNORE', 'INSERT OR IGNORE INTO t (id) VALUES (1);'],
    ['DROP INDEX', 'DROP INDEX i;'],
    ['DROP TRIGGER', 'DROP TRIGGER tr;'],
    ['defer pragma', 'PRAGMA defer_foreign_keys = on;'],
  ])('accepts %s', (_label, sql) => {
    expect(classifyMigration(sql)).toEqual([]);
  });

  it('is not fooled by keywords in comments or strings', () => {
    expect(classifyMigration("-- DROP TABLE a\n/* DELETE FROM b */\nINSERT INTO t (x) VALUES ('DROP TABLE c; DELETE FROM d');")).toEqual([]);
  });

  it('keeps trigger bodies whole, including writes and CASE inside them', () => {
    const sql = `CREATE TRIGGER tr AFTER INSERT ON t BEGIN
      UPDATE u SET n = CASE WHEN NEW.a THEN 1 ELSE 2 END;
      DELETE FROM v WHERE id = NEW.id;
    END;
    DROP TABLE after_trigger;`;
    expect(parseStatements(sql)).toHaveLength(2);
    const reasons = classifyMigration(sql);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/after_trigger/);
  });

  it('does not hide a statement after a string containing a semicolon', () => {
    expect(classifyMigration("INSERT INTO t (a) VALUES ('x;y'); DELETE FROM t;").length).toBe(1);
  });

  it('finds 0006 (a real rebuild in this repo) destructive', () => {
    const dir = join(import.meta.dirname, '../../packages/db/migrations');
    const name = readdirSync(dir).find((n) => n.startsWith('0006_'))!;
    expect(classifyMigration(readFileSync(join(dir, name), 'utf8')).length).toBeGreaterThan(0);
  });
});

describe('planMigrations', () => {
  const base = { approval: '', userTables: 5 };

  it('applies additive migrations without approval', () => {
    const p = planMigrations({ ...base, files: [add], applied: [] , userTables: 5 });
    expect(p.action).toBe('apply');
  });

  it('halts on a destructive pending set when data exists', () => {
    const p = planMigrations({ ...base, files: [add, drop], applied: [add.name] });
    expect(p.action).toBe('halt');
    expect(p.hash).toBe(pendingSetHash([drop]));
  });

  it('applies a destructive set only with the matching sha256', () => {
    const hash = pendingSetHash([drop]);
    expect(planMigrations({ ...base, files: [add, drop], applied: [add.name], approval: hash }).action).toBe('apply');
    expect(planMigrations({ ...base, files: [add, drop], applied: [add.name], approval: 'f'.repeat(64) }).action).toBe('halt');
  });

  it('an approval stops matching when the migration changes', () => {
    const hash = pendingSetHash([drop]);
    const changed = { ...drop, content: `${drop.content}\nDELETE FROM x;` };
    expect(planMigrations({ ...base, files: [add, changed], applied: [add.name], approval: hash }).action).toBe('halt');
  });

  it('does not halt the first deployment: nothing applied and no tables', () => {
    const p = planMigrations({ files: [drop], applied: [], userTables: 0, approval: '' });
    expect(p.firstDeployment).toBe(true);
    expect(p.action).toBe('apply');
  });

  it('halts when nothing is applied but tables exist (not a fresh database)', () => {
    const p = planMigrations({ files: [drop], applied: [], userTables: 3, approval: '' });
    expect(p.firstDeployment).toBe(false);
    expect(p.action).toBe('halt');
  });

  it('nothing pending is a no-op', () => {
    expect(planMigrations({ ...base, files: [add], applied: [add.name] }).action).toBe('none');
  });

  it('applies in name order whatever the file order', () => {
    const p = planMigrations({ ...base, files: [drop, add], applied: [] });
    expect(p.pending.map((m) => m.name)).toEqual([add.name, drop.name]);
  });

  it('refuses a pending migration older than one already applied', () => {
    expect(() => planMigrations({ ...base, files: [add, drop], applied: [drop.name] })).toThrow(MigrationOrderError);
  });

  it('warns about applied migrations missing from this commit', () => {
    expect(planMigrations({ ...base, files: [add], applied: [add.name, '0099_newer.sql'] }).warnings).toHaveLength(1);
  });
});
