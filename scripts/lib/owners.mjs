#!/usr/bin/env node
// Ownership rules from team/owners.json. No dependencies (node:path matchesGlob, Node 24).
//
//   node scripts/lib/owners.mjs check-staged <name> [--lead]   pre-commit checks on the index
//   node scripts/lib/owners.mjs check-commit <name> <sha>      same rules for one commit (merge.sh)
//   node scripts/lib/owners.mjs check-net <author> <base> <result>   net diff of a merge (stdin: sha owner)
//   node scripts/lib/owners.mjs needs-review <sha> <globs-file>      paths of a commit on the review-required list
//   node scripts/lib/owners.mjs violations <name> [path…]      paths <name> may not write (args or stdin, one per line)
//   node scripts/lib/owners.mjs port <name>                    print portBase
//   node scripts/lib/owners.mjs owner-of <path>                print the owners allowed to write <path>
//
// Exit codes: 0 ok, 1 violation / unknown name, 2 usage or config error.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';

const repoRoot = () => git(['rev-parse', '--show-toplevel']).trim();

function git(args, input) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function loadOwners() {
  const file = process.env.HB_OWNERS_FILE || join(repoRoot(), 'team/owners.json');
  if (!existsSync(file)) throw new Error(`owners file not found: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

// matchesGlob never lets * or ** match a segment that starts with "." (dotfiles). Ownership must
// cover dotfiles too (apps/admin/.dev.vars.example), so match a second time with every leading dot
// rewritten in both path and glob: wildcards then match dot segments, literal dot segments still match.
const undot = (s) => s.replace(/(^|\/)\./g, '$1\u0001dot');
const match = (path, glob) => matchesGlob(path, glob) || matchesGlob(undot(path), undot(glob));
const any = (path, globs = []) => globs.some((g) => match(path, g));
// Case-insensitive variant for the dump backstop (BACKUP.SQL.GZ, D1-EXPORT-…, Backups/; rev-a TOOL-7 N1).
const anyCI = (path, globs = []) => globs.some((g) => match(path.toLowerCase(), g.toLowerCase()));

/** Owner that a reserved glob pins this path to, or null. */
export function reservedOwner(cfg, path) {
  for (const [owner, globs] of Object.entries(cfg.reserved ?? {})) if (any(path, globs)) return owner;
  return null;
}

export function mayWrite(cfg, name, path) {
  const r = reservedOwner(cfg, path);
  if (r) return r === name;
  const o = cfg.owners[name];
  if (!o) return false;
  return any(path, o.paths) && !any(path, o.except);
}

export function ownersOf(cfg, path) {
  return Object.keys(cfg.owners).filter((n) => mayWrite(cfg, n, path));
}

function explain(cfg, path) {
  const who = ownersOf(cfg, path);
  if (who.length === 0) return 'no owner in team/owners.json: ask the lead (team-lead) who should own it';
  return who
    .map((n) => {
      const rev = cfg.owners[n]?.reviewer;
      return `owned by ${n}${rev ? ` (reviewer ${rev})` : ''}`;
    })
    .join('; ');
}

/** Parse `git diff <args> --name-status -z -M`. Returns [{status, paths:[...]}]. */
function diffChanges(args) {
  const out = git(['diff', ...args, '--name-status', '-z', '-M', '--no-ext-diff']);
  const f = out.split('\0');
  const res = [];
  for (let i = 0; i < f.length - 1; ) {
    const status = f[i++];
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') res.push({ status: status[0], paths: [f[i++], f[i++]] });
    else res.push({ status: status[0], paths: [f[i++]] });
  }
  return res;
}

/** Batch object lookup: returns Map spec -> {oid, size} or null when missing. */
function batchCheck(specs) {
  const m = new Map();
  if (specs.length === 0) return m;
  const out = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], specs.join('\n') + '\n');
  const lines = out.split('\n');
  specs.forEach((s, i) => {
    const l = lines[i] ?? '';
    const [oid, type, size] = l.split(' ');
    m.set(s, type && type !== 'missing' && oid && !l.endsWith('missing') ? { oid, size: Number(size) } : null);
  });
  return m;
}

function hasRef(ref) {
  try {
    git(['rev-parse', '-q', '--verify', ref]);
    return true;
  } catch {
    return false;
  }
}

function showOrEmpty(spec) {
  try {
    return git(['show', spec]);
  } catch {
    return '';
  }
}

export function checkStaged(cfg, name, { lead = false } = {}) {
  // Their side of a merge: MERGE_HEAD after a conflict (`git commit`), or HB_MERGE_THEIRS from
  // .githooks/pre-merge-commit (git writes MERGE_HEAD only after that hook has run).
  const theirs = hasRef('MERGE_HEAD') ? git(['rev-parse', 'MERGE_HEAD']).trim() : process.env.HB_MERGE_THEIRS || '';
  // On a merge also list paths where the result differs from THEIR side (a kept-old-copy revert is
  // identical to HEAD, so `diff --cached` alone would never show it).
  const changes = diffChanges(['--cached']);
  if (theirs) {
    const seen = new Set(changes.flatMap((c) => c.paths));
    for (const c of diffChanges(['--cached', theirs])) {
      if (!c.paths.some((p) => seen.has(p))) changes.push(c);
    }
  }
  return checkChanges(cfg, name, { lead, changes, before: 'HEAD', after: '', theirs });
}

/** Ownership/size/append rules for one existing commit (merge.sh backstop). Merge commits are not checked here. */
export function checkCommit(cfg, name, sha, { lead = false } = {}) {
  return checkChanges(cfg, name, {
    lead,
    changes: diffChanges([`${sha}^`, sha]),
    before: `${sha}^`,
    after: sha,
    theirs: '',
  });
}

/**
 * Net-diff ownership for a merge into main (merge.sh, review F1): every path that `result` changes
 * relative to `base` (main) must be writable by `author`, or be exactly the version produced by a
 * commit in the range whose attributed owner may write it. Anything else (a kept-old-copy revert, an
 * edit inside a merge commit) is refused, whoever's branch carries it.
 * `attributed` = [{sha, owner}] for the range's non-merge commits that passed their own checks.
 */
export function checkNet(cfg, author, base, result, attributed) {
  const problems = [];
  const paths = git(['diff', '--name-only', '--no-renames', '-z', base, result]).split('\0').filter(Boolean);
  const touchedBy = new Map(); // sha -> Set(paths)
  for (const { sha } of attributed) {
    touchedBy.set(sha, new Set(git(['diff-tree', '--no-commit-id', '-r', '--name-only', '--no-renames', '-z', '--root', sha]).split('\0').filter(Boolean)));
  }
  const specs = [];
  for (const p of paths) {
    specs.push(`${result}:${p}`);
    for (const { sha } of attributed) if (touchedBy.get(sha)?.has(p)) specs.push(`${sha}:${p}`);
  }
  const objs = batchCheck(specs);
  for (const p of paths) {
    if (mayWrite(cfg, author, p) || (any(p, cfg.appendOnlyForAll) && appendOnly(base, result, p))) continue;
    const want = objs.get(`${result}:${p}`)?.oid ?? '';
    const explained = attributed.some(
      // owner '*' = a commit under a lead 'owner' exception: it explains exactly the version it wrote
      ({ sha, owner }) => touchedBy.get(sha)?.has(p) && (owner === '*' || mayWrite(cfg, owner, p)) && (objs.get(`${sha}:${p}`)?.oid ?? '') === want,
    );
    if (!explained) {
      problems.push(
        `${p}: the merge would change it on main (${explain(cfg, p)}) but no reviewed commit of its owner in the range produces this version — a revert or an edit inside a merge`,
      );
    }
  }
  return problems;
}

function appendOnly(base, result, p) {
  const was = showOrEmpty(`${base}:${p}`);
  const now = showOrEmpty(`${result}:${p}`);
  return now.startsWith(was) && now.length >= was.length;
}

function checkChanges(cfg, name, { lead, changes, before, after, theirs }) {
  const merging = Boolean(theirs);
  const problems = [];
  if (!lead && !cfg.owners[name]) {
    return [`"${name}" is not a teammate in team/owners.json; commit from your own branch team/<your-name>`];
  }
  const A = (p) => `${after}:${p}`;
  const B = (p) => `${before}:${p}`;

  let touched = []; // {path, deleted}
  for (const c of changes) {
    if (c.status === 'R') {
      touched.push({ path: c.paths[0], deleted: true }, { path: c.paths[1], deleted: false });
    } else if (c.status === 'C') {
      touched.push({ path: c.paths[1], deleted: false });
    } else {
      touched.push({ path: c.paths[0], deleted: c.status === 'D' });
    }
  }

  // On a merge, `before` is our side (HEAD) and `theirs` the merged commit; base = their merge base.
  const base = merging ? git(['merge-base', 'HEAD', theirs]).trim() : '';
  const specs = [];
  for (const t of touched) {
    specs.push(A(t.path), B(t.path));
    if (merging) specs.push(`${theirs}:${t.path}`, `${base}:${t.path}`);
  }
  const objs = batchCheck(specs);

  if (merging) {
    // A merge "authors" a path when its result is not theirs AND (it is not ours either, or they had
    // changed it since the base). The second case is a merge that keeps our old copy and so silently
    // reverts their change (`-s ours`, `checkout HEAD -- f` during a merge); it must pass ownership.
    touched = touched.filter((t) => {
      const res = objs.get(A(t.path))?.oid ?? '';
      const ours = objs.get(B(t.path))?.oid ?? '';
      const their = objs.get(`${theirs}:${t.path}`)?.oid ?? '';
      const was = objs.get(`${base}:${t.path}`)?.oid ?? '';
      return res !== their && (res !== ours || their !== was);
    });
  }

  const max = cfg.maxFileBytes ?? 2 * 1024 * 1024;
  for (const t of touched) {
    // backup dumps never enter git (JOBS-1 F5): forbidden for everyone, lead included, everywhere —
    // inside packages/db/migrations/ too. cfg.forbiddenExcept admits only the exact files Drizzle
    // writes there (NNNN_*.sql, meta/_journal.json, meta/NNNN_snapshot.json; rev-a TOOL-7 r1).
    if (!t.deleted && anyCI(t.path, cfg.forbiddenGlobs) && !any(t.path, cfg.forbiddenExcept)) {
      problems.push(`${t.path}: looks like a database dump/backup (${(cfg.forbiddenGlobs ?? []).join(', ')}); these never go into git — delete it or move it out of the repo`);
      continue;
    }
    // per-directory size caps (e.g. apps/jobs/** ≤ 1 MB)
    if (!t.deleted) {
      const o = objs.get(A(t.path));
      for (const [glob, cap] of Object.entries(cfg.maxBytesByGlob ?? {})) {
        if (o && o.size > cap && match(t.path, glob)) {
          problems.push(`${t.path}: ${(o.size / 1048576).toFixed(2)} MB is over the ${(cap / 1048576).toFixed(0)} MB limit for ${glob}`);
        }
      }
    }
    // size rule (everyone, lead included)
    if (!t.deleted) {
      const o = objs.get(A(t.path));
      if (o && o.size > max && !any(t.path, cfg.largeFileGlobs)) {
        problems.push(
          `${t.path}: ${(o.size / 1048576).toFixed(1)} MB is over the ${(max / 1048576).toFixed(0)} MB limit; ` +
            `large files are allowed only under: ${(cfg.largeFileGlobs ?? []).join(', ')} (ask tooling to add a directory)`,
        );
      }
    }
    if (lead) continue;
    if (mayWrite(cfg, name, t.path)) continue;
    if (any(t.path, cfg.appendOnlyForAll) && !t.deleted) {
      const was = showOrEmpty(B(t.path));
      const now = showOrEmpty(A(t.path));
      if (now.startsWith(was) && now.length > was.length) continue;
      problems.push(
        `${t.path}: you may only append to it (add a new entry at the end; change nothing above). ` +
          `To revise an entry, append a new one that supersedes it.`,
      );
      continue;
    }
    const r = reservedOwner(cfg, t.path);
    const hint = r === 'tooling' ? ' Dependencies and tsconfig changes: message tooling with package, exact version, workspace and why.' : '';
    problems.push(
      `${t.path}: ${explain(cfg, t.path)}. Ask them to make this change, or unstage it: git restore --staged -- '${t.path}'.${hint}`,
    );
  }
  return problems;
}

function readStdinLines() {
  try {
    return readFileSync(0, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'check-staged') {
      const name = rest[0];
      const lead = rest.includes('--lead');
      if (!name) throw new Error('usage: check-staged <name> [--lead]');
      const cfg = loadOwners();
      const problems = checkStaged(cfg, name, { lead });
      if (problems.length) {
        process.stderr.write(
          `pre-commit: refused for ${lead ? 'lead on main' : `team/${name}`} — ${problems.length} problem(s):\n` +
            problems.map((p) => `  - ${p}`).join('\n') +
            '\nRules: team/owners.json, team/BRIEF.md §3.\n',
        );
        return 1;
      }
      return 0;
    }
    if (cmd === 'check-commit') {
      const [name, sha] = rest;
      if (!name || !sha) throw new Error('usage: check-commit <name> <sha> [--lead]');
      // --lead: ownership skipped, dump/size/append rules still applied (merge.sh 'owner' exception)
      const problems = checkCommit(loadOwners(), name, sha, { lead: rest.includes('--lead') });
      if (problems.length) {
        process.stderr.write(problems.map((p) => `${p}`).join('\n') + '\n');
        return 1;
      }
      return 0;
    }
    if (cmd === 'check-net') {
      // check-net <author> <base> <result>; stdin: "<sha> <owner>" lines
      const [author, base, result] = rest;
      if (!author || !base || !result) throw new Error('usage: check-net <author> <base> <result> < sha-owner lines');
      const attributed = readStdinLines().map((l) => {
        const [sha, owner] = l.trim().split(/\s+/);
        return { sha, owner };
      });
      const problems = checkNet(loadOwners(), author, base, result, attributed);
      if (problems.length) {
        process.stderr.write(problems.join('\n') + '\n');
        return 1;
      }
      return 0;
    }
    if (cmd === 'needs-review') {
      // needs-review <sha> <globs-file>: prints the commit's paths matching the list; exit 0 if any, 1 if none
      const [sha, file] = rest;
      if (!sha || !file) throw new Error('usage: needs-review <sha> <globs-file>');
      const globs = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      const paths = git(['diff-tree', '--no-commit-id', '-r', '--name-only', '--no-renames', '-z', '--root', sha]).split('\0').filter(Boolean);
      const hit = paths.filter((p) => any(p, globs));
      if (hit.length) process.stdout.write(hit.join('\n') + '\n');
      return hit.length ? 0 : 1;
    }
    if (cmd === 'violations') {
      const [name, ...paths] = rest;
      if (!name) throw new Error('usage: violations <name> [path…]');
      const cfg = loadOwners();
      const list = paths.length ? paths : readStdinLines();
      const bad = list.filter((p) => !mayWrite(cfg, name, p) && !any(p, cfg.appendOnlyForAll));
      if (bad.length) process.stdout.write(bad.join('\n') + '\n');
      return bad.length ? 1 : 0;
    }
    if (cmd === 'port') {
      const cfg = loadOwners();
      const o = cfg.owners[rest[0] ?? ''];
      if (!o || typeof o.portBase !== 'number') {
        process.stderr.write(`port: unknown teammate "${rest[0] ?? ''}" (see team/owners.json)\n`);
        return 1;
      }
      process.stdout.write(`${o.portBase}\n`);
      return 0;
    }
    if (cmd === 'owner-of') {
      const cfg = loadOwners();
      const who = ownersOf(cfg, rest[0] ?? '');
      process.stdout.write(who.join('\n') + (who.length ? '\n' : ''));
      return who.length ? 0 : 1;
    }
    throw new Error('usage: owners.mjs check-staged|violations|port|owner-of …');
  } catch (e) {
    process.stderr.write(`owners.mjs: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('owners.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
