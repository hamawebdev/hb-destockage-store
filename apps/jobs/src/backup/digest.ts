// Canonical per-table row digest: the single implementation lives in @hb/db/backup (DB-5, owner
// `db`), with the rules agreed for JOBS-1 (rowid/PK order, JSON array per row in table_xinfo order,
// BLOBs as lowercase hex, rows joined with "\n", sha256 hex).
export { canonicalValue, createRowDigest, digestRows, type TableDigest } from '@hb/db/backup';
