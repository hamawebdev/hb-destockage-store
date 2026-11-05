/**
 * Batch-aborting guards (ACAT-0 plan §4.1, §7.3).
 *
 * A D1 batch is a transaction, but a conditional UPDATE that matches 0 rows does not fail it. When
 * several statements must all apply or none (variant grid, options + matrix, fees), the batch starts
 * with guards: each one inserts a NULL into `audit_log.action` (NOT NULL) **only when its expected
 * state no longer holds**, which aborts the whole batch. When the state holds, the guard inserts
 * nothing. `audit_log` is append-only (its triggers stop UPDATE/DELETE, not INSERT), and a guard
 * never writes a row there.
 *
 * The handler recognises the abort with `isGuardAbort(err)` and answers "modified meanwhile, reload".
 */
import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { auditLog, type Db } from '@hb/db';

/**
 * Aborts the batch unless `holds` (a SQL boolean) is true when this statement runs. The SELECT
 * list mirrors `audit_log`'s insertable columns (as admin-core's `audit()` does), with `action`
 * NULL and everything else harmless.
 */
export function guard(db: Db, holds: SQL): BatchItem<'sqlite'> {
  const cols = Object.entries(getTableColumns(auditLog)).filter(
    ([, col]) => !(col as unknown as { shouldDisableInsert(): boolean }).shouldDisableInsert(),
  );
  const list = sql.join(
    cols.map(([key]) => (key === 'actorType' ? sql`'admin'` : key === 'at' ? sql`0` : sql`null`)),
    sql`, `,
  );
  return db.insert(auditLog).select(sql`select ${list} where not (${holds})`);
}

/** Aborts unless the row `table.id = id` still has `updated_at = version`. */
export function versionGuard(db: Db, table: 'products' | 'variants' | 'categories' | 'delivery_fees' | 'content_pages' | 'images', idColumn: string, id: number, version: number): BatchItem<'sqlite'> {
  return guard(
    db,
    sql`exists (select 1 from ${sql.identifier(table)} where ${sql.identifier(idColumn)} = ${id} and updated_at = ${version})`,
  );
}

export function isGuardAbort(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${(err as { cause?: unknown }).cause instanceof Error ? ((err as { cause: Error }).cause.message) : ''}` : String(err);
  return /NOT NULL constraint failed: audit_log\.action/.test(text);
}
