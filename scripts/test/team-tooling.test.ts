// Tests for the team process tooling (TOOL-1): pre-commit, commit-msg, port.sh, gate.sh,
// TaskCompleted and TeammateIdle hooks. Each test builds a throwaway git repo and runs the real scripts.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const src = fileURLToPath(new URL('../..', import.meta.url));
const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const GOOD_BODY = 'What changed: x\nTesting: y\nRisk tier: low\nRevert: git revert\n';
const msg = (subject: string, body = GOOD_BODY) => `${subject}\n\n${body}`;

type Run = { status: number; stdout: string; stderr: string };
function sh(cwd: string, cmd: string, args: string[], env: Record<string, string> = {}, input?: string): Run {
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
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
const git = (cwd: string, ...args: string[]) => sh(cwd, 'git', args);
const ok = (r: Run) => {
  if (r.status !== 0) throw new Error(`exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
};
const write = (root: string, rel: string, body: string | Buffer) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const commit = (cwd: string, subject: string, env: Record<string, string> = {}) =>
  sh(cwd, 'git', ['commit', '-q', '-F', '-'], env, msg(subject));

/** A repo carrying the real hooks, scripts and owners.json, with an initial lead commit on main. */
function makeRepo(pkgScripts: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'hb-tooling-test-'));
  tmpRoots.push(root);
  ok(git(root, 'init', '-q', '-b', 'main'));
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
  ok(git(root, 'config', 'core.hooksPath', '.githooks'));
  ok(git(root, 'add', '-A'));
  ok(commit(root, 'BOOT-0: init', { HB_ROLE: 'lead' }));
  return root;
}

function branch(root: string, name: string) {
  ok(git(root, 'checkout', '-q', '-B', name, 'main'));
}

describe('pre-commit ownership', () => {
  let root: string;
  beforeAll(() => {
    root = makeRepo();
  });

  test('owner may commit inside its paths', () => {
    branch(root, 'team/web');
    write(root, 'apps/web/src/a.ts', 'export const x = 1;\n');
    ok(git(root, 'add', '-A'));
    expect(commit(root, 'WEB-1: add a').status).toBe(0);
  });

  test('foreign path is refused and names the owner', () => {
    branch(root, 'team/web');
    write(root, 'apps/admin/src/app.ts', 'export const a = 2;\n');
    ok(git(root, 'add', '-A'));
    const r = commit(root, 'WEB-2: touch admin');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('apps/admin/src/app.ts');
    expect(r.stderr).toContain('admin-core');
    ok(git(root, 'reset', '-q', '--hard'));
  });

  test('package.json from a non-tooling owner is refused, even inside its own area', () => {
    branch(root, 'team/web');
    write(root, 'apps/web/package.json', '{}\n');
    ok(git(root, 'add', '-A'));
    const r = commit(root, 'WEB-3: deps');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('tooling');
    ok(git(root, 'reset', '-q', '--hard'));
    ok(git(root, 'clean', '-qfd'));
  });

  test('tooling may commit any package.json', () => {
    branch(root, 'team/tooling');
    write(root, 'apps/web/package.json', '{}\n');
    ok(git(root, 'add', '-A'));
    expect(commit(root, 'TOOL-9: deps').status).toBe(0);
  });

  test('DECISIONS.md: pure append allowed for anyone, edits refused', () => {
    branch(root, 'team/db');
    write(root, 'DECISIONS.md', '# Decisions\n\n## D-001 — first\n\n## D-002 — db\n');
    ok(git(root, 'add', '-A'));
    expect(commit(root, 'DB-9: decision').status).toBe(0);

    write(root, 'DECISIONS.md', '# Decisions\n\n## D-001 — changed\n\n## D-002 — db\n');
    ok(git(root, 'add', '-A'));
    const r = commit(root, 'DB-9: edit decision');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('append');
    ok(git(root, 'reset', '-q', '--hard'));
  });

  test('main is refused without HB_ROLE=lead and allowed with it', () => {
    branch(root, 'main');
    write(root, 'apps/admin/src/lead.ts', 'export {};\n');
    ok(git(root, 'add', '-A'));
    const r = commit(root, 'LEAD-1: x');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('only the lead');
    expect(commit(root, 'LEAD-1: x', { HB_ROLE: 'lead' }).status).toBe(0);
  });

  test('a branch that is not team/<name> is refused', () => {
    branch(root, 'feature/x');
    write(root, 'apps/web/src/f.ts', 'export {};\n');
    ok(git(root, 'add', '-A'));
    const r = commit(root, 'WEB-4: f');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('team/<your-name>');
    ok(git(root, 'reset', '-q', '--hard'));
    ok(git(root, 'clean', '-qfd'));
  });

  test('files over 2 MB are refused outside the large-file globs', () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
    branch(root, 'team/web');
    write(root, 'apps/web/big.bin', big);
    ok(git(root, 'add', '-A'));
    const r = commit(root, 'WEB-5: big');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('2 MB');
    ok(git(root, 'reset', '-q', '--hard'));
    ok(git(root, 'clean', '-qfd'));

    branch(root, 'team/seed');
    write(root, 'data/photos/p1.jpg', big);
    ok(git(root, 'add', '-A'));
    expect(commit(root, 'SEED-5: photo').status).toBe(0);
  });

  test('merge commit: merged-in foreign files pass, edits to them during the merge do not', () => {
    branch(root, 'team/admin-core');
    write(root, 'apps/admin/src/app.ts', 'export const a = 3;\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'ADMIN-2: a=3'));

    branch(root, 'team/web');
    write(root, 'apps/web/src/m.ts', 'export {};\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'WEB-6: m'));
    ok(git(root, 'merge', '--no-ff', '--no-commit', 'team/admin-core'));
    expect(sh(root, 'git', ['commit', '-q', '--no-edit']).status).toBe(0);

    ok(git(root, 'reset', '-q', '--hard', 'HEAD~1'));
    ok(git(root, 'merge', '--no-ff', '--no-commit', 'team/admin-core'));
    write(root, 'apps/admin/src/app.ts', 'export const a = 4;\n');
    ok(git(root, 'add', '-A'));
    const r = sh(root, 'git', ['commit', '-q', '--no-edit']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('apps/admin/src/app.ts');
    ok(git(root, 'merge', '--abort'));
  });

  test('pre-commit is fast (< 1 s)', () => {
    branch(root, 'team/web');
    write(root, 'apps/web/src/speed.ts', 'export {};\n');
    ok(git(root, 'add', '-A'));
    const t0 = performance.now();
    const r = sh(root, join(root, '.githooks/pre-commit'), []);
    expect(r.status).toBe(0);
    expect(performance.now() - t0).toBeLessThan(1000);
    ok(git(root, 'reset', '-q', '--hard'));
    ok(git(root, 'clean', '-qfd'));
  });
});

describe('commit-msg', () => {
  let root: string;
  beforeAll(() => {
    root = makeRepo();
  });
  const check = (text: string) => {
    const f = join(root, 'MSG');
    writeFileSync(f, text);
    return sh(root, join(root, '.githooks/commit-msg'), [f]);
  };

  test('accepts the format, with trailers and comments', () => {
    expect(check(msg('DB-1: schema') + '\nCo-Authored-By: X <x@y>\n# comment\n').status).toBe(0);
    expect(check(msg('AORD-2: list')).status).toBe(0);
    expect(check(msg('BUG-14: fix')).status).toBe(0);
    expect(check(msg('BOOT-0: init')).status).toBe(0);
    expect(check(msg('TOOL-2: address review r1')).status).toBe(0);
    expect(check('What changed: multi\nline\n'.length ? msg('DB-2: x', 'What changed: a\n  more\nTesting: b\nRisk tier: high\nRevert: c\n') : '').status).toBe(0);
  });

  test('accepts merge commits', () => {
    expect(check("Merge branch 'main' into team/web\n").status).toBe(0);
  });

  test('rejects bad subjects and bodies with a template', () => {
    for (const bad of [
      msg('db-1: lower'),
      msg('DB: no number'),
      msg('DB-1 no colon'),
      'DB-1: x\nWhat changed: no blank line\nTesting: y\nRisk tier: low\nRevert: z\n',
      msg('DB-1: x', 'What changed: x\nTesting: y\nRisk tier: low\n'),
      msg('DB-1: x', 'What changed: x\nTesting: y\nRisk tier: medium\nRevert: z\n'),
      msg('DB-1: x', 'Testing: y\nWhat changed: x\nRisk tier: low\nRevert: z\n'),
    ]) {
      const r = check(bad);
      expect(r.status, bad).not.toBe(0);
      expect(r.stderr).toContain('Expected:');
    }
  });
});

describe('port.sh', () => {
  test('prints port bases and refuses unknown names', () => {
    const root = makeRepo();
    expect(sh(root, join(root, 'scripts/team/port.sh'), ['tooling']).stdout.trim()).toBe('4100');
    expect(sh(root, join(root, 'scripts/team/port.sh'), ['rev-f']).stdout.trim()).toBe('4330');
    expect(sh(root, join(root, 'scripts/team/port.sh'), ['lead']).stdout.trim()).toBe('4340');
    expect(sh(root, join(root, 'scripts/team/port.sh'), ['nobody']).status).toBe(1);
  });
});

describe('gate.sh', () => {
  const lockDir = mkdtempSync(join(tmpdir(), 'hb-locks-test-'));
  tmpRoots.push(lockDir);
  const gate = (root: string, ...args: string[]) =>
    sh(root, join(root, 'scripts/gate.sh'), [root, ...args], { HB_LOCK_DIR: lockDir });
  const prepNodeModules = (root: string) => {
    // Pretend npm ci already ran for this lockfile, so the gate skips it.
    const hash = spawnSync('sha256sum', [join(root, 'package-lock.json')], { encoding: 'utf8' }).stdout.split(' ')[0];
    write(root, 'node_modules/.hb-lock-hash', `${hash}\n`);
  };

  test('a failing step is RED, exits non-zero, and later steps are skipped', () => {
    const root = makeRepo({ test: 'echo boom >&2; exit 3', build: 'echo SHOULD-NOT-RUN' });
    prepNodeModules(root);
    const r = gate(root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('RED   test (exit 3');
    expect(r.stdout).toContain('SKIP  build');
    expect(r.stdout).not.toContain('gate: GREEN');
    const log = r.stdout.match(/log: (\S.*\.log)/)?.[1] ?? '';
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).not.toContain('SHOULD-NOT-RUN');
  });

  test('all green → GREEN, then a cached GREEN for the same clean tree', () => {
    const root = makeRepo();
    prepNodeModules(root);
    const r1 = gate(root);
    expect(r1.status, r1.stdout + r1.stderr).toBe(0);
    expect(r1.stdout).toContain('gate: GREEN — log:');
    const r2 = gate(root);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain('GREEN (cached');
  });

  test('real storefront page + stub budget/lh → RED; TOOL-2 placeholder page → not required', () => {
    const root = makeRepo({ budget: "echo 'budget: not wired yet' && exit 0", lh: "echo 'lh: not wired yet' && exit 0" });
    prepNodeModules(root);
    write(root, 'apps/storefront/src/pages/index.astro', '---\n// Placeholder (TOOL-2). Owner: shell.\n---\n<html></html>\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-1: placeholder', { HB_ROLE: 'lead' }));
    const r1 = gate(root, '--no-cache');
    expect(r1.status, r1.stdout).toBe(0);
    expect(r1.stdout).toContain('steps = typecheck test build\n');

    write(root, 'apps/storefront/src/pages/ar/index.astro', '<html lang="ar"></html>\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-2: real page', { HB_ROLE: 'lead' }));
    const r2 = gate(root, '--no-cache', '--full');
    expect(r2.status).toBe(1);
    expect(r2.stdout).toContain('RED   budget (script missing or a stub');
  });

  test('lh runs when the diff vs main touches storefront paths', () => {
    const root = makeRepo({ budget: 'true', lh: 'echo LH-RAN' });
    prepNodeModules(root);
    branch(root, 'team/brand');
    write(root, 'brand/guide.md', '# guide\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BRAND-1: guide'));
    const r = gate(root, '--no-cache');
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('steps = typecheck test build lh');
  });
});

describe('TaskCompleted hook', () => {
  let root: string;
  let artifacts: string;
  const hook = (payload: object, env: Record<string, string> = {}) =>
    sh(root, join(root, 'scripts/team/on-task-completed.sh'), [], { HB_ARTIFACTS_DIR: artifacts, HB_LOCK_DIR: join(root, '.locks'), HOME: root, ...env }, JSON.stringify(payload));

  beforeAll(() => {
    root = makeRepo();
    artifacts = join(root, 'artifacts');
    ok(git(root, 'branch', 'team/web'));
    ok(git(root, 'worktree', 'add', '-q', join(root, '.worktrees/web'), 'team/web'));
    const wt = join(root, '.worktrees/web');
    write(wt, 'apps/web/src/x.ts', 'export {};\n');
    ok(git(wt, 'add', '-A'));
    ok(commit(wt, 'WEB-1: x'));
    const hash = spawnSync('sha256sum', [join(wt, 'package-lock.json')], { encoding: 'utf8' }).stdout.split(' ')[0];
    write(wt, 'node_modules/.hb-lock-hash', `${hash}\n`);
  });

  test('REV: requires the review file with a verdict', () => {
    const p = { task_id: '9', task_subject: 'REV WEB-1 r1 @abc1234', cwd: root };
    expect(hook(p).status).toBe(2);
    write(artifacts, 'WEB-1/review-r1.md', 'Findings: 0 Important\nNo verdict here\n');
    expect(hook(p).status).toBe(2);
    write(artifacts, 'WEB-1/review-r1.md', 'Findings: 0 Important, 0 Nit, 0 Pre-existing\nVerdict: APPROVED\nCommits: abc1234\n');
    expect(hook(p).status).toBe(0);
  });

  test('plans and QA: require a non-empty artifact dir', () => {
    expect(hook({ task_subject: 'DB-0: plan', cwd: root }).status).toBe(2);
    write(artifacts, 'DB-0/plan.md', '# plan\n');
    expect(hook({ task_subject: 'DB-0: plan', cwd: root }).status).toBe(0);
    expect(hook({ task_subject: 'QA-3: sweep', cwd: root }).status).toBe(2);
    write(artifacts, 'QA-3/notes.md', 'x\n');
    expect(hook({ task_subject: 'QA-3: sweep', cwd: root }).status).toBe(0);
  });

  test('build task: refuses when the worktree cannot be resolved (no teammate_name, no Worktree line)', () => {
    const r = hook({ task_id: '1', task_subject: 'WEB-1: x', task_description: 'no line', cwd: root });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot resolve worktree');
  });

  test('build task: resolves via the Worktree: line from the lead session, runs the gate', () => {
    const r = hook({ task_id: '1', task_subject: 'WEB-1: x', task_description: 'Do x.\nWorktree: web\n', cwd: root });
    expect(r.status, r.stderr).toBe(0);
  });

  test('build task: resolves via teammate_name; refuses without a matching commit', () => {
    expect(hook({ task_subject: 'WEB-1: x', teammate_name: 'web', cwd: root }).status).toBe(0);
    const r = hook({ task_subject: 'WEB-7: never committed', teammate_name: 'web', cwd: root });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("'WEB-7: '");
  });

  test('build task: refuses a dirty worktree and a red gate', () => {
    const wt = join(root, '.worktrees/web');
    write(wt, 'apps/web/src/dirty.ts', 'export {};\n');
    const r1 = hook({ task_subject: 'WEB-1: x', teammate_name: 'web', cwd: root });
    expect(r1.status).toBe(2);
    expect(r1.stderr).toContain('uncommitted');
    rmSync(join(wt, 'apps/web/src/dirty.ts'));

    write(wt, 'package.json', JSON.stringify({ scripts: { typecheck: 'true', test: 'exit 1', build: 'true' } }));
    ok(git(wt, 'add', '-A'));
    ok(sh(wt, 'git', ['commit', '-q', '--no-verify', '-F', '-'], {}, msg('WEB-8: break tests')));
    const r2 = hook({ task_subject: 'WEB-8: break tests', teammate_name: 'web', cwd: root });
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain('RED at test');
  });

  test('free-form subjects pass', () => {
    expect(hook({ task_subject: 'Look into something', cwd: root }).status).toBe(0);
  });
});

describe('TeammateIdle hook', () => {
  test('blocks once on an ownership slip, then never again for the same state', () => {
    const root = makeRepo();
    ok(git(root, 'branch', 'team/web'));
    ok(git(root, 'worktree', 'add', '-q', join(root, '.worktrees/web'), 'team/web'));
    const wt = join(root, '.worktrees/web');
    const env = { HB_LOCK_DIR: join(root, '.locks') };
    const idle = () => sh(root, join(root, 'scripts/team/on-teammate-idle.sh'), [], env, JSON.stringify({ teammate_name: 'web', cwd: wt }));

    write(wt, 'apps/web/src/fine.ts', 'export {};\n');
    expect(idle().status).toBe(0);

    write(wt, 'apps/admin/src/slip.ts', 'export {};\n');
    const r1 = idle();
    expect(r1.status).toBe(2);
    expect(r1.stderr).toContain('apps/admin/src/slip.ts');
    expect(idle().status).toBe(0); // same state: no loop

    write(wt, 'apps/admin/src/slip.ts', 'export const changed = 1;\n');
    expect(idle().status).toBe(2); // new state: one more nudge

    const t0 = performance.now();
    idle();
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(sh(root, join(root, 'scripts/team/on-teammate-idle.sh'), [], env, '{}').status).toBe(0);
  });
});
