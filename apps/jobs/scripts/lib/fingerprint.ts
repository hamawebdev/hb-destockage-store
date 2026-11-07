// Build fingerprint for the JOBS-7 budget mode (Node only).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildFingerprint } from '../../src/publish/budget-mode.ts';

/**
 * Every path whose change can alter the built pages, their headers, or the budget verdict itself
 * (lead ruling: storefront, web's static serving/headers/CSP, catalogue builders, tokens, shared
 * formatters, brand copy and assets, measure's budget config/thresholds, the dependency set).
 */
export const TEMPLATE_PATHS = [
  'apps/storefront',
  'apps/web',
  'packages/catalog/src',
  'packages/ui-tokens',
  'packages/shared/src',
  'brand',
  'tools/measure',
  'package.json',
  'package-lock.json',
] as const;

/** JSON with object keys sorted at every level, so key order never changes the digest. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The repository root (apps/jobs/scripts/lib → ../../../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/**
 * The last good build's fingerprint, on the build machine (gitignored). Written only by a
 * publish whose budget passed; read by the nightly pass; never by the admin.
 */
export const LAST_GOOD_FILE = join(REPO_ROOT, '.wrangler/publish/last-good.json');

/**
 * measure's verdict line from budget.txt: the last "BUDGET OK…" / "BUDGET FAILED…" line. With
 * --static-only the file ends with a "(runtime pass skipped …)" note, so the last line is not it.
 */
export function budgetVerdict(budgetTxt: string): string {
  const lines = budgetTxt.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.filter((l) => /^BUDGET (OK|FAILED)\b/.test(l)).at(-1) ?? lines.at(-1) ?? '';
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split('\n').at(-1) ?? ''}`);
  return r.stdout;
}

export function buildFingerprint(repo: string, imageManifest: string, paths: readonly string[] = TEMPLATE_PATHS): BuildFingerprint {
  const images = existsSync(imageManifest) ? sha(stableStringify(JSON.parse(readFileSync(imageManifest, 'utf8')))) : sha('no image manifest');
  // Blob ids of every tracked file under the paths: any content change changes the hash.
  const template = sha(git(repo, ['ls-files', '-s', '--', ...paths]));
  // Tracked modifications and untracked (non-ignored) files: the hash above cannot vouch for them.
  // Generated outputs (public/img, .catalog, dist, …) are gitignored and do not count.
  const dirty = git(repo, ['status', '--porcelain', '--', ...paths]).trim() !== '';
  return { images, template, dirty };
}
