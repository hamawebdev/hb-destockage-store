/**
 * The machine-wide exclusive Lighthouse lock (BRIEF §7; scripts/lib/locks.sh from TOOL-1).
 *
 * `npm run lh` may or may not already be wrapped in `scripts/lib/locks.sh exclusive lighthouse`.
 * We detect the wrapper by the lock's owner file: locks.sh writes `pid=<its shell pid>` there, and
 * if that pid is one of our ancestors while the lock is held, we already hold it. Otherwise the
 * CLI re-executes itself under locks.sh (or plain flock(1) if locks.sh is absent).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../lib/paths.ts';

export const LOCK_DIR = process.env['HB_LOCK_DIR'] ?? '/tmp/hb-locks';
export const LOCK_NAME = 'lighthouse';
const LOCKS_SH = path.join(REPO_ROOT, 'scripts/lib/locks.sh');

/** Parent pid chain of `pid` (from /proc), nearest first. */
export function ancestors(pid: number = process.pid): number[] {
  const out: number[] = [];
  let cur = pid;
  for (let i = 0; i < 64; i++) {
    let stat: string;
    try { stat = readFileSync(`/proc/${cur}/stat`, 'utf8'); } catch { break; }
    // field 4 (ppid) follows the ")" that closes the command name
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (!ppid || ppid === cur) break;
    out.push(ppid);
    cur = ppid;
  }
  return out;
}

/** pid recorded in the owner file (`… pid=<n> …`), or null. */
export function ownerPid(ownerText: string): number | null {
  const m = /\bpid=(\d+)/.exec(ownerText);
  return m ? Number(m[1]) : null;
}

/** True when the lock file is currently locked by someone (we cannot take it right now). */
function lockIsHeld(): boolean {
  const r = spawnSync('flock', ['-n', path.join(LOCK_DIR, `${LOCK_NAME}.lock`), 'true']);
  return r.status !== 0;
}

export function heldByAncestor(): boolean {
  const ownerFile = path.join(LOCK_DIR, `${LOCK_NAME}.owner`);
  if (!existsSync(ownerFile)) return false;
  const pid = ownerPid(readFileSync(ownerFile, 'utf8'));
  return pid !== null && ancestors().includes(pid) && lockIsHeld();
}

/**
 * Ensure this process runs under the exclusive Lighthouse lock. Returns null when it already
 * does; otherwise re-runs the same command under the lock and returns its exit code.
 */
export function ensureLock(argv: string[], waitSeconds = 3600): number | null {
  // HB_LH_LOCKED_BY is set only by the re-exec below: an ancestor with that pid took the lock for us
  const by = Number(process.env['HB_LH_LOCKED_BY']);
  if ((by && ancestors().includes(by) && lockIsHeld()) || heldByAncestor()) return null;
  const cmd = [process.execPath, ...process.execArgv, ...argv];
  mkdirSync(LOCK_DIR, { recursive: true });
  const env = { ...process.env, HB_LH_LOCKED_BY: String(process.pid) };
  const r = existsSync(LOCKS_SH)
    ? spawnSync(LOCKS_SH, ['exclusive', LOCK_NAME, '--wait', String(waitSeconds), '--', ...cmd], { stdio: 'inherit', cwd: REPO_ROOT, env })
    : spawnSync('flock', ['-x', '-w', String(waitSeconds), path.join(LOCK_DIR, `${LOCK_NAME}.lock`), ...cmd], { stdio: 'inherit', env });
  if (r.error) { console.error(`lh: cannot take the lighthouse lock: ${r.error.message}`); return 2; }
  return r.status ?? 2;
}
