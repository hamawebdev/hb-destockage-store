// publish_runs lifecycle (DB-1 table; contract agreed with admin-catalog, ACAT-0 plan §8.3).
// Admin inserts {status:'queued'}; a partial unique index allows one queued/running row at a time.

export const LOG_TAIL_MAX = 4096;

export interface FinishedRun {
  status: 'succeeded' | 'failed';
  finishedAt: number;
  snapshotSha256: string | null;
  productCount: number | null;
  buildMs: number;
  timings: Record<string, number>;
  budgetOk: boolean | null;
  /** One line, no secrets. */
  error: string | null;
  logTail: string;
}

/** Claims the oldest queued run; null when there is none. */
export async function claimRun(db: D1Database, now: number): Promise<number | null> {
  const row = await db
    .prepare(
      `UPDATE publish_runs SET status = 'running', started_at = ?1
        WHERE id = (SELECT id FROM publish_runs WHERE status = 'queued' ORDER BY id LIMIT 1) AND status = 'queued'
        RETURNING id`,
    )
    .bind(now)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/**
 * Records the outcome. Conditional on the run still being 'running': the admin's owner-only
 * "Abandon" may have failed it meanwhile. Returns false in that case (nothing written).
 */
export async function finishRun(db: D1Database, id: number, r: FinishedRun): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE publish_runs SET status = ?2, finished_at = ?3, snapshot_sha256 = ?4, product_count = ?5, build_ms = ?6,
              timings_json = ?7, budget_ok = ?8, error = ?9, log_tail = ?10
        WHERE id = ?1 AND status = 'running'`,
    )
    .bind(
      id,
      r.status,
      r.finishedAt,
      r.snapshotSha256,
      r.productCount,
      r.buildMs,
      JSON.stringify(r.timings),
      r.budgetOk === null ? null : r.budgetOk ? 1 : 0,
      r.error === null ? null : oneLine(r.error),
      clampTail(r.logTail),
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Local convenience (`npm run publish -- --enqueue`): queue a run as the admin's Publish button would. */
export async function enqueueRun(db: D1Database): Promise<number | null> {
  try {
    const row = await db.prepare(`INSERT INTO publish_runs (status) VALUES ('queued') RETURNING id`).first<{ id: number }>();
    return row?.id ?? null;
  } catch {
    return null; // one queued/running run already exists (partial unique index)
  }
}

export function oneLine(s: string, max = 300): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Keeps the end of the log within the column's CHECK (length ≤ 4096 characters). */
export function clampTail(s: string, max = LOG_TAIL_MAX): string {
  if (s.length <= max) return s;
  return `…${s.slice(s.length - (max - 1))}`;
}
