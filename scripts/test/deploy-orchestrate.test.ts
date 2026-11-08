import { describe, expect, it } from 'vitest';
import type { MigrationFile } from '../deploy/migrations.ts';
import { build, CATALOGUE_TABLES, check, DeployHalt, deployWorkers, exportedTables, preflightProblems, prepare, rollback, smoke, type CommandResult, type DeployState, type Io, type PublishedSnapshot, type RunConfig, type WranglerConfig } from '../deploy/orchestrate.ts';

const SHA = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
const D1_ID = 'c8d6f1e0-0000-4000-8000-000000000001';

const goodConfigs: Record<string, WranglerConfig> = {
  'apps/jobs/wrangler.jsonc': { d1_databases: [{ database_id: D1_ID }] },
  'apps/web/wrangler.jsonc': { d1_databases: [{ database_id: D1_ID }], routes: [{ pattern: 'comptoirdeluxe.com', custom_domain: true }], vars: { SITE_HOSTS: 'comptoirdeluxe.com,www.comptoirdeluxe.com' } },
  'apps/admin/wrangler.jsonc': {
    d1_databases: [{ database_id: D1_ID }],
    routes: [{ pattern: 'admin.comptoirdeluxe.com', custom_domain: true }],
    workers_dev: false,
    preview_urls: false,
    vars: { ACCESS_TEAM_DOMAIN: 'https://hbteam.cloudflareaccess.com', ACCESS_AUD: 'a'.repeat(64) },
  },
};

interface Options {
  applied?: string[];
  tables?: string[];
  files?: MigrationFile[];
  products?: number;
  versions?: Record<string, string | null>;
  smoke?: string[];
  failOn?: (args: readonly string[]) => boolean;
  rollbackFails?: boolean;
  tip?: string;
  statusError?: string;
  exportSql?: string;
  executeOutput?: string;
  sameVersionAfterDeploy?: boolean;
}

const safe: MigrationFile = { name: '0010_add.sql', content: 'ALTER TABLE t ADD c text;' };
const destructive: MigrationFile = { name: '0011_drop.sql', content: 'DROP TABLE t;' };
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

