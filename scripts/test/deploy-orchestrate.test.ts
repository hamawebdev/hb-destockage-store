import { describe, expect, it } from 'vitest';
import type { MigrationFile } from '../deploy/migrations.ts';
import { CATALOGUE_TABLES, DeployHalt, preflightProblems, run, type CommandResult, type Io, type PublishedSnapshot, type RunConfig, type WranglerConfig } from '../deploy/orchestrate.ts';

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
}

const safe: MigrationFile = { name: '0010_add.sql', content: 'ALTER TABLE t ADD c text;' };
const destructive: MigrationFile = { name: '0011_drop.sql', content: 'DROP TABLE t;' };
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

function harness(opts: Options = {}) {
  const calls: string[][] = [];
  const steps: string[] = [];
  const summary: string[] = [];
  const logs: string[] = [];
  const io: Io = {
    async wrangler(args) {
      calls.push([...args]);
      if (opts.failOn?.(args)) return { code: 1, stdout: '', stderr: 'boom' };
      const line = args.join(' ');
      if (args[0] === 'deployments') {
        const name = args[args.indexOf('--name') + 1]!;
        const v = opts.versions === undefined ? `old-${name}` : opts.versions[name];
        const deployed = calls.some((c) => c[0] === 'deploy' && c.includes(`apps/${name.replace('hb-', '')}/wrangler.jsonc`));
        if (deployed) return ok(JSON.stringify({ versions: [{ version_id: `new-${name}`, percentage: 100 }] }));
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
    loadOriginals: async () => void steps.push('originals'),
    publish: async () => {
      steps.push('publish');
      return { products: [], settings: { turnstileSiteKey: 'k' } } satisfies PublishedSnapshot;
    },
    smoke: async (_s, scope) => {
      steps.push(`smoke ${scope}`);
      return opts.smoke ?? [];
    },
    log: (l) => logs.push(l),
    summary: (l) => summary.push(l),
  };
  return { io, calls, steps, summary, logs };
}

const cfg = (over: Partial<RunConfig> = {}): RunConfig => ({
  mode: 'deploy', sha: SHA, event: 'push', ref: 'refs/heads/main', approval: '', repoRoot: '/repo', workDir: '/tmp/w', imageCache: '/tmp/c', ...over,
});

describe('deploy order', () => {
  it('restore point, migrations, catalogue, jobs, web, admin, smoke', async () => {
    const h = harness();
    await run(cfg(), h.io);
    expect(h.steps).toEqual([
      'bookmark', 'migrate remote', 'export', 'migrate local', 'originals', 'publish',
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
  it('a hand-started run may deploy an older commit on main', async () => {
    const h = harness({ tip: TIP });
    await run(cfg({ event: 'workflow_dispatch' }), h.io);
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
    await expect(run(cfg(), h.io)).rejects.toThrow(/smoke/);
    expect(h.summary.join('\n')).toMatch(/Rollback hb-web: FAILED[\s\S]*old-hb-web/);
  });
});

describe('publish mode', () => {
  it('rebuilds and redeploys hb-web only, without migrations', async () => {
    const h = harness({ applied: [safe.name] });
    await run(cfg({ mode: 'publish', event: 'workflow_dispatch' }), h.io);
    expect(h.steps).toEqual(['export', 'migrate local', 'originals', 'publish', 'deploy apps/web/wrangler.jsonc', 'smoke site']);
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
