// Nightly full byte-budget pass (incl. the Chrome runtime pass) on the last good build (JOBS-7).
// Runs as a Node script on the build machine (a Worker cron cannot launch Chrome). Records the
// result in D1 settings['jobs.runtime_budget'] for the ADMIN-5 dashboard tile (red when ok is
// false or `at` is older than 26 h). Never deploys, never touches last-good.json.

export const RUNTIME_BUDGET_KEY = 'jobs.runtime_budget';

export interface RuntimeBudgetStatus {
  at: number;
  ok: boolean;
  /** measure's verdict line, e.g. "BUDGET OK: 105 pages, 16 rules". */
  summary: string;
  /** The last succeeded publish run this build came from (null if none recorded). */
  publishRunId: number | null;
  /** Fingerprint of the checked build (from last-good.json), or null if unknown. */
  fingerprint: { images: string; template: string } | null;
}

export async function lastSucceededRun(db: D1Database): Promise<number | null> {
  const r = await db.prepare(`SELECT id FROM publish_runs WHERE status = 'succeeded' ORDER BY finished_at DESC, id DESC LIMIT 1`).first<{ id: number }>();
  return r?.id ?? null;
}

export async function recordRuntimeBudget(db: D1Database, s: RuntimeBudgetStatus): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(RUNTIME_BUDGET_KEY, JSON.stringify(s), s.at)
    .run();
}
