// Customer-data files (backup dumps, manifests, restored local D1 state) must never land inside a
// git worktree, where one `git add -A` would commit every customer's name, phone and address
// (review r1 F5). Node-only helpers for the restore scripts.
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export class InsideGitWorktreeError extends Error {
  override readonly name = 'InsideGitWorktreeError';
}

/** Nearest existing ancestor, resolved through symlinks. */
function realExisting(path: string): string {
  let p = resolve(path);
  while (!existsSync(p)) {
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  return realpathSync(p);
}

/** The enclosing git worktree root (a `.git` dir or file on the way up), or null. */
export function gitWorktreeOf(path: string): string | null {
  let p = realExisting(path);
  for (;;) {
    if (existsSync(join(p, '.git'))) return p;
    const up = dirname(p);
    if (up === p) return null;
    p = up;
  }
}

export function assertOutsideGitWorktree(path: string, what: string): void {
  const wt = gitWorktreeOf(path);
  if (wt) {
    throw new InsideGitWorktreeError(
      `${what} (${resolve(path)}) is inside the git worktree ${wt}. Backups hold customer personal data: ` +
        `use a directory outside any repository (default: a private folder under ${tmpdir()}).`,
    );
  }
}

/** A fresh owner-only (0700) directory outside any git worktree. */
export async function makePrivateDir(label: string, base = tmpdir()): Promise<string> {
  const dir = await mkdtemp(join(base, `hb-restore-${label.replace(/[^A-Za-z0-9_-]/g, '_')}-`));
  await chmod(dir, 0o700);
  try {
    assertOutsideGitWorktree(dir, 'working directory');
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}
