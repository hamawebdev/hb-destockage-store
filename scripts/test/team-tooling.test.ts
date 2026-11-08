// Tests for the team process tooling (TOOL-1): pre-commit, pre-merge-commit, commit-msg, port.sh,
// gate.sh, locks, TaskCompleted and TeammateIdle hooks. Each test builds a throwaway git repo.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { branch, cleanupTmp, commit, git, makeRepo, msg, ok, sh, src, tmpRoots, write } from './helpers.ts';

afterAll(cleanupTmp);

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

  test('a merge that keeps our old copy of another owner\'s file (revert) is refused (review F1)', () => {
    branch(root, 'team/admin-core');
    write(root, 'apps/admin/src/auth/rev.ts', 'export const v = 1;\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'ADMIN-3: v1'));
    branch(root, 'team/web');
    ok(git(root, 'merge', '-q', '--no-edit', 'team/admin-core'));
    // admin-core moves on
    ok(git(root, 'checkout', '-q', 'team/admin-core'));
    write(root, 'apps/admin/src/auth/rev.ts', 'export const v = 2;\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'ADMIN-4: v2'));
    ok(git(root, 'checkout', '-q', 'team/web'));
    // variant 1: -s ours (no conflict → pre-merge-commit)
    const r1 = git(root, 'merge', '-q', '-s', 'ours', '--no-edit', 'team/admin-core');
    expect(r1.status).not.toBe(0);
    expect(r1.stderr).toContain('apps/admin/src/auth/rev.ts');
    if (git(root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0) ok(git(root, 'merge', '--abort'));
    // variant 2: --no-commit, then put our old copy back
    ok(git(root, 'merge', '-q', '--no-ff', '--no-commit', 'team/admin-core'));
    ok(git(root, 'checkout', 'HEAD', '--', 'apps/admin/src/auth/rev.ts'));
    const r2 = sh(root, 'git', ['commit', '-q', '--no-edit']);
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toContain('apps/admin/src/auth/rev.ts');
    ok(git(root, 'merge', '--abort'));
    // a plain merge taking their version is fine
    ok(git(root, 'merge', '-q', '--no-edit', 'team/admin-core'));
  });

  test('hooks come from the configured hooks dir, not the committing branch (review F5)', () => {
    const wt = join(root, '.worktrees/stale');
    ok(git(root, 'worktree', 'add', '-q', '-b', 'team/pages', wt, 'main'));
    rmSync(join(wt, '.githooks'), { recursive: true, force: true }); // a branch without (or with edited) hooks
    write(wt, 'apps/admin/src/auth/sneak.ts', 'export {};\n');
    ok(git(wt, 'add', 'apps/admin/src/auth/sneak.ts'));
    const r = sh(wt, 'git', ['commit', '-q', '-F', '-'], {}, msg('PAGES-1: sneak'));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('admin-core');
    ok(git(root, 'worktree', 'remove', '--force', wt));
  });

  test('team/APPROVALS.md and team/SIGNOFFS.md: only the lead on main (TOOL-5 ruling)', () => {
    for (const f of ['team/APPROVALS.md', 'team/SIGNOFFS.md']) {
      branch(root, 'team/tooling');
      write(root, f, '# forged\n');
      ok(git(root, 'add', '-A'));
      const r = commit(root, 'TOOL-9: forge');
      expect(r.status, f).not.toBe(0);
      expect(r.stderr).toContain('owned by lead');
      ok(git(root, 'reset', '-q', '--hard'));
      ok(git(root, 'clean', '-qfd'));
    }
    branch(root, 'main');
    write(root, 'team/APPROVALS.md', '# Approvals ledger\n');
    ok(git(root, 'add', '-A'));
    expect(commit(root, 'BOOT-9: ledger', { HB_ROLE: 'lead' }).status).toBe(0);
  });

  test('D1/Drizzle migrations (packages/db/migrations/*.sql) are not dumps: not ignored, and they commit (rev-a TOOL-7)', () => {
    branch(root, 'team/db');
    write(root, 'packages/db/migrations/0006_new.sql', 'CREATE TABLE t (id INTEGER);\n');
    expect(ok(git(root, 'status', '--porcelain', '--untracked-files=all', '--', 'packages/db/migrations')).stdout).toContain('0006_new.sql');
    ok(git(root, 'add', '--', 'packages/db/migrations/0006_new.sql')); // no -f needed
    const r = commit(root, 'DB-9: migration');
    expect(r.status, r.stderr).toBe(0);
    branch(root, 'main');
    write(root, 'packages/db/migrations/0007_lead.sql', 'SELECT 1;\n');
    ok(git(root, 'add', '--', 'packages/db/migrations/0007_lead.sql'));
    expect(commit(root, 'BOOT-9: migration', { HB_ROLE: 'lead' }).status).toBe(0);
    // a dump next to them is still refused
    write(root, 'packages/db/dump.sql.gz', 'x\n');
    ok(git(root, 'add', '-f', '--', 'packages/db/dump.sql.gz'));
    const d = commit(root, 'BOOT-9: dump', { HB_ROLE: 'lead' });
    expect(d.status).not.toBe(0);
    expect(d.stderr).toContain('dump');
    ok(git(root, 'reset', '-q', '--hard'));
    ok(git(root, 'clean', '-qfdx', '--', 'packages/db'));
  });

  test('rev-a TOOL-7 r1: dumps are refused INSIDE migrations/ and in any letter case; Drizzle files commit', () => {
    for (const [b, env] of [['team/db', {}], ['main', { HB_ROLE: 'lead' }]] as const) {
      for (const f of [
        'packages/db/migrations/prod-2026.sql.gz',
        'packages/db/migrations/d1-export-2026.sql',
        'packages/db/migrations/backups/b.sql',
        'packages/db/migrations/hb-restore-1/x.db',
        'packages/db/migrations/prod.dump',
        'packages/db/migrations/0009_not-a-migration.sql.gz',
        'apps/jobs/BACKUP.SQL.GZ',
        'D1-EXPORT-2026.json',
        'packages/db/Backups/x.json',
        'data/geo/prod.DUMP',
      ]) {
        if (b === 'team/db' && !f.startsWith('packages/db/')) continue; // ownership would refuse first
        branch(root, b);
        write(root, f, 'x\n');
        ok(git(root, 'add', '-f', '--', f));
        const r = commit(root, 'DB-9: dump', env);
        expect(r.status, `${b} ${f}`).not.toBe(0);
        expect(r.stderr, f).toContain('dump');
        ok(git(root, 'reset', '-q', '--hard'));
        ok(git(root, 'clean', '-qfdx', '--', f.split('/')[0] ?? f));
      }
    }
    branch(root, 'team/db');
    for (const f of ['packages/db/migrations/0008_x.sql', 'packages/db/migrations/meta/_journal.json', 'packages/db/migrations/meta/0008_snapshot.json']) {
      write(root, f, '{}\n');
    }
    ok(git(root, 'add', '--', 'packages/db/migrations'));
    expect(commit(root, 'DB-9: drizzle output').status).toBe(0);
  });

  test('database dumps are refused for everyone, and apps/jobs files over 1 MB (JOBS-1 F5 backstop)', () => {
    for (const f of ['apps/jobs/x.sql.gz', 'data/geo/a.dump', 'apps/jobs/backups/b.json', 'tmp/hb-restore-1/x.db', 'd1-export-2026.json', 'packages/db/backups/m.sql']) {
      branch(root, 'main');
      write(root, f, 'x\n');
      ok(git(root, 'add', '-f', '--', f));
      const r = commit(root, 'BOOT-9: dump', { HB_ROLE: 'lead' });
      expect(r.status, f).not.toBe(0);
      expect(r.stderr).toContain('dump');
      ok(git(root, 'reset', '-q', '--hard'));
      ok(git(root, 'clean', '-qfdx', '--', f.split('/')[0] ?? f));
    }
    branch(root, 'team/jobs');
    write(root, 'apps/jobs/big.json', Buffer.alloc(1024 * 1024 + 1, 1));
    ok(git(root, 'add', '-A'));
    const r = commit(root, 'JOBS-9: big');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('1 MB limit for apps/jobs/**');
    ok(git(root, 'reset', '-q', '--hard'));
    ok(git(root, 'clean', '-qfd'));
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

  test('"Merge …" subjects pass only while a merge is in progress; empty values are refused (review N1)', () => {
    expect(check("Merge branch 'main' into team/web\n").status).not.toBe(0);
    expect(check('Merge anything I like\n').status).not.toBe(0);
    const r = check(msg('DB-1: x', 'What changed:\nTesting: y\nRisk tier: low\nRevert: z\n'));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('has no value');
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

  test('locks: a gate takes a heavy slot shared with `locks.sh heavy`; a full heavy pool blocks both', () => {
    const root = makeRepo();
    prepNodeModules(root);
    const dir = mkdtempSync(join(tmpdir(), 'hb-locks-pool-'));
    tmpRoots.push(dir);
    const env = { HB_LOCK_DIR: dir, HB_HEAVY_SLOTS: '1', HB_GATE_WAIT: '2' };
    const g = sh(root, join(root, 'scripts/gate.sh'), [root, '--no-cache'], env);
    expect(g.status, g.stdout + g.stderr).toBe(0);
    expect(g.stdout).toContain('heavy slot 1');
    // hold the only heavy slot from outside (as /tmp/hb-locks/heavy.sh would)
    const holder = spawnSync('bash', ['-c', `exec 9>"${dir}/heavy-1.lock"; flock -n 9 || exit 9; ` +
      `"${join(root, 'scripts/lib/locks.sh')}" heavy --wait 1 -- true; a=$?; ` +
      `"${join(root, 'scripts/gate.sh')}" "${root}" --no-cache >/dev/null 2>&1; b=$?; echo "$a $b"`],
      { encoding: 'utf8', env: { ...process.env, ...env } });
    expect(holder.stdout.trim()).toBe('75 1');
  });

  test('require-catalog: a seed build without data/catalog fails early and clearly; fixture and a present catalogue pass (rev-a TOOL-7 r7)', () => {
    const root = makeRepo({ build: 'scripts/require-catalog.sh' });
    prepNodeModules(root);
    cpSync(join(src, 'scripts/require-catalog.sh'), join(root, 'scripts/require-catalog.sh'));
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-6: guard', { HB_ROLE: 'lead' }));
    const guard = join(root, 'scripts/require-catalog.sh');
    const noData = sh(root, guard, []);
    expect(noData.status).toBe(1);
    expect(noData.stderr).toContain('data/catalog missing: merge seed or run build:fixture');
    expect(sh(root, guard, [], { HB_SNAPSHOT: 'fixture' }).status).toBe(0);
    // a checkout without data/: the gate's default (fixture) builds; an explicit seed gate is RED with the message
    expect(gate(root, '--no-cache').status).toBe(0);
    const seed = sh(root, join(root, 'scripts/gate.sh'), [root, '--no-cache'], { HB_LOCK_DIR: lockDir, HB_SNAPSHOT: 'seed' });
    expect(seed.status).toBe(1);
    expect(seed.stdout).toContain('RED   build');
    const log = seed.stdout.match(/log: (\S.*\.log)/)?.[1] ?? '';
    expect(readFileSync(log, 'utf8')).toContain('data/catalog missing: merge seed or run build:fixture');
    write(root, 'data/catalog/categories.json', '[]\n');
    expect(sh(root, guard, []).status).toBe(0);
  });

  test('data/ checks are named steps that can go RED', () => {
    // the gate's own `test` step skips test:data (HB_SKIP_DATA_TESTS=1) so data tests run once, as named steps
    const root = makeRepo({ test: 'test "$HB_SKIP_DATA_TESTS" = 1' });
    prepNodeModules(root);
    write(root, 'data/geo/test/geo.test.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
    write(root, 'data/catalog/validate.mjs', 'process.exit(0);\n');
    write(root, 'data/catalog/test/cat.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert';\ntest('bad', () => assert.equal(1, 2));\n");
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-6: data', { HB_ROLE: 'lead' }));
    const r = gate(root, '--no-cache');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('steps = typecheck test data-geo data-catalog-validate data-catalog-test build');
    expect(r.stdout).toContain('GREEN data-geo');
    expect(r.stdout).toContain('GREEN data-catalog-validate');
    expect(r.stdout).toContain('RED   data-catalog-test');
    expect(r.stdout).toContain('SKIP  build');
  });

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

  test('storefront diff with only the placeholder page and a stub lh → SKIP, not RED', () => {
    const root = makeRepo({ budget: "echo 'budget: not wired yet' && exit 0", lh: "echo 'lh: not wired yet' && exit 0" });
    prepNodeModules(root);
    branch(root, 'team/shell');
    write(root, 'apps/storefront/src/pages/index.astro', '---\n// Placeholder (TOOL-2). Owner: shell.\n---\n<html></html>\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'SHELL-9: placeholder'));
    const r = gate(root, '--no-cache');
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('steps = typecheck test build\n');
    expect(r.stdout).toContain('gate: GREEN');
  });

  test('with real pages, lh runs for anything that can affect the storefront and skips only no-effect paths (review F4)', () => {
    const root = makeRepo({ budget: 'true', axe: 'true', lh: 'test "$HB_GATE" = 1 && echo LH-RAN-IN-GATE-MODE' });
    prepNodeModules(root);
    write(root, 'apps/storefront/src/pages/ar/index.astro', '<html lang="ar"></html>\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-1: real page', { HB_ROLE: 'lead' }));
    const cases: Array<[string, string, string, boolean]> = [
      ['team/shared', 'packages/shared/src/format.ts', 'SHARED-9', true],
      ['team/web', 'apps/web/src/index.ts', 'WEB-9', true],
      ['team/measure', 'tools/measure/src/lh.ts', 'MEAS-9', true],
      ['team/tooling', 'packages/shared/package.json', 'TOOL-9', true],
      ['team/brand', 'brand/guide.md', 'BRAND-9', true],
      ['team/admin-core', 'apps/admin/src/app.ts', 'ADMIN-9', false],
      ['team/db', 'packages/db/src/schema.ts', 'DB-9', false],
      ['team/shell', 'apps/storefront/public/js/test/x.js', 'SHELL-9', true], // served file under a test/ dir
      ['team/web', 'apps/web/test/api.test.ts', 'WEB-8', false],
    ];
    for (const [b, file, id, wantLh] of cases) {
      branch(root, b);
      write(root, file, `// ${id}\n`);
      ok(git(root, 'add', '-A'));
      ok(commit(root, `${id}: change`));
      const r = gate(root, '--no-cache');
      expect(r.status, `${file}\n${r.stdout}`).toBe(0);
      expect(r.stdout.includes('steps = typecheck test build budget axe lh'), file).toBe(wantLh);
    }
  });

  test('check-tap runs after build when storefront output can change and the script exists; RED on violations', () => {
    const root = makeRepo({ budget: 'true', axe: 'true', lh: 'true' });
    prepNodeModules(root);
    write(root, 'apps/storefront/src/pages/ar/index.astro', '<html lang="ar"></html>\n');
    write(root, 'apps/storefront/package.json', JSON.stringify({ name: 's', private: true, scripts: { 'check:tap': 'node scripts/tap-targets.mjs' } }));
    write(root, 'apps/storefront/scripts/tap-targets.mjs', 'console.error("2 targets < 44px"); process.exit(1);\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-1: page + tap', { HB_ROLE: 'lead' }));
    branch(root, 'team/shell');
    write(root, 'apps/storefront/src/pages/fr/index.astro', '<html lang="fr"></html>\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'SHELL-9: fr'));
    const r = gate(root, '--no-cache');
    expect(r.stdout).toContain('steps = typecheck test build budget check-tap axe lh');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('RED   check-tap (exit 1');
  });

  test('disk rule: RED at disk when / is below the free-space minimum; TMPDIR moves to the data volume', () => {
    const root = makeRepo({ test: 'node -e "console.log(\'TMP=\'+require(\'os\').tmpdir())"' });
    prepNodeModules(root);
    const vol = mkdtempSync(join(tmpdir(), 'hb-vol-'));
    tmpRoots.push(vol);
    // private lock dir: never queue on the machine's real gate/heavy slots
    const low = sh(root, join(root, 'scripts/gate.sh'), [root, '--no-cache'], { HB_LOCK_DIR: lockDir, HB_MIN_ROOT_FREE_GB: '100000' });
    expect(low.status).toBe(1);
    expect(low.stdout).toContain('RED at disk');
    const r = sh(root, join(root, 'scripts/gate.sh'), [root, '--no-cache'], { HB_LOCK_DIR: lockDir, HB_TMP_VOLUME: vol, HB_TMP_ROOT: join(vol, 'hb-tmp'), TMPDIR: '/tmp' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`TMPDIR=${join(vol, 'hb-tmp', 'gate-main')}`);
    const log = r.stdout.match(/log: (\S.*\.log)/)?.[1] ?? '';
    expect(readFileSync(log, 'utf8')).toContain(`TMP=${join(vol, 'hb-tmp', 'gate-main')}`);
  });

  test('gate refuses when core.hooksPath is not the absolute main hooks path (review F5)', () => {
    const root = makeRepo();
    prepNodeModules(root);
    ok(git(root, 'config', 'core.hooksPath', '.githooks'));
    const r = gate(root, '--no-cache');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('RED at hooks');
    ok(git(root, 'config', '--unset', 'core.hooksPath'));
    expect(gate(root, '--no-cache').stdout).toContain('RED at hooks');
  });

  test('a hung step is killed at HB_STEP_TIMEOUT, goes RED (124) and frees the slot', () => {
    const mark = `300.${process.pid}${Date.now() % 100000}`;
    const root = makeRepo({ test: `sleep ${mark}` });
    prepNodeModules(root);
    const dir = mkdtempSync(join(tmpdir(), 'hb-locks-hang-'));
    tmpRoots.push(dir);
    const env = { HB_LOCK_DIR: dir, HB_GATE_SLOTS: '1', HB_HEAVY_SLOTS: '1', HB_GATE_WAIT: '3', HB_STEP_TIMEOUT: '2' };
    const t0 = Date.now();
    const r = sh(root, join(root, 'scripts/gate.sh'), [root, '--no-cache'], env);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('RED   test (exit 124, TIMED OUT after 2s');
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(spawnSync('pgrep', ['-f', `^sleep ${mark}$`]).status).toBe(1);
    const free = sh(root, join(root, 'scripts/lib/locks.sh'), ['heavy', '--wait', '2', '--', 'true'], env);
    expect(free.status, free.stderr).toBe(0); // the slot was released
  });

  test('a descendant that ignores TERM is KILLed with its group; a TERM-ignoring hung step is TIMED OUT (rev-a TOOL-7 N2)', () => {
    const m1 = `42.${process.pid}${Date.now() % 100000}`;
    const root = makeRepo({ test: `(trap "" TERM; sleep ${m1}) & sleep 0.3; true` });
    prepNodeModules(root);
    const dir = mkdtempSync(join(tmpdir(), 'hb-locks-kill-'));
    tmpRoots.push(dir);
    const env = { HB_LOCK_DIR: dir, HB_KILL_GRACE: '1' };
    const r1 = sh(root, join(root, 'scripts/gate.sh'), [root, '--no-cache'], env);
    expect(r1.status, r1.stdout + r1.stderr).toBe(0);
    expect(spawnSync('pgrep', ['-f', `^sleep ${m1}$`]).status).toBe(1);

    const m2 = `43.${process.pid}${Date.now() % 100000}`;
    const root2 = makeRepo({ test: `trap "" TERM; sleep ${m2}` });
    prepNodeModules(root2);
    const t0 = Date.now();
    const r2 = sh(root2, join(root2, 'scripts/gate.sh'), [root2, '--no-cache'], { ...env, HB_STEP_TIMEOUT: '2' });
    expect(r2.status).toBe(1);
    expect(r2.stdout).toMatch(/RED {3}test \(exit \d+, TIMED OUT after 2s/);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(spawnSync('pgrep', ['-f', `^sleep ${m2}$`]).status).toBe(1);
  });

  test('a step that leaves an orphan behind neither keeps the slot nor survives the gate (review F3)', () => {
    const mark = `41.${process.pid}${Date.now() % 100000}`;
    const root = makeRepo({ test: `(sleep ${mark} &) ; true` });
    prepNodeModules(root);
    const dir = mkdtempSync(join(tmpdir(), 'hb-locks-orphan-'));
    tmpRoots.push(dir);
    const env = { HB_LOCK_DIR: dir, HB_GATE_SLOTS: '1', HB_HEAVY_SLOTS: '1', HB_GATE_WAIT: '3' };
    expect(sh(root, join(root, 'scripts/gate.sh'), [root, '--no-cache'], env).status).toBe(0);
    expect(spawnSync('pgrep', ['-f', `^sleep ${mark}$`]).status).toBe(1); // killed with its group
    const again = sh(root, join(root, 'scripts/gate.sh'), [root, '--no-cache'], env);
    expect(again.status, again.stdout + again.stderr).toBe(0); // the slot was free
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

  test('build task: a gate that outlasts the hook budget fails closed, then the result is picked up (review F2)', () => {
    const bin = mkdtempSync(join(tmpdir(), 'hb-slow-gate-'));
    tmpRoots.push(bin);
    const slow = join(bin, 'gate.sh');
    writeFileSync(slow, '#!/bin/sh\nsleep 4\necho "gate: GREEN — log: /tmp/fake.log"\n', { mode: 0o755 });
    const p = { task_subject: 'WEB-1: x', teammate_name: 'web', cwd: root };
    const r1 = hook(p, { HB_GATE_CMD: slow, HB_HOOK_BUDGET: '1' });
    expect(r1.status).toBe(2);
    expect(r1.stderr).toContain('gate still running');
    spawnSync('sleep', ['5']);
    const r2 = hook(p, { HB_GATE_CMD: slow, HB_HOOK_BUDGET: '1' });
    expect(r2.status, r2.stderr).toBe(0);
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
