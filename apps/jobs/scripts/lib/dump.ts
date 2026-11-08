// Integrity of a downloaded backup against its manifest: gzip sha256, then raw SQL sha256.
// The raw bytes returned are exactly the ones verified, so the caller loads what was checked.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { VerifiableManifest } from '../../src/backup/verify.ts';

export interface RestoreManifest extends VerifiableManifest {
  formatVersion: number;
  runId: string;
  consistent: boolean;
  object: { sha256: string; rawSha256: string };
}

export function readManifest(file: string): RestoreManifest {
  const m = JSON.parse(readFileSync(file, 'utf8')) as RestoreManifest;
  if (m.formatVersion !== 2 || typeof m.schemaSha256 !== 'string' || !Array.isArray(m.tables)) {
    throw new Error(`unsupported manifest (formatVersion ${String(m.formatVersion)}; this tool reads format 2)`);
  }
  return m;
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export function checkDump(gzFile: string, m: RestoreManifest): { ok: true; raw: Buffer } | { ok: false; reason: string } {
  const gz = readFileSync(gzFile);
  if (sha(gz) !== m.object.sha256) return { ok: false, reason: 'gzip sha256 does not match the manifest' };
  let raw: Buffer;
  try {
    raw = gunzipSync(gz);
  } catch {
    return { ok: false, reason: 'gzip is corrupt' };
  }
  if (sha(raw) !== m.object.rawSha256) return { ok: false, reason: 'SQL sha256 does not match the manifest' };
  return { ok: true, raw };
}
