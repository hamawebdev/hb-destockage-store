// Retention for d1/ backups: delete runs older than `retentionDays`, but always keep the
// `keepLatest` newest complete runs (a stopped cron must never empty the bucket). Runs without a
// manifest (failed uploads) are removed after `orphanGraceMs`.
import { BACKUP_PREFIX } from './export.ts';

export interface RetentionOptions {
  retentionDays?: number;
  keepLatest?: number;
  orphanGraceMs?: number;
}

export interface RetentionResult {
  complete: number;
  kept: string[];
  deletedRuns: string[];
  deletedObjects: number;
}

const RUN_RE = /^d1\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})(\d{2})Z\//;

export function runTime(key: string): number | null {
  const m = RUN_RE.exec(key);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

export async function listAll(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function applyRetention(bucket: R2Bucket, now: number, opts: RetentionOptions = {}): Promise<RetentionResult> {
  const retentionMs = (opts.retentionDays ?? 35) * 86_400_000;
  const keepLatest = opts.keepLatest ?? 7;
  const orphanGraceMs = opts.orphanGraceMs ?? 86_400_000;

  const runs = new Map<string, { at: number; keys: string[]; complete: boolean }>();
  for (const key of await listAll(bucket, BACKUP_PREFIX)) {
    const at = runTime(key);
    if (at === null) continue; // status.json and anything foreign is never touched
    const run = key.slice(0, RUN_RE.exec(key)![0].length);
    const r = runs.get(run) ?? { at, keys: [], complete: false };
    r.keys.push(key);
    if (key === `${run}manifest.json`) r.complete = true;
    runs.set(run, r);
  }
  const complete = [...runs].filter(([, r]) => r.complete).sort((a, b) => b[1].at - a[1].at);
  const protectedRuns = new Set(complete.slice(0, keepLatest).map(([k]) => k));

  const doomed = [...runs].filter(([run, r]) => {
    if (protectedRuns.has(run)) return false;
    const age = now - r.at;
    return r.complete ? age > retentionMs : age > orphanGraceMs;
  });
  const keys = doomed.flatMap(([, r]) => r.keys);
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
  return {
    complete: complete.length,
    kept: [...protectedRuns],
    deletedRuns: doomed.map(([k]) => k).sort(),
    deletedObjects: keys.length,
  };
}