function harness(opts: Options = {}) {
  const calls: string[][] = [];
  const steps: string[] = [];
  const summary: string[] = [];
  const logs: string[] = [];
  const outputs: Record<string, string> = {};
  const captures: Record<string, boolean> = {};
  let state: DeployState = {};
  const io: Io = {
    async wrangler(args, o) {
      calls.push([...args]);
      captures[args.slice(0, 2).join(' ')] = o?.capture === true;
      if (opts.failOn?.(args)) return { code: 1, stdout: '', stderr: 'boom' };
      const line = args.join(' ');
      if (args[0] === 'deployments') {
        const name = args[args.indexOf('--name') + 1]!;
        const v = opts.versions === undefined ? `old-${name}` : opts.versions[name];
        const deployed = calls.some((c) => c[0] === 'deploy' && c.includes(`apps/${name.replace('hb-', '')}/wrangler.jsonc`));
        if (opts.statusError !== undefined) return { code: 1, stdout: '', stderr: opts.statusError };
        if (deployed && !opts.sameVersionAfterDeploy) return ok(JSON.stringify({ versions: [{ version_id: `new-${name}`, percentage: 100 }] }));
        if (v === null) return { code: 1, stdout: '', stderr: 'This Worker does not exist on your account. [code: 10007]' };
        return ok(JSON.stringify({ versions: [{ version_id: v, percentage: 100 }] }));
      }
      if (args[0] === 'rollback') {
        steps.push(`rollback ${args[args.indexOf('--name') + 1]}`);
        return opts.rollbackFails ? { code: 1, stdout: '', stderr: 'no' } : ok();
      }
      if (args[0] === 'deploy') {
        steps.push(`deploy ${args[2]}`);
        return ok();
      }
      if (line.startsWith('d1 time-travel info')) {
        steps.push('bookmark');
        return ok(JSON.stringify({ bookmark: 'bm-123' }));
      }
      if (line.startsWith('d1 migrations apply')) {
        steps.push(args.includes('--remote') ? 'migrate remote' : 'migrate local');
        return ok();
      }
      if (line.startsWith('d1 export')) {
        steps.push('export');
        return ok();
      }
      if (line.startsWith('d1 execute')) {
        if (opts.executeOutput !== undefined && args.includes('--remote')) return ok(opts.executeOutput);
        const sql = args[args.indexOf('--command') + 1] ?? '';
        if (sql.includes('sqlite_master')) return ok(JSON.stringify([{ results: (opts.tables ?? ['d1_migrations', 'products']).map((name) => ({ name })) }]));
        if (sql.includes('FROM d1_migrations')) return ok(JSON.stringify([{ results: (opts.applied ?? []).map((name) => ({ name })) }]));
        if (sql.includes('count(*)')) return ok(JSON.stringify([{ results: [{ products: opts.products ?? 3, wilayas: 69, store_name: 1 }] }]));
        if (sql.includes('updated_by')) return ok(JSON.stringify([{ results: [{ id: 7 }] }]));
        if (sql.includes('r2_key')) return ok(JSON.stringify([{ results: [{ key: 'p/a.jpg' }] }]));
        return ok('[{"results":[]}]');
      }
      return ok();
    },
    async git(args) {
      if (args[0] === 'rev-parse') return ok(`${args[1] === 'HEAD' ? SHA : (opts.tip ?? SHA)}\n`);
      return ok();
    },
    migrationFiles: async () => opts.files ?? [safe],
    readConfig: async (p) => goodConfigs[p]!,
    writeFile: async () => {},
    readFile: async () => opts.exportSql ?? 'PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "products" ("id") VALUES (1);\n',
    readState: async () => state,
    writeState: async (s) => void (state = s),
    fetchOriginals: async () => void steps.push('fetch originals'),
    loadOriginals: async () => void steps.push('load originals'),
    publish: async () => {
      steps.push('publish');
      return '/repo/.wrangler/publish/1/snapshot.json';
    },
    readSnapshot: async () => ({ products: [], settings: { turnstileSiteKey: 'k' } }) satisfies PublishedSnapshot,
    setOutput: (k, v) => void (outputs[k] = v),
    smoke: async (_s, scope) => {
      steps.push(`smoke ${scope}`);
      return opts.smoke ?? [];
    },
    log: (l) => logs.push(l),
    summary: (l) => summary.push(l),
  };
  return { io, calls, steps, summary, logs, outputs, captures, state: () => state };
}

const cfg = (over: Partial<RunConfig> = {}): RunConfig => ({
  mode: 'deploy', sha: SHA, event: 'push', ref: 'refs/heads/main', approval: '', olderCommit: 'no', repoRoot: '/repo', workDir: '/tmp/w', imageCache: '/tmp/c', ...over,
});

/** The workflow's steps, in order; the rollback step runs when one fails. */
async function run(c: RunConfig, io: Io): Promise<void> {
  if (!(await check(c, io))) return;
  try {
    await prepare(c, io);
    await build(c, io);
    await deployWorkers(c, io);
    await smoke(c, io);
  } catch (err) {
    await rollback(c, io);
    throw err;
  }
}

