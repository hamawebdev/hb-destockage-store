// Shared helpers for the tooling tests (TOOL-1 team-tooling.test.ts, TOOL-5 merge.test.ts).
// Each test builds a throwaway git repo and runs the real scripts.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const src = fileURLToPath(new URL('../..', import.meta.url));
export const tmpRoots: string[] = [];
export const cleanupTmp = () => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
};

export const GOOD_BODY = 'What changed: x\nTesting: y\nRisk tier: low\nRevert: git revert\n';
export const msg = (subject: string, body = GOOD_BODY) => `${subject}\n\n${body}`;

export type Run = { status: number; stdout: string; stderr: string };
// Never let an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_CONFIG_* point a test at the real repo.
export const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
export function sh(cwd: string, cmd: string, args: string[], env: Record<string, string> = {}, input?: string): Run {
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      ...cleanEnv,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      HB_ROLE: '',
      ...env,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
export const git = (cwd: string, ...args: string[]) => sh(cwd, 'git', args);
export const ok = (r: Run) => {
  if (r.status !== 0) throw new Error(`exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
};
export const write = (root: string, rel: string, body: string | Buffer) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
export const commit = (cwd: string, subject: string, env: Record<string, string> = {}) =>
  sh(cwd, 'git', ['commit', '-q', '-F', '-'], env, msg(subject));

/** A repo carrying the real hooks, scripts and owners.json, with an initial lead commit on main. */
export function makeRepo(pkgScripts: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'hb-tooling-test-'));
  tmpRoots.push(root);
  ok(git(root, 'init', '-q', '-b', 'main'));
  // Guard: every config write below must land in this throwaway repo, never the project's .git.
  const gitDir = ok(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')).stdout.trim();
  if (gitDir !== join(root, '.git')) throw new Error(`test repo resolved to ${gitDir}, refusing to configure it`);
  cpSync(join(src, '.githooks'), join(root, '.githooks'), { recursive: true });
  cpSync(join(src, 'scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
  cpSync(join(src, 'scripts/team'), join(root, 'scripts/team'), { recursive: true });
  cpSync(join(src, 'scripts/gate.sh'), join(root, 'scripts/gate.sh'));
  cpSync(join(src, 'team/owners.json'), join(root, 'team/owners.json'));
  write(root, '.gitignore', 'node_modules/\nartifacts/\n.worktrees/\n');
  write(
    root,
    'package.json',
    JSON.stringify({ name: 'fixture', private: true, scripts: { typecheck: 'true', test: 'true', build: 'true', ...pkgScripts } }, null, 2),
  );
  write(root, 'package-lock.json', '{"lockfileVersion":3}\n');
  write(root, 'DECISIONS.md', '# Decisions\n\n## D-001 — first\n');
  write(root, 'apps/web/src/index.ts', 'export {};\n');
  write(root, 'apps/admin/src/app.ts', 'export const a = 1;\n');
  // Absolute path, as in production: every worktree runs this checkout's hooks (review F5).
  ok(git(root, 'config', 'core.hooksPath', join(root, '.githooks')));
  ok(git(root, 'add', '-A'));
  ok(commit(root, 'BOOT-0: init', { HB_ROLE: 'lead' }));
  return root;
}

export function branch(root: string, name: string) {
  ok(git(root, 'checkout', '-q', '-B', name, 'main'));
}
