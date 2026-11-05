// Backup health, for operators and the admin dashboard. Holds no row data.
//   R2  d1/status.json       last success / last failure / last health check
//   R2  d1/in_progress.json  present while a run is in flight (a leftover = a killed run)
//   D1  settings['jobs.backup_status']  mirror of status.json, so the admin can show the age of the
//       last good backup even if the jobs Worker never runs (review r1 F2).
import type { BackupManifest } from './export.ts';

export const STATUS_KEY = 'd1/status.json';
export const IN_PROGRESS_KEY = 'd1/in_progress.json';
export const STATUS_SETTING = 'jobs.backup_status';

export interface BackupStatus {
  lastSuccess: {
    runId: string;
    at: string;
    key: string;
    mode: string;
    tables: number;
    rows: number;
    bytes: number;
    durationMs: number;
    schemaVersion: string | null;
  } | null;
  /** stage: discover | export | upload | consistency | killed | … */
  lastFailure: { runId: string; at: string; stage: string; error: string } | null;
  retention: { complete: number; inconsistent: number; deletedRuns: number } | null;
  health: { checkedAt: string; stale: boolean; lastSuccessAgeHours: number | null } | null;
}

export const EMPTY_STATUS: BackupStatus = { lastSuccess: null, lastFailure: null, retention: null, health: null };

export async function readStatus(bucket: R2Bucket): Promise<BackupStatus> {
  const obj = await bucket.get(STATUS_KEY);
  if (!obj) return { ...EMPTY_STATUS };
  try {
    return { ...EMPTY_STATUS, ...((await obj.json()) as Partial<BackupStatus>) };
  } catch {
    return { ...EMPTY_STATUS };
  }
}

export async function writeStatus(bucket: R2Bucket, db: D1Database | undefined, s: BackupStatus, now: number): Promise<void> {
  const text = JSON.stringify(s, null, 2);
  await bucket.put(STATUS_KEY, text, { httpMetadata: { contentType: 'application/json' } });
  if (db) {
    await db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(STATUS_SETTING, JSON.stringify(s), now)
      .run();
  }
}

export function successOf(m: BackupManifest): NonNullable<BackupStatus['lastSuccess']> {
  return {
    runId: m.runId,
    at: m.finishedAt,
    key: m.object.key,
    mode: m.mode,
    tables: m.tables.length,
    rows: m.tables.reduce((s, t) => s + t.rows, 0),
    bytes: m.object.bytes,
    durationMs: m.durationMs,
    schemaVersion: m.schemaVersion,
  };
}
