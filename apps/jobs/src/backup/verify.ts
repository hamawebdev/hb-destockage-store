// Restore verification: the single implementation lives in @hb/db/backup (DB-5, owner `db`):
// per-table rows + digest, tables missing on either side, migration version and schema hash.
import type { BackupManifest } from '@hb/db/backup';
export { tableDigest, verifyRestore, type RestoreMismatch as Mismatch } from '@hb/db/backup';

/** What verifyRestore needs from a JOBS-1 manifest. */
export type VerifiableManifest = BackupManifest;
