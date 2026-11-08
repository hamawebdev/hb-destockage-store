import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the checkout (or worktree) this file lives in. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Default built storefront. */
export const DEFAULT_DIST = path.join(REPO_ROOT, 'apps/storefront/dist');

/**
 * Shared artifacts directory. Artifacts live in the MAIN checkout (BRIEF §6.10), so from a
 * worktree we resolve the git common dir and use its parent. `HB_ARTIFACTS` overrides.
 */
export function artifactsRoot(): string {
  const env = process.env['HB_ARTIFACTS'];
  if (env) return path.resolve(env);
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (common) return path.join(path.dirname(common), 'artifacts');
  } catch {
    /* not a git checkout */
  }
  return path.join(REPO_ROOT, 'artifacts');
}

/** Recursively list files under `dir` as sorted POSIX paths relative to it. */
export function walk(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string, rel: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) rec(dir, '');
  return out.sort();
}
