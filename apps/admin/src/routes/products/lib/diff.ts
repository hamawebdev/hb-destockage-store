/**
 * Audit snapshots for updates (only changed fields, ACAT-0 plan §10) and the version bump used
 * by every optimistic-concurrency write.
 */
import { sql, type SQL } from 'drizzle-orm';

/** Only the fields that changed; values compared by JSON (arrays such as `translationPlaceholder`). */
export function changedFields<T extends object>(
  before: T,
  after: Partial<T>,
): { before: Partial<T>; after: Partial<T> } | null {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key];
      a[key] = after[key] as T[keyof T];
    }
  }
  return Object.keys(a).length === 0 ? null : { before: b, after: a };
}

/**
 * `updated_at = max(now, updated_at + 1)`: strictly increasing per row, so two writes in the same
 * millisecond still change the version that forms carry (db's DB-1 caveat). Bare column name, so
 * it is valid in any UPDATE.
 */
export function bumpUpdatedAt(now = Date.now()): SQL {
  return sql`max(${now}, ${sql.identifier('updated_at')} + 1)`;
}
