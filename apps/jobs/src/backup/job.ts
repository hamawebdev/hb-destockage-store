// Scheduled backup job and health check (JOBS-1).
//   backupJob:   killed-run check → export → retention → status (+ D1 mirror) → alerts.
//                An inconsistent snapshot is stored (marked) but treated as a FAILED run.
//   healthCheck: separate cron; alerts when the last good backup is older than 26 h, whatever the
//                reason (cron not firing, Worker killed, repeated failures). Review r1 F1/F2.
import { BackupError, runBackup, runIdFor, type BackupEnv, type BackupManifest, type BackupOptions } from './export.ts';
import { applyRetention, type RetentionOptions, type RetentionResult } from './retention.ts';
import { IN_PROGRESS_KEY, readStatus, successOf, writeStatus, type BackupStatus } from './status.ts';
import { log } from '../log.ts';

export type Alert = (subject: string, text: string, id: string) => Promise<void>;

export const STALE_AFTER_MS = 26 * 3_600_000;

export async function backupJob(
  env: BackupEnv,
  opts: BackupOptions & RetentionOptions & { alert?: Alert } = {},
): Promise<BackupManifest> {
  const now = opts.now ?? Date.now;
  const runId = runIdFor(opts.startedAt ?? now());
  const alert = (subject: string, text: string) =>
    safely('alert', () => opts.alert?.(subject, text, `backup-${runId}`) ?? Promise.resolve());
  const fail = async (failure: NonNullable<BackupStatus['lastFailure']>, extra: Partial<BackupStatus> = {}) => {
    await safely('status', async () => {
      const s = await readStatus(env.BACKUPS);
      await writeStatus(env.BACKUPS, env.DB, { ...s, ...extra, lastFailure: failure }, now());
    });
    await alert('Comptoir de Luxe backup FAILED', `Sauvegarde D1 ${failure.runId} : échec à l'étape « ${failure.stage} » (${failure.error}).`);
  };

  // A leftover in-progress marker means the previous run never reached its end (killed by a
  // CPU/memory limit or an outage): nothing else would have recorded or alerted it.
  await safely('in_progress', async () => {
    const left = await env.BACKUPS.get(IN_PROGRESS_KEY);
    if (left) {
      const prev = (await left.json().catch(() => ({}))) as { runId?: string };
      log('backup.previous_run_killed', { runId: prev.runId ?? 'unknown' });
      await fail({ runId: prev.runId ?? 'unknown', at: new Date(now()).toISOString(), stage: 'killed', error: 'NoCompletion' });
    }
    await env.BACKUPS.put(IN_PROGRESS_KEY, JSON.stringify({ runId, startedAt: new Date(now()).toISOString() }), {
      httpMetadata: { contentType: 'application/json' },
    });
  });

  let manifest: BackupManifest;
  try {
    manifest = await runBackup(env, opts);
  } catch (err) {
    const stage = err instanceof BackupError ? err.stage : 'unknown';
    const error = err instanceof BackupError ? err.causeClass : err instanceof Error ? err.name : 'unknown';
    await fail({ runId, at: new Date(now()).toISOString(), stage, error });
    await safely('in_progress', () => env.BACKUPS.delete(IN_PROGRESS_KEY));
    throw err;
  }

  let retention: RetentionResult | null = null;
  await safely('retention', async () => {
    retention = await applyRetention(env.BACKUPS, now(), opts);
    log('backup.retention', { runId, complete: retention.complete, inconsistent: retention.inconsistent, deletedRuns: retention.deletedRuns.length });
  });
  const r = retention as RetentionResult | null;
  const retentionStatus = r ? { complete: r.complete, inconsistent: r.inconsistent, deletedRuns: r.deletedRuns.length } : null;

  if (!manifest.consistent) {
    // Stored and marked INCONSISTENT, but it is not a good backup: failure everywhere.
    await fail(
      { runId, at: new Date(now()).toISOString(), stage: 'consistency', error: 'InconsistentSnapshot' },
      retentionStatus ? { retention: retentionStatus } : {},
    );
    await safely('in_progress', () => env.BACKUPS.delete(IN_PROGRESS_KEY));
    throw new BackupError('consistency', 'InconsistentSnapshot', `writes during export on all ${manifest.attempts} attempts`);
  }

  await safely('status', async () => {
    const s = await readStatus(env.BACKUPS);
    await writeStatus(env.BACKUPS, env.DB, { ...s, lastSuccess: successOf(manifest), retention: retentionStatus ?? s.retention }, now());
  });
  await safely('in_progress', () => env.BACKUPS.delete(IN_PROGRESS_KEY));
  return manifest;
}

/** Daily health check, independent of the backup run itself. Returns true when healthy. */
export async function backupHealthCheck(env: BackupEnv, opts: { now?: () => number; alert?: Alert; staleAfterMs?: number } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const s = await readStatus(env.BACKUPS);
  const lastAt = s.lastSuccess ? Date.parse(s.lastSuccess.at) : null;
  const age = lastAt === null ? null : now() - lastAt;
  const stale = age === null || age > (opts.staleAfterMs ?? STALE_AFTER_MS);
  const health = { checkedAt: new Date(now()).toISOString(), stale, lastSuccessAgeHours: age === null ? null : Math.round(age / 360_000) / 10 };
  await safely('status', () => writeStatus(env.BACKUPS, env.DB, { ...s, health }, now()));
  log('backup.health', { stale, lastSuccessAgeHours: health.lastSuccessAgeHours });
  if (stale) {
    await safely('alert', () =>
      opts.alert?.(
        'Comptoir de Luxe backup STALE',
        s.lastSuccess
          ? `Aucune sauvegarde D1 réussie depuis ${health.lastSuccessAgeHours} h (dernière : ${s.lastSuccess.runId}).`
          : 'Aucune sauvegarde D1 réussie enregistrée.',
        `backup-health-${health.checkedAt.slice(0, 10)}`,
      ) ?? Promise.resolve(),
    );
  }
  return !stale;
}

/** Secondary steps never fail a backup that is already stored; they log their error class. */
async function safely(step: string, f: () => Promise<unknown>): Promise<void> {
  try {
    await f();
  } catch (err) {
    log('backup.step_failed', { step, error: err instanceof Error ? err.name : typeof err });
  }
}
