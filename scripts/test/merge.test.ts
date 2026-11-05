// Tests for scripts/team/merge.sh (TOOL-5). Authority = the lead-only ledger main:team/APPROVALS.md
// (lead ruling 2026-11-05). Includes rev-d's TOOL-5 r1 attack cases (artifacts/TOOL-5/rev-d/attack*.sh)
// as permanent tests: C1–C7 controls, X1–X8 attacks, and the evil octopus / 2-parent merges.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GOOD_BODY, cleanupTmp, commit, git, makeRepo, msg, ok, sh, tmpRoots, write } from './helpers.ts';

afterAll(cleanupTmp);

describe('merge.sh (lead merge, ledger = team/APPROVALS.md)', () => {
  let root: string;
  let wt: string;
  let gateOk: string;
  let gateRed: string;

  const mainSha = () => ok(git(root, 'rev-parse', 'main')).stdout.trim();
  const merge = (args: string[], gate = gateOk) =>
    sh(root, join(root, 'scripts/team/merge.sh'), args, { HB_ARTIFACTS_DIR: join(root, 'artifacts'), HB_GATE_CMD: gate });
  const tier = (t: string) => `What changed: x\nTesting: y\n${t}\nRevert: z\n`;
  const commitIn = (dir: string, subject: string, body = GOOD_BODY, noVerify = false) => {
    ok(git(dir, 'add', '-A'));
    ok(sh(dir, 'git', ['commit', '-q', ...(noVerify ? ['--no-verify'] : []), '-F', '-'], {}, msg(subject, body)));
    return ok(git(dir, 'rev-parse', 'HEAD')).stdout.trim();
  };
  /** The lead records a review round in the ledger on main. */
  const ledger = (line: string) => {
    const f = join(root, 'team/APPROVALS.md');
    writeFileSync(f, readFileSync(f, 'utf8') + line + '\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-9: ledger', { HB_ROLE: 'lead' }));
  };
  const approve = (id: string, n: number, verdict: 'APPROVED' | 'CHANGES_REQUESTED', commits: string[], t = 'low', reviewer = 'rev-d') =>
    ledger(`${id} r${n} ${verdict} tier=${t} reviewer=${reviewer} commits=${commits.join(',')} review=artifacts/${id}/review-r${n}.md`);
  const signoff = (line: string) => {
    const f = join(root, 'team/SIGNOFFS.md');
    writeFileSync(f, readFileSync(f, 'utf8') + line + '\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-8: sign-off', { HB_ROLE: 'lead' }));
  };
  const resetBranch = () => {
    ok(git(wt, 'checkout', '-q', 'team/web'));
    ok(git(wt, 'reset', '-q', '--hard', 'main'));
  };

  beforeAll(() => {
    root = makeRepo();
    const bin = mkdtempSync(join(tmpdir(), 'hb-gate-fake-'));
    tmpRoots.push(bin);
    gateOk = join(bin, 'gate-ok.sh');
    gateRed = join(bin, 'gate-red.sh');
    writeFileSync(gateOk, '#!/bin/sh\necho "fake gate GREEN $*"\n', { mode: 0o755 });
    writeFileSync(gateRed, '#!/bin/sh\necho "gate: RED at test" >&2\nexit 1\n', { mode: 0o755 });
    write(root, 'team/SIGNOFFS.md', '# Client sign-offs\n');
    write(root, 'team/APPROVALS.md', '# Approvals ledger (lead-only)\n\nOne line per review round:\n`<ID> r<n> APPROVED|CHANGES_REQUESTED tier=<low|high> reviewer=<rev-x> commits=<full-sha>[,…] review=artifacts/<ID>/review-r<n>.md`\n\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-1: ledgers', { HB_ROLE: 'lead' }));
    ok(git(root, 'branch', 'team/web'));
    wt = join(root, '.worktrees/web');
    ok(git(root, 'worktree', 'add', '-q', wt, 'team/web'));
  });

  // ---- controls (rev-d C1–C7) -------------------------------------------------------------------
  test('C1: no ledger line → refused, main untouched', () => {
    resetBranch();
    write(wt, 'apps/web/src/a.ts', 'export const a = 1;\n');
    commitIn(wt, 'WEB-1: a');
    const before = mainSha();
    const r = merge(['team/web']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no line for WEB-1 in team/APPROVALS.md');
    expect(mainSha()).toBe(before);
  });

  test('C2: approved low-risk commit merges --no-ff after a green gate; the table names the ledger line', () => {
    resetBranch();
    write(wt, 'apps/web/src/b.ts', 'export const b = 1;\n');
    const c = commitIn(wt, 'WEB-2: b');
    approve('WEB-2', 1, 'APPROVED', [c]);
    const before = mainSha();
    const r = merge(['team/web']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('MERGED');
    expect(r.stdout).toContain('ledger WEB-2 r1 APPROVED by rev-d');
    expect(ok(git(root, 'rev-parse', 'main^1')).stdout.trim()).toBe(before);
    expect(ok(git(root, 'rev-parse', 'main^2')).stdout.trim()).toBe(c);
    expect(readFileSync(join(root, 'artifacts/merges.log'), 'utf8')).toContain('team/web');
    expect(ok(git(root, 'worktree', 'list')).stdout).not.toContain('hb-merge');
  });

  test('C3: an approval recorded under another ID does not cover the commit', () => {
    resetBranch();
    write(wt, 'apps/web/src/c3.ts', 'export {};\n');
    const c = commitIn(wt, 'WEB-3: c3');
    approve('OTHER-1', 1, 'APPROVED', [c]);
    const r = merge(['team/web', '--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no line for WEB-3');
  });

  test('C4 / X7: high risk needs a SIGNOFFS line "<ID> <exact full sha> — signed off"; malformed sign-off lines refuse everything', () => {
    resetBranch();
    write(wt, 'apps/web/src/e.ts', 'export const e = 1;\n');
    const c = commitIn(wt, 'WEB-5: e', tier('Risk tier: high'));
    approve('WEB-5', 1, 'APPROVED', [c]);
    signoff(`WEB-5 ${'0'.repeat(40)} — signed off 2026-11-05`); // another sha (C4): well-formed, does not cover c
    let r = merge(['team/web', '--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no 'WEB-5");
    const f = join(root, 'team/SIGNOFFS.md');
    const clean = readFileSync(f, 'utf8');
    for (const bad of [
      `WEB-5 ${c} — client REFUSED, do not merge`, // X7
      `WEB-5 ${c.slice(0, 12)} — signed off 2026-11-05`, // short sha
      ` WEB-5 ${c} — signed off 2026-11-05`, // leading space
      `WEB-5 ${c} — signed off 2026-11-05\r`, // CRLF
    ]) {
      signoff(bad);
      r = merge(['team/web', '--dry-run']);
      expect(r.status, JSON.stringify(bad)).toBe(1);
      expect(r.stderr).toContain('malformed sign-off line');
      writeFileSync(f, clean);
      ok(git(root, 'add', '-A'));
      ok(commit(root, 'BOOT-8: sign-off repair', { HB_ROLE: 'lead' }));
    }
    signoff(`WEB-5 ${c} — signed off 2026-11-05 — evidence artifacts/WEB-5/`);
    r = merge(['team/web']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  test('C5: a --no-verify commit touching another owner\'s path is refused', () => {
    resetBranch();
    write(wt, 'packages/db/src/y.ts', 'export {};\n');
    const c = commitIn(wt, 'WEB-6: foreign', GOOD_BODY, true);
    approve('WEB-6', 1, 'APPROVED', [c]);
    const r = merge(['team/web', '--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ownership');
    expect(r.stderr).toContain('owned by db');
  });

  test('C6: malformed or missing Risk tier lines are refused (and full format is checked)', () => {
    for (const t of ['Risk tier: High', 'Risk tier:  high', 'risk tier: high', 'Risk tier: medium', '']) {
      resetBranch();
      write(wt, 'apps/web/src/t.ts', `// ${t}\n`);
      const c = commitIn(wt, 'WEB-7: tier', tier(t), true);
      approve('WEB-7', 1, 'APPROVED', [c]);
      const r = merge(['team/web', '--dry-run']);
      expect(r.status, t).toBe(1);
      expect(r.stderr).toMatch(/Risk tier|message format/);
    }
    resetBranch();
    write(wt, 'apps/web/src/t2.ts', 'export {};\n');
    const c = commitIn(wt, 'WEB-8: empty fields', 'What changed:\nTesting:\nRisk tier: low\nRevert:\n', true);
    approve('WEB-8', 1, 'APPROVED', [c]);
    expect(merge(['team/web', '--dry-run']).stderr).toContain('message format');
  });

  test('C7: a branch that merged main with -s ours (reverting a main change) is refused', () => {
    resetBranch();
    write(wt, 'apps/web/src/c7.ts', 'export {};\n');
    const c = commitIn(wt, 'WEB-9: c7');
    write(root, 'REVIEW.md', 'main change\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-2: main change', { HB_ROLE: 'lead' }));
    ok(sh(wt, 'git', ['-c', 'core.hooksPath=/dev/null', 'merge', '-q', '-s', 'ours', '--no-edit', 'main']));
    approve('WEB-9', 1, 'APPROVED', [c]);
    const r = merge(['team/web', '--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/conflict-resolution|net-diff/);
  });

  // ---- attacks (rev-d X1–X8) ----------------------------------------------------------------------
  test('X1: the ledger tier raises the commit\'s tier; high without sign-off is refused', () => {
    resetBranch();
    write(wt, 'apps/web/src/x1.ts', 'export {};\n');
    const c = commitIn(wt, 'WEB-10: x1');
    approve('WEB-10', 1, 'APPROVED', [c], 'high');
    const r = merge(['team/web', '--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('effective tier high');
  });

  test('X2–X4: review files are evidence, never authority (drafts, quoted verdicts, self-written approvals)', () => {
    resetBranch();
    write(wt, 'apps/web/src/x2.ts', 'export {};\n');
    const c = commitIn(wt, 'WEB-11: x2');
    const art = join(root, 'artifacts/WEB-11');
    write(art, 'review-r1.md', `Findings: 0\nVerdict: APPROVED\nCommits: ${c}\nReviewer: web · Risk tier: low\n`);
    write(art, 'review-r1-draft.md', `Findings: 0\nVerdict: APPROVED\nCommits: ${c}\nReviewer: rev-d · Risk tier: low\n`);
    expect(merge(['team/web', '--dry-run']).status).toBe(1);
    approve('WEB-11', 1, 'CHANGES_REQUESTED', [c]);
    const r = merge(['team/web', '--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('latest ledger line for WEB-11 is r1 CHANGES_REQUESTED');
  });

  test('X4b: a teammate cannot write the ledger (pre-commit) and a ledger line naming a non-reviewer refuses everything', () => {
    resetBranch();
    write(wt, 'team/APPROVALS.md', 'WEB-12 r1 APPROVED tier=low reviewer=rev-d commits=' + 'a'.repeat(40) + ' review=x\n');
    ok(git(wt, 'add', '-A'));
    const r1 = sh(wt, 'git', ['commit', '-q', '-F', '-'], {}, msg('WEB-12: forge'));
    expect(r1.status).not.toBe(0);
    expect(r1.stderr).toContain('owned by lead');
    ok(git(wt, 'reset', '-q', '--hard'));
    write(wt, 'apps/web/src/x4b.ts', 'export {};\n');
    commitIn(wt, 'WEB-12: x4b'); // something to merge, so the ledger is read
    ledger(`WEB-12 r1 APPROVED tier=low reviewer=rev-z commits=${'b'.repeat(40)} review=x`);
    const r2 = merge(['team/web', '--dry-run']);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("reviewer 'rev-z' is not a reviewer");
    ledger('WEB-12 r2 APPROVED tier=low reviewer=rev-d commits=abc1234 review=x');
    const r3 = merge(['team/web', '--dry-run']);
    expect(r3.stderr).toContain('malformed ledger line');
    // the lead repairs the ledger by rewriting those lines
    const f = join(root, 'team/APPROVALS.md');
    writeFileSync(f, readFileSync(f, 'utf8').split('\n').filter((l) => !l.startsWith('WEB-12 ')).join('\n'));
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-9: ledger repair', { HB_ROLE: 'lead' }));
  });

  test('X4e / X4h (rev-d r2): a ledger line with odd spacing, tab, CRLF, lowercase verdict or short sha is never ignored — it refuses everything', () => {
    for (const bad of [
      ' WEB-14 r2 CHANGES_REQUESTED tier=low reviewer=rev-d commits=CS review=x', // X4e leading space
      'WEB-14  r2 CHANGES_REQUESTED tier=low reviewer=rev-d commits=CS review=x', // X4h two spaces
      'WEB-14\tr2 CHANGES_REQUESTED tier=low reviewer=rev-d commits=CS review=x', // tab
      'WEB-14 r2 CHANGES_REQUESTED tier=low reviewer=rev-d commits=CS review=x trailing', // junk
      '- WEB-14 r2 CHANGES_REQUESTED tier=low reviewer=rev-d commits=CS review=x', // list bullet
      'WEB-14 r2 CHANGES_REQUESTED tier=low reviewer=rev-d commits=CS review=x\r', // CRLF
      'WEB-14 r2 changes_requested tier=low reviewer=rev-d commits=CS review=x', // lowercase verdict
      'WEB-14 r2 CHANGES_REQUESTED tier=low reviewer=rev-d commits=SHORT review=x', // truncated sha
    ]) {
      resetBranch();
      write(wt, 'apps/web/src/x4e.ts', `// ${bad.length}\n`);
      const c = commitIn(wt, 'WEB-14: x4e');
      approve('WEB-14', 1, 'APPROVED', [c]);
      ledger(bad.replace('CS', c).replace('SHORT', c.slice(0, 12)));
      const r = merge(['team/web', '--dry-run']);
      expect(r.status, JSON.stringify(bad)).toBe(1);
      expect(r.stderr).toContain('malformed ledger line');
      // the lead repairs the ledger
      const f = join(root, 'team/APPROVALS.md');
      writeFileSync(f, readFileSync(f, 'utf8').split('\n').filter((l) => !l.includes('WEB-14')).join('\n'));
      ok(git(root, 'add', '-A'));
      ok(commit(root, 'BOOT-9: ledger repair', { HB_ROLE: 'lead' }));
    }
  });

  test('X5 / X6: merge commits adding a foreign file are refused, octopus explicitly', () => {
    for (const kind of ['octopus', 'two']) {
      resetBranch();
      write(wt, 'apps/web/src/x5.ts', 'export {};\n');
      const s0 = commitIn(wt, 'WEB-13: x5');
      const sides: string[] = [];
      for (const b of kind === 'octopus' ? ['side1', 'side2'] : ['side1']) {
        ok(git(wt, 'checkout', '-q', '-B', b, 'main'));
        write(wt, `apps/web/src/${b}.ts`, 'export {};\n');
        sides.push(commitIn(wt, `WEB-13: ${b}`, GOOD_BODY, true));
      }
      ok(git(wt, 'checkout', '-q', 'team/web'));
      ok(sh(wt, 'git', ['-c', 'core.hooksPath=/dev/null', 'merge', '-q', '--no-ff', '--no-commit', ...(kind === 'octopus' ? ['side1', 'side2'] : ['side1'])]));
      write(wt, 'packages/db/src/evil.ts', 'evil\n');
      ok(git(wt, 'add', '-A'));
      ok(sh(wt, 'git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'Merge sides']));
      approve('WEB-13', 1, 'APPROVED', [s0, ...sides]);
      const r = merge(['team/web', '--dry-run']);
      expect(r.status, kind).toBe(1);
      expect(r.stderr).toContain(kind === 'octopus' ? 'octopus merge' : 'conflict-resolution');
      expect(git(root, 'cat-file', '-e', 'main:packages/db/src/evil.ts').status).not.toBe(0);
    }
  });

  test('X8 (lead ruling): r1 CHANGES_REQUESTED lists A, r2 APPROVED lists B → both merge; r2 CHANGES_REQUESTED → neither', () => {
    resetBranch();
    write(wt, 'apps/web/src/m1.ts', 'export const m = 1;\n');
    const a = commitIn(wt, 'WEB-16: m');
    write(wt, 'apps/web/src/m1.ts', 'export const m = 2;\n');
    const b = commitIn(wt, 'WEB-16: address review r1');
    approve('WEB-16', 1, 'CHANGES_REQUESTED', [a]);
    approve('WEB-16', 2, 'CHANGES_REQUESTED', [b]);
    const r1 = merge(['team/web', '--dry-run']);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain(a.slice(0, 9));
    expect(r1.stderr).toContain(b.slice(0, 9));
    approve('WEB-16', 2, 'APPROVED', [b]); // same round recorded again: the later line wins
    const r2 = merge(['team/web']);
    expect(r2.status, r2.stdout + r2.stderr).toBe(0);
    expect(git(root, 'merge-base', '--is-ancestor', a, 'main').status).toBe(0);
  });

  test('a commit on no ledger line is refused even when its ID is approved', () => {
    resetBranch();
    write(wt, 'apps/web/src/n.ts', 'export const n = 1;\n');
    const a = commitIn(wt, 'WEB-17: n');
    write(wt, 'apps/web/src/n2.ts', 'export const n = 2;\n');
    commitIn(wt, 'WEB-17: unreviewed follow-up');
    approve('WEB-17', 1, 'APPROVED', [a]);
    const r = merge(['team/web', '--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not listed for WEB-17');
  });

  test('a D1/Drizzle migration (packages/db/migrations/*.sql) from team/db passes merge.sh (rev-a TOOL-7)', () => {
    ok(git(root, 'branch', '-f', 'team/db', 'main'));
    const dbw = join(root, '.worktrees/db');
    if (!existsSync(dbw)) ok(git(root, 'worktree', 'add', '-q', dbw, 'team/db'));
    ok(git(dbw, 'reset', '-q', '--hard', 'main'));
    write(dbw, 'packages/db/migrations/0006_new.sql', 'CREATE TABLE t (id INTEGER PRIMARY KEY);\n');
    const c = commitIn(dbw, 'DB-9: migration 0006');
    approve('DB-9', 1, 'APPROVED', [c], 'low', 'rev-d');
    const r = merge(['team/db', '--dry-run']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('OK (author db');
  });

  // ---- mechanics -----------------------------------------------------------------------------------
  test('red gate leaves main and branches untouched; dry-run never moves main', () => {
    resetBranch();
    write(wt, 'apps/web/src/f.ts', 'export const f = 1;\n');
    const c = commitIn(wt, 'WEB-18: f');
    approve('WEB-18', 1, 'APPROVED', [c]);
    const before = mainSha();
    const r = merge(['team/web'], gateRed);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('RED');
    expect(mainSha()).toBe(before);
    expect(ok(git(root, 'branch', '--list', 'hb-merge/*')).stdout.trim()).toBe('');
    const d = merge(['team/web', '--dry-run']);
    expect(d.status, d.stderr).toBe(0);
    expect(d.stdout).toContain('DRY-RUN OK');
    expect(mainSha()).toBe(before);
  });

  test('conflict refuses and leaves main untouched', () => {
    resetBranch();
    write(wt, 'apps/web/src/conflict.ts', 'export const v = "web";\n');
    const c = commitIn(wt, 'WEB-19: conflict');
    write(root, 'apps/web/src/conflict.ts', 'export const v = "lead";\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-3: conflict', { HB_ROLE: 'lead' }));
    approve('WEB-19', 1, 'APPROVED', [c]);
    const before = mainSha();
    const r = merge(['team/web']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('conflicts with main');
    expect(mainSha()).toBe(before);
  });

  test('merge commits: a conflict resolution needs a ledger listing; a clean merge of main needs none', () => {
    resetBranch();
    write(wt, 'apps/web/src/conflict2.ts', 'export const v = "web";\n');
    const c = commitIn(wt, 'WEB-20: conflict2');
    write(root, 'apps/web/src/conflict2.ts', 'export const v = "lead";\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-4: conflict2', { HB_ROLE: 'lead' }));
    expect(git(wt, 'merge', '-q', '--no-edit', 'main').status).not.toBe(0);
    write(wt, 'apps/web/src/conflict2.ts', 'export const v = "both";\n');
    ok(git(wt, 'add', '-A'));
    ok(sh(wt, 'git', ['commit', '-q', '--no-edit']));
    const m = ok(git(wt, 'rev-parse', 'HEAD')).stdout.trim();
    approve('WEB-20', 1, 'APPROVED', [c]);
    const r1 = merge(['team/web', '--dry-run']);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain('conflict-resolution');
    approve('WEB-20', 2, 'APPROVED', [m]);
    const r2 = merge(['team/web', '--dry-run']);
    expect(r2.status, r2.stdout + r2.stderr).toBe(0);

    resetBranch();
    write(wt, 'apps/web/src/j.ts', 'export const j = 1;\n');
    const c2 = commitIn(wt, 'WEB-21: j');
    write(root, 'apps/admin/src/auth/other.ts', 'export {};\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-5: other', { HB_ROLE: 'lead' }));
    ok(git(wt, 'merge', '-q', '--no-edit', 'main'));
    approve('WEB-21', 1, 'APPROVED', [c2]);
    const r3 = merge(['team/web', '--dry-run']);
    expect(r3.status, r3.stdout + r3.stderr).toBe(0);
    expect(r3.stdout).toContain('clean merge');
  });

  test('commits merged in from another team branch are attributed to that branch', () => {
    resetBranch();
    ok(git(root, 'branch', '-f', 'team/admin-core', 'main'));
    const ac = join(root, '.worktrees/admin-core');
    if (!existsSync(ac)) ok(git(root, 'worktree', 'add', '-q', ac, 'team/admin-core'));
    ok(git(ac, 'reset', '-q', '--hard', 'main'));
    write(ac, 'apps/admin/src/routes/dashboard/x.ts', 'export {};\n');
    const a = commitIn(ac, 'ADMIN-20: dashboard');
    ok(git(wt, 'merge', '-q', '--no-edit', 'team/admin-core'));
    write(wt, 'apps/web/src/k.ts', 'export {};\n');
    const w = commitIn(wt, 'WEB-22: k');
    approve('ADMIN-20', 1, 'APPROVED', [a], 'low', 'rev-f');
    approve('WEB-22', 1, 'APPROVED', [w]);
    const r = merge(['team/web', '--dry-run']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('OK (author admin-core');
  });

  test('net diff (review F1): a revert hidden in a merge commit is refused even when the merge is listed', () => {
    resetBranch();
    write(wt, 'apps/web/src/l.ts', 'export {};\n');
    const w = commitIn(wt, 'WEB-23: l');
    write(root, 'apps/admin/src/app.ts', 'export const a = 42;\n');
    ok(git(root, 'add', '-A'));
    ok(commit(root, 'BOOT-7: admin change on main', { HB_ROLE: 'lead' }));
    ok(sh(wt, 'git', ['-c', 'core.hooksPath=/dev/null', 'merge', '-q', '-s', 'ours', '--no-edit', 'main']));
    const m = ok(git(wt, 'rev-parse', 'HEAD')).stdout.trim();
    approve('WEB-23', 1, 'APPROVED', [w, m]);
    const r = merge(['team/web', '--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('net-diff');
    expect(r.stderr).toContain('apps/admin/src/app.ts');
  });
});
