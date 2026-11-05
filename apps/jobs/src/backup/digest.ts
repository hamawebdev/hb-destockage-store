// Canonical per-table row digest, as agreed with `db` for DB-5 (`tableDigest`/`verifyRestore`):
// sha256 hex over rows in rowid order (PK order for WITHOUT ROWID), each row = JSON.stringify of
// its values in PRAGMA table_xinfo order (hidden/generated columns excluded), BLOBs as lowercase
// hex strings, rows joined with "\n".
// Interim shim with exactly those rules; replaced by @hb/db's helper when DB-5 lands.
import { createHash } from 'node:crypto';
import { blobBytes, toHex } from './sql.ts';

export interface TableDigest {
  rows: number;
  digest: string;
}

export function canonicalValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || v === null) return v;
  if (typeof v === 'bigint') return v.toString();
  const bytes = blobBytes(v);
  return bytes ? toHex(bytes) : v;
}

export function createRowDigest(columns: readonly string[]): { add(row: Record<string, unknown>): void; finish(): TableDigest } {
  const h = createHash('sha256');
  let rows = 0;
  return {
    add(row) {
      if (rows > 0) h.update('\n');
      h.update(JSON.stringify(columns.map((c) => canonicalValue(row[c]))));
      rows++;
    },
    finish() {
      return { rows, digest: h.digest('hex') };
    },
  };
}
