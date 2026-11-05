// The scheduled backup job: export → retention → status, with an alert on failure or on an
// inconsistent (writes-during-export) snapshot.
import { BackupError, runBackup, runIdFor, type BackupEnv, type BackupManifest, type BackupOptions } from './export.ts';
import { applyRetention, type RetentionOptions } from './retention.ts';
import { readStatus, successOf, writeStatus } from './status.ts';
import { log } from '../log.ts';

export type Alert = (subject: string, text: string, id: string) => Promise<void>;

export async function backupJob(
  env: BackupEnv,
  opts: BackupOptions & RetentionOptions & { alert?: Alert } = {},
): Promise<BackupManifest> {
  const now = opts.now ?? Date.now;
  const startedAt = opts.startedAt ?? now();
  const runId = runIdFor(startedAt);
  let manifest: BackupManifest;
  try {
    manifest = await runBackup(env, { ...opts, startedAt });
  } catch (err) {
    const stage = err instanceof BackupError ? err.stage : 'unknown';
    const error = err instanceof BackupError ? err.causeClass : err instanceof Error ? err.name : 'unknown';
    await safely('status', async () => {
      const s = await readStatus(env.BACKUPS);
      await writeStatus(env.BACKUPS, { ...s, lastFailure: { runId, at: new Date(now()).toISOString(), stage, error } });
    });
    await safely('alert', () => opts.alert?.('HB backup FAILED', `Sauvegarde D1 ${runId} : échec à l'étape « ${stage} » (${error}).`, `backup-${runId}`) ?? Promise.resolve());
    throw err;
  }

  let retention: Awaited<ReturnType<typeof applyRetention>> | null = null;
  await safely('retention', async () => {
    retention = await applyRetention(env.BACKUPS, now(), opts);
    log('backup.retention', { runId, complete: retention.complete, deletedRuns: retention.deletedRuns.length, deletedObjects: retention.deletedObjects });
  });
  await safely('status', async () => {
    const s = await readStatus(env.BACKUPS);
    const r = retention as Awaited<ReturnType<typeof applyRetention>> | null;
    await writeStatus(env.BACKUPS, {
      ...s,
      lastSuccess: successOf(manifest),
      retention: r ? { complete: r.complete, deletedRuns: r.deletedRuns.length } : s.retention,
    });
  });
  if (!manifest.consistent) {
    await safely('alert', () =>
      opts.alert?.('HB backup: writes during export', `Sauvegarde D1 ${runId} enregistrée mais marquée « consistent: false » après ${manifest.attempts} tentatives.`, `backup-${runId}`) ?? Promise.resolve(),
    );
  }
  return manifest;
}

/** Secondary steps never fail a backup that is already stored; they log their error class. */
async function safely(step: string, f: () => Promise<void>): Promise<void> {
  try {
    await f();
  } catch (err) {
    log('backup.step_failed', { step, error: err instanceof Error ? err.name : typeof err });
  }
}
