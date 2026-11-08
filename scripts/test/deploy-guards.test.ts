// Standing rules of the pipeline, checked against the files themselves.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../deploy/config.ts';
import { CATALOGUE_TABLES, PLACEHOLDER_D1_ID, preflightProblems, type WranglerConfig } from '../deploy/orchestrate.ts';

const root = join(import.meta.dirname, '../..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const list = (d: string): string[] => readdirSync(join(root, d)).map((f) => `${d}/${f}`);
const workflows = list('.github/workflows');
const deployScripts = list('scripts/deploy');
const pipeline = read('.github/workflows/pipeline.yml');

describe('the pipeline never runs the local data loader', () => {
  it.each([...workflows, ...deployScripts])('%s does not reference it', (f) => {
    expect(read(f)).not.toMatch(/seed/i);
  });
});

describe('production build rules', () => {
  it.each([...workflows, ...deployScripts])('%s does not set HB_STRICT_COPY', (f) => {
    expect(read(f)).not.toContain('HB_STRICT_COPY');
  });

  it('builds with the production origin and publish mode from the D1 source', () => {
    const deploy = read('scripts/deploy/deploy.ts');
    expect(deploy).toMatch(/HB_PUBLISH: '1'/);
    expect(read('scripts/deploy/orchestrate.ts')).toMatch(/'--source', 'd1'/);
  });

  it('keeps the local D1 id used by publish.ts', () => {
    expect(read('apps/jobs/scripts/publish.ts')).toContain(PLACEHOLDER_D1_ID);
  });
});

describe('workflow security', () => {
  it('has no pull_request_target', () => expect(pipeline).not.toContain('pull_request_target'));

  it('defaults to read-only permissions and never widens them', () => {
    expect(pipeline).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(pipeline.match(/^\s*permissions:/gm)).toHaveLength(1);
  });

  it('pins every action to a full commit sha', () => {
    const uses = [...pipeline.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });

  const deployJob = pipeline.slice(pipeline.indexOf('\n  deploy:'));
  /** The text of the step named `name` in the deploy job. */
  const step = (name: string): string => {
    const start = deployJob.indexOf(`- name: ${name}`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const rest = deployJob.slice(start + 2);
    const next = rest.search(/\n {6}- /);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const usesSecret = (text: string): boolean => /secrets\.[A-Z]/.test(text);

  it('has the Cloudflare secrets only on the steps that talk to Cloudflare', () => {
    const lines = pipeline.split('\n').filter((l) => /secrets\.[A-Z]/.test(l));
    expect(lines).toHaveLength(6);
    for (const l of lines) expect(l).toMatch(/CLOUDFLARE_(API_TOKEN|ACCOUNT_ID): \$\{\{ secrets\./);
    expect(pipeline.search(/secrets\.[A-Z]/)).toBeGreaterThan(pipeline.indexOf('\n  deploy:'));
    expect(deployJob).toContain('environment: production');
    for (const name of ['Export from production', 'Deploy Workers', 'Roll back']) expect(usesSecret(step(name)), name).toBe(true);
    for (const name of ['Check commit and configuration', 'Build site', 'Smoke checks', 'Restore image derivative cache', 'Delete working files']) {
      expect(usesSecret(step(name)), name).toBe(false);
    }
  });

  it('no token-holding process is alive during npm ci or the build', () => {
    const jobEnv = deployJob.slice(deployJob.indexOf('\n    env:'), deployJob.indexOf('\n    steps:'));
    expect(usesSecret(jobEnv)).toBe(false);
    expect(deployJob.indexOf('npm ci')).toBeLessThan(deployJob.indexOf('- name: Export from production'));
    expect(step('Export from production')).toMatch(/deploy\.ts prepare$/);
    expect(step('Build site')).toMatch(/deploy\.ts build$/);
    expect(step('Deploy Workers')).toMatch(/deploy\.ts deploy$/);
    expect(read('scripts/deploy/deploy.ts')).toMatch(/NEEDS_TOKEN = new Set\(\['prepare', 'deploy', 'rollback'\]\)/);
    expect(read('scripts/deploy/deploy.ts')).toContain('must run without the Cloudflare token');
  });

  it('rolls back on failure, cancellation or timeout', () => {
    expect(step('Roll back')).toMatch(/if: \(failure\(\) \|\| cancelled\(\)\)/);
    expect(step('Roll back')).toMatch(/deploy\.ts rollback$/);
  });

  it('never prints the export download URL', () => {
    expect(read('scripts/deploy/orchestrate.ts')).toMatch(/'-c', REMOTE_CONFIG\], true\);\n\s+const allowed/);
  });

  it('deploys only after the checks, one at a time, from main', () => {
    expect(deployJob).toMatch(/needs: \[typecheck, test, build\]/);
    expect(deployJob).toMatch(/if: github\.ref == 'refs\/heads\/main'/);
    expect(deployJob).toMatch(/concurrency:\n\s+group: production-deploy\n\s+cancel-in-progress: false\n\s+queue: max/);
  });

  it('keeps the report job out of the deploy dependencies', () => {
    expect(pipeline).toMatch(/report:[\s\S]*continue-on-error: true/);
    expect(/needs: \[[^\]]*report/.test(pipeline)).toBe(false);
  });

  it('has no workflow-level concurrency that could cancel checks', () => {
    expect(pipeline.match(/^concurrency:/m)).toBeNull();
  });

  it('does not use the local-only machine helpers', () => {
    expect(pipeline).not.toMatch(/gate\.sh|heavy\.sh|hb-locks|\/mnt\/data/);
  });
});

describe('catalogue allowlist', () => {
  const schema = read('packages/db/src/schema.ts');
  const tableOf = (variable: string): string => {
    const m = new RegExp(`export const ${variable} = sqliteTable\\(\\s*'([a-z_0-9]+)'`).exec(schema);
    if (!m) throw new Error(`no table for ${variable}`);
    return m[1]!;
  };

  it('holds exactly the tables the snapshot export reads', () => {
    const froms = [...read('packages/db/src/export.ts').matchAll(/\.from\((\w+)\)/g)].map((m) => tableOf(m[1]!));
    expect([...new Set(froms)].sort()).toEqual([...CATALOGUE_TABLES].sort());
  });

  it('contains no customer, order or admin table', () => {
    const forbidden = /order|customer|admin|audit|rum|publish|notification|fee/;
    for (const t of CATALOGUE_TABLES) expect(t).not.toMatch(forbidden);
  });
});

describe('the committed Worker configs', () => {
  const config = (name: string): WranglerConfig => parseJsonc(name, read(`apps/${name}/wrangler.jsonc`)) as WranglerConfig;

  it('are ready for production', () => {
    expect(preflightProblems({ jobs: config('jobs'), web: config('web'), admin: config('admin') })).toEqual([]);
  });

  it('publish.ts accepts --budget skip', () => {
    expect(read('apps/jobs/scripts/publish.ts')).toMatch(/args\.budget !== 'skip'/);
  });
});

describe('the classifier sees the real migrations directory', () => {
  it('the deploy script reads packages/db/migrations', () => {
    expect(read('scripts/deploy/deploy.ts')).toContain('packages/db/migrations');
  });
});