describe('deploy order', () => {
  it('restore point, migrations, catalogue, jobs, web, admin, smoke', async () => {
    const h = harness();
    await run(cfg(), h.io);
    expect(h.steps).toEqual([
      'bookmark', 'migrate remote', 'export', 'fetch originals', 'migrate local', 'load originals', 'publish',
      'deploy apps/jobs/wrangler.jsonc', 'deploy apps/web/wrangler.jsonc', 'deploy apps/admin/wrangler.jsonc', 'smoke all',
    ]);
    expect(h.summary.join('\n')).toContain('bm-123');
    expect(h.summary.join('\n')).toContain('new-hb-web');
  });

  it('never lets wrangler create a missing resource', async () => {
    const h = harness();
    await run(cfg(), h.io);
    const deploys = h.calls.filter((c) => c[0] === 'deploy');
    expect(deploys).toHaveLength(3);
    for (const d of deploys) expect(d).toContain('--no-experimental-provision');
  });

  it('exports only the allowlisted tables, data only, from the remote', async () => {
    const h = harness();
    await run(cfg(), h.io);
    const exp = h.calls.find((c) => c[1] === 'export')!;
    expect(exp).toContain('--remote');
    expect(exp).toContain('--no-schema');
    const tables = exp.flatMap((a, i) => (a === '--table' ? [exp[i + 1]] : []));
    expect(tables).toEqual([...CATALOGUE_TABLES]);
  });

  it('captures the restore point even with no pending migration', async () => {
    const h = harness({ applied: [safe.name] });
    await run(cfg(), h.io);
    expect(h.steps[0]).toBe('bookmark');
    expect(h.steps).not.toContain('migrate remote');
  });

  it('does not deploy a Worker when the catalogue is empty, and says why', async () => {
    const h = harness({ products: 0 });
    await expect(run(cfg(), h.io)).rejects.toThrow(/catalogue is empty/);
    expect(h.steps).toEqual(['bookmark', 'migrate remote']);
    expect(h.steps.filter((s) => s.startsWith('deploy'))).toEqual([]);
  });
});

