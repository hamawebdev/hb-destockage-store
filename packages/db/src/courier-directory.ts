// Cached courier lists (SHIP-0 contract rule 17). The admin and jobs both refresh them through this
// one function; the callers supply the courier calls, so @hb/db does not depend on @hb/couriers.
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './index.ts';
import { courierDirectory } from './schema.ts';
import type { CourierDirectoryKind } from './enums.ts';

/** Older than this, a list is refreshed when a refresh is affordable; stale beats nothing. */
export const DIRECTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DIRECTORY_CONCURRENCY = 3;
/** One row must fit the backup's statement limit (CHECK in migration 0011). */
export const DIRECTORY_MAX_PAYLOAD_BYTES = 80_000;

/** Bytes the row takes in a backup statement: the backup doubles each `'` (rev-i, SHIP-1 review nit 2). */
export function payloadBackupBytes(json: string): number {
  let quotes = 0;
  for (const ch of json) if (ch === "'") quotes++;
  return new TextEncoder().encode(json).length + quotes;
}

export interface DirectoryKey {
  readonly kind: CourierDirectoryKind;
  /** The order's 69-wilaya code; 0 for the courier-wide wilaya list. */
  readonly wilayaCode: number;
}

export interface DirectoryRow extends DirectoryKey {
  readonly payload: unknown[];
  readonly fetchedAt: number;
}

export async function readDirectory(db: Db, courier: string, wilayaCodes: readonly number[]): Promise<DirectoryRow[]> {
  const rows = await db
    .select()
    .from(courierDirectory)
    .where(and(eq(courierDirectory.courier, courier), inArray(courierDirectory.wilayaCode, [0, ...new Set(wilayaCodes)])));
  return rows.map((r) => ({ kind: r.kind, wilayaCode: r.wilayaCode, payload: r.payload, fetchedAt: r.fetchedAt }));
}

export interface DirectoryTask extends DirectoryKey {
  readonly fetch: (timeoutMs: number) => Promise<{ readonly ok: true; readonly items: readonly unknown[] } | { readonly ok: false }>;
}

/**
 * Runs as many of `tasks` as one total budget allows. A failed or skipped task leaves the cached
 * list alone. Never throws for a courier or size problem: a page can always render without it.
 */
export async function refreshDirectory(db: Db, courier: string, tasks: readonly DirectoryTask[], opts: { readonly budgetMs: number; readonly perCallMs: number; readonly now?: () => number }): Promise<void> {
  const now = opts.now ?? Date.now;
  const end = now() + opts.budgetMs;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const task = tasks[next++];
      const remaining = end - now();
      if (!task || remaining <= 0) return;
      const result = await task.fetch(Math.min(opts.perCallMs, remaining));
      if (!result.ok) continue;
      const payload = [...result.items];
      if (payloadBackupBytes(JSON.stringify(payload)) > DIRECTORY_MAX_PAYLOAD_BYTES) continue;
      const fetchedAt = now();
      await db
        .insert(courierDirectory)
        .values({ courier, kind: task.kind, wilayaCode: task.wilayaCode, payload, fetchedAt })
        .onConflictDoUpdate({ target: [courierDirectory.courier, courierDirectory.kind, courierDirectory.wilayaCode], set: { payload, fetchedAt } });
    }
  };
  await Promise.all(Array.from({ length: DIRECTORY_CONCURRENCY }, worker));
}
