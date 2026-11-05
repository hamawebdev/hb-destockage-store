// d1/status.json: last success and last failure, for the admin's backup-health display.
// Holds no row data.
import type { BackupManifest } from './export.ts';

export const STATUS_KEY = 'd1/status.json';

export interface BackupStatus {
  lastSuccess: {
    runId: string;
    at: string;
    key: string;
    mode: string;
    consistent: boolean;
    tables: number;
    rows: number;
    bytes: number;
    durationMs: number;
    schemaVersion: string | null;
  } | null;
  lastFailure: { runId: string; at: string; stage: string; error: string } | null;
  retention: { complete: number; deletedRuns: number } | null;
}

export async function readStatus(bucket: R2Bucket): Promise<BackupStatus> {
  const obj = await bucket.get(STATUS_KEY);
  if (!obj) return { lastSuccess: null, lastFailure: null, retention: null };
  try {
    return (await obj.json()) as BackupStatus;
  } catch {
    return { lastSuccess: null, lastFailure: null, retention: null };
  }
}

export async function writeStatus(bucket: R2Bucket, s: BackupStatus): Promise<void> {
  await bucket.put(STATUS_KEY, JSON.stringify(s, null, 2), { httpMetadata: { contentType: 'application/json' } });
}

export function successOf(m: BackupManifest): NonNullable<BackupStatus['lastSuccess']> {
  return {
    runId: m.runId,
    at: m.finishedAt,
    key: m.object.key,
    mode: m.mode,
    consistent: m.consistent,
    tables: m.tables.length,
    rows: m.tables.reduce((s, t) => s + t.rows, 0),
    bytes: m.object.bytes,
    durationMs: m.durationMs,
    schemaVersion: m.schemaVersion,
  };
}