describe('commit guard', () => {
  it('refuses another branch', async () => {
    await expect(run(cfg({ ref: 'refs/heads/team/x' }), harness().io)).rejects.toThrow(/only refs\/heads\/main/);
  });
  it('refuses a short sha', async () => {
    await expect(run(cfg({ sha: 'abc' }), harness().io)).rejects.toThrow(/40-character/);
  });
  it('skips a push superseded by a newer main, without touching Cloudflare', async () => {
    const h = harness({ tip: TIP });
    await run(cfg(), h.io);
    expect(h.calls).toEqual([]);
    expect(h.summary.join()).toMatch(/moved on/);
  });
  it('a push on the tip proceeds and reports it to the workflow', async () => {
    const h = harness();
    await run(cfg(), h.io);
    expect(h.outputs['proceed']).toBe('true');
  });

  it('tells the workflow to stop when superseded', async () => {
    const h = harness({ tip: TIP });
    await run(cfg(), h.io);
    expect(h.outputs['proceed']).toBe('false');
  });

  it('refuses a hand-started deploy that is no longer the tip', async () => {
    const h = harness({ tip: TIP });
    await expect(run(cfg({ event: 'workflow_dispatch' }), h.io)).rejects.toThrow(/overwrite newer code/);
    expect(h.calls).toEqual([]);
  });

  it('refuses a publish that is no longer the tip, even with older_commit', async () => {
    const h = harness({ tip: TIP });
    await expect(run(cfg({ event: 'workflow_dispatch', mode: 'publish', olderCommit: 'yes' }), h.io)).rejects.toThrow(/publish only runs on main's tip/);
    expect(h.calls).toEqual([]);
  });

  it('older_commit does not help a push', async () => {
    const h = harness({ tip: TIP });
    await run(cfg({ olderCommit: 'yes' }), h.io);
    expect(h.calls).toEqual([]);
  });

  it('with older_commit a hand-started run may deploy an older commit on main', async () => {
    const h = harness({ tip: TIP });
    await run(cfg({ event: 'workflow_dispatch', olderCommit: 'yes' }), h.io);
    expect(h.steps.some((s) => s.startsWith('deploy'))).toBe(true);
    expect(h.summary.join()).toMatch(/older commit/);
  });

  it('refuses an older commit when the database is ahead of it', async () => {
    const h = harness({ tip: TIP, applied: [safe.name, '0099_newer.sql'] });
    await expect(run(cfg({ event: 'workflow_dispatch', olderCommit: 'yes' }), h.io)).rejects.toThrow(/does not know about/);
    expect(h.steps).toEqual([]);
  });

  it('older_commit=with-newer-migrations goes ahead when the database is ahead', async () => {
    const h = harness({ tip: TIP, applied: [safe.name, '0099_newer.sql'] });
    await run(cfg({ event: 'workflow_dispatch', olderCommit: 'with-newer-migrations' }), h.io);
    expect(h.steps.some((s) => s.startsWith('deploy'))).toBe(true);
  });

  it('refuses a hand-started commit that is not on main', async () => {
    const h = harness({ tip: TIP });
    h.io.git = async (args) => (args[0] === 'merge-base' ? { code: 1, stdout: '', stderr: '' } : ok(`${args[1] === 'HEAD' ? SHA : TIP}\n`));
    await expect(run(cfg({ event: 'workflow_dispatch' }), h.io)).rejects.toThrow(/not on main/);
  });
});

describe('destructive migrations', () => {
  it('halts red before any change, printing the sha256', async () => {
    const h = harness({ files: [safe, destructive], applied: [safe.name] });
    await expect(run(cfg(), h.io)).rejects.toThrow(/approve_destructive_migrations=[0-9a-f]{64}/);
    expect(h.steps).toEqual([]);
    expect(h.summary.join()).toMatch(/[0-9a-f]{64}/);
  });

  it('proceeds with the right sha256 on a hand-started run', async () => {
    const h = harness({ files: [safe, destructive], applied: [safe.name] });
    const message = await run(cfg(), h.io).catch((e: Error) => e.message);
    const hash = /=([0-9a-f]{64})/.exec(String(message))![1]!;
    const h2 = harness({ files: [safe, destructive], applied: [safe.name] });
    await run(cfg({ event: 'workflow_dispatch', approval: hash }), h2.io);
    expect(h2.steps).toContain('migrate remote');
  });

  it('ignores an approval value on a push', async () => {
    const h = harness({ files: [safe, destructive], applied: [safe.name] });
    const message = await run(cfg(), h.io).catch((e: Error) => e.message);
    const hash = /=([0-9a-f]{64})/.exec(String(message))![1]!;
    const h2 = harness({ files: [safe, destructive], applied: [safe.name] });
    await expect(run(cfg({ approval: hash }), h2.io)).rejects.toThrow(DeployHalt);
  });

  it('does not halt the first deployment', async () => {
    const h = harness({ files: [destructive], applied: [], tables: [], versions: { 'hb-jobs': null, 'hb-web': null, 'hb-admin': null } });
    await run(cfg(), h.io);
    expect(h.steps).toContain('migrate remote');
  });
});

describe('rollback', () => {
  it('after failed smoke, rolls back every Worker of the run, newest first, to the captured versions', async () => {
    const h = harness({ smoke: ['/ar/ returned 500'] });
    await expect(run(cfg(), h.io)).rejects.toThrow(/smoke/);
    expect(h.steps.filter((s) => s.startsWith('rollback'))).toEqual(['rollback hb-admin', 'rollback hb-web', 'rollback hb-jobs']);
    const r = h.calls.find((c) => c[0] === 'rollback' && c.includes('hb-web'))!;
    expect(r).toEqual(expect.arrayContaining(['old-hb-web', '--name', 'hb-web', '-y']));
  });

  it('when a deploy fails, rolls back that Worker and the ones before it, not the later ones', async () => {
    const h = harness({ failOn: (a) => a[0] === 'deploy' && a.includes('apps/web/wrangler.jsonc') });
    await expect(run(cfg(), h.io)).rejects.toThrow(DeployHalt);
    expect(h.steps.filter((s) => s.startsWith('rollback'))).toEqual(['rollback hb-web', 'rollback hb-jobs']);
    expect(h.steps).not.toContain('deploy apps/admin/wrangler.jsonc');
  });

  it('handles a Worker with no previous version', async () => {
    const h = harness({ smoke: ['down'], versions: { 'hb-jobs': 'old-jobs', 'hb-web': null, 'hb-admin': 'old-admin' } });
    await expect(run(cfg(), h.io)).rejects.toThrow(/smoke/);
    expect(h.steps.filter((s) => s.startsWith('rollback'))).toEqual(['rollback hb-admin', 'rollback hb-jobs']);
    expect(h.summary.join('\n')).toMatch(/hb-web: no previous version/);
  });

  it('nothing to roll back when the build fails', async () => {
    const h = harness();
    h.io.publish = async () => { throw new DeployHalt('build broke'); };
    await expect(run(cfg(), h.io)).rejects.toThrow(/build broke/);
    expect(h.steps.filter((s) => s.startsWith('rollback') || s.startsWith('deploy'))).toEqual([]);
  });

  it('reports a failed rollback', async () => {
    const h = harness({ smoke: ['down'], rollbackFails: true });
    await expect(run(cfg(), h.io)).rejects.toThrow(/rollback incomplete/);
    expect(h.summary.join('\n')).toMatch(/Rollback hb-web: FAILED[\s\S]*old-hb-web/);
  });
});

describe('publish mode', () => {
  it('rebuilds and redeploys hb-web only, without migrations', async () => {
    const h = harness({ applied: [safe.name] });
    await run(cfg({ mode: 'publish', event: 'workflow_dispatch' }), h.io);
    expect(h.steps).toEqual(['export', 'fetch originals', 'migrate local', 'load originals', 'publish', 'deploy apps/web/wrangler.jsonc', 'smoke site']);
  });

  it('refuses when migrations are pending', async () => {
    const h = harness({ applied: [] });
    await expect(run(cfg({ mode: 'publish', event: 'workflow_dispatch' }), h.io)).rejects.toThrow(/pending/);
    expect(h.steps).toEqual([]);
  });

  it('rolls back hb-web only', async () => {
    const h = harness({ applied: [safe.name], smoke: ['down'] });
    await expect(run(cfg({ mode: 'publish', event: 'workflow_dispatch' }), h.io)).rejects.toThrow(/smoke/);
    expect(h.steps.filter((s) => s.startsWith('rollback'))).toEqual(['rollback hb-web']);
  });
});

describe('failing safely', () => {
  it('an unexpected JSON shape is an error, never an empty database', async () => {
    const h = harness({ executeOutput: '{"unexpected":true}', files: [destructive], tables: [] });
    await expect(run(cfg(), h.io)).rejects.toThrow(/unexpected JSON/);
    expect(h.steps).toEqual([]);
  });

  it('a missing results array is an error too', async () => {
    const h = harness({ executeOutput: '[{"success":true}]', files: [destructive] });
    await expect(run(cfg(), h.io)).rejects.toThrow(/unexpected JSON/);
    expect(h.steps).toEqual([]);
  });

  it('non-JSON output is an error', async () => {
    const h = harness({ executeOutput: 'hello', files: [destructive] });
    await expect(run(cfg(), h.io)).rejects.toThrow(/did not return JSON/);
    expect(h.steps).toEqual([]);
  });

  it('keeps the export output out of the log', async () => {
    const h = harness();
    await run(cfg(), h.io);
    expect(h.captures['d1 export']).toBe(true);
  });

  it('stops when the export holds a table outside the allowlist', async () => {
    const h = harness({ exportSql: 'INSERT INTO "products" ("id") VALUES (1);\nINSERT INTO "orders" ("id") VALUES (1);\n' });
    await expect(run(cfg(), h.io)).rejects.toThrow(/outside the catalogue allowlist: orders/);
    expect(h.steps.some((s) => s.startsWith('deploy'))).toBe(false);
  });

  it('a "not found" message does not pass for a first deployment', async () => {
    const h = harness({ statusError: 'Upstream route not found' });
    await expect(run(cfg(), h.io)).rejects.toThrow(/cannot read the current version/);
    expect(h.steps).toEqual([]);
  });

  it('only the exact missing-Worker answer counts as a first deployment', async () => {
    const h = harness({ versions: { 'hb-jobs': null, 'hb-web': null, 'hb-admin': null } });
    await run(cfg(), h.io);
    expect(h.state().before).toEqual({ 'hb-jobs': null, 'hb-web': null, 'hb-admin': null });
  });

  it('fails and rolls back when a deploy leaves the same version active', async () => {
    const h = harness({ sameVersionAfterDeploy: true });
    await expect(run(cfg(), h.io)).rejects.toThrow(/did not produce a new active version/);
    expect(h.steps.filter((s) => s.startsWith('rollback'))).toHaveLength(3);
  });

  it('the rollback step is a no-op when nothing was deployed', async () => {
    const h = harness();
    await rollback(cfg(), h.io);
    expect(h.calls).toEqual([]);
    expect(h.summary.join()).toMatch(/Nothing to roll back/);
  });

  it('a failed rollback fails the rollback step', async () => {
    const h = harness({ rollbackFails: true });
    await h.io.writeState({ before: { 'hb-web': 'old' }, deployed: ['hb-web'] });
    await expect(rollback(cfg(), h.io)).rejects.toThrow(/rollback incomplete/);
  });
});

it('exportedTables reads the tables of an export', () => {
  expect(exportedTables('PRAGMA x;\nINSERT INTO "a" ("id") VALUES (1);\nINSERT INTO "a" ("id") VALUES (2);\nINSERT INTO "b" VALUES (1);\n')).toEqual(['a', 'b']);
});

describe('preflightProblems', () => {
  const configs = () => ({ jobs: goodConfigs['apps/jobs/wrangler.jsonc']!, web: goodConfigs['apps/web/wrangler.jsonc']!, admin: goodConfigs['apps/admin/wrangler.jsonc']! });

  it('accepts real values', () => expect(preflightProblems(configs())).toEqual([]));

  it('lists every problem in the repository as it stands today', () => {
    const problems = preflightProblems({
      jobs: { d1_databases: [{ database_id: '00000000-0000-4000-8000-000000000d1b' }] },
      web: { d1_databases: [{ database_id: '00000000-0000-4000-8000-000000000d1b' }] },
      admin: { d1_databases: [{ database_id: '00000000-0000-4000-8000-000000000d1b' }], workers_dev: false, preview_urls: false, vars: { ACCESS_TEAM_DOMAIN: 'https://placeholder.cloudflareaccess.com', ACCESS_AUD: '[PLACEHOLDER]' } },
    });
    expect(problems.join('\n')).toMatch(/jobs.*database_id/);
    expect(problems.join('\n')).toMatch(/routes has no entry for comptoirdeluxe\.com/);
    expect(problems.join('\n')).toMatch(/SITE_HOSTS/);
    expect(problems.join('\n')).toMatch(/routes has no entry for admin\.comptoirdeluxe\.com/);
    expect(problems.join('\n')).toMatch(/ACCESS_TEAM_DOMAIN/);
    expect(problems.join('\n')).toMatch(/ACCESS_AUD/);
  });

  it('refuses different database ids', () => {
    const c = configs();
    expect(preflightProblems({ ...c, jobs: { d1_databases: [{ database_id: 'other' }] } }).join()).toMatch(/share one/);
  });

  it('refuses an admin reachable outside Access', () => {
    const c = configs();
    expect(preflightProblems({ ...c, admin: { ...c.admin, workers_dev: true } }).join()).toMatch(/workers_dev/);
  });
});
