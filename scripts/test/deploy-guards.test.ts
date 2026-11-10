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
  const report = read('.github/workflows/report.yml');
  const all = [pipeline, report];
  /** The text of a job in pipeline.yml. */
  const job = (name: string): string => {
    const start = pipeline.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const rest = pipeline.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  };
  /** The text of the step named `name` in that job. */
  const step = (jobText: string, name: string): string => {
    const start = jobText.indexOf(`- name: ${name}`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const rest = jobText.slice(start + 2);
    const next = rest.search(/\n {6}- /);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const usesSecret = (text: string): boolean => /secrets\.[A-Z]/.test(text);
  const exportJob = job('export-catalogue');
  const buildJob = job('build-site');
  const deployJob = job('deploy');

  it('runs on pushes to main only', () => {
    expect(pipeline).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
  });

  it('has no pull_request_target', () => {
    for (const w of all) expect(w).not.toContain('pull_request_target');
  });

  it('defaults to read-only permissions and never widens them', () => {
    for (const w of all) {
      expect(w).toMatch(/^permissions:\n {2}contents: read$/m);
      expect(w.match(/^\s*permissions:/gm)).toHaveLength(1);
    }
  });

  it('pins every action to a full commit sha', () => {
    const uses = all.flatMap((w) => [...w.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });

  it('has the Cloudflare secrets only on the steps that talk to Cloudflare', () => {
    const lines = pipeline.split('\n').filter((l) => /secrets\.[A-Z]/.test(l));
    // SETTINGS_ENCRYPTION_KEY is the one other secret, on the deploy step only (D-017, docs/META-GO-LIVE.md).
    const cloudflare = lines.filter((l) => !l.includes('SETTINGS_ENCRYPTION_KEY'));
    expect(cloudflare).toHaveLength(6);
    expect(lines).toHaveLength(7);
    expect(step(deployJob, 'Deploy Workers')).toContain('secrets.SETTINGS_ENCRYPTION_KEY');
    for (const l of cloudflare) expect(l).toMatch(/CLOUDFLARE_(API_TOKEN|ACCOUNT_ID): \$\{\{ secrets\./);
    expect(usesSecret(step(exportJob, 'Export from production'))).toBe(true);
    expect(usesSecret(step(deployJob, 'Deploy Workers'))).toBe(true);
    expect(usesSecret(step(deployJob, 'Roll back'))).toBe(true);
    for (const name of ['Check commit and configuration', 'Delete working files']) expect(usesSecret(step(exportJob, name)), name).toBe(false);
    for (const name of ['Check and install the built site', 'Smoke checks', 'Delete working files']) expect(usesSecret(step(deployJob, name)), name).toBe(false);
    expect(read('scripts/deploy/deploy.ts')).toMatch(/NEEDS_TOKEN = new Set\(\['prepare', 'deploy', 'rollback'\]\)/);
    expect(read('scripts/deploy/deploy.ts')).toContain('must run without the Cloudflare token');
  });

  it('the build job has no environment and no secret', () => {
    expect(buildJob).not.toContain('environment:');
    expect(usesSecret(buildJob)).toBe(false);
    expect(buildJob).toMatch(/needs: \[export-catalogue\]/);
    expect(step(buildJob, 'Build site')).toMatch(/deploy\.ts build$/);
  });

  it('the jobs holding the token install without scripts and never run the build', () => {
    for (const j of [exportJob, deployJob]) {
      expect(j).toContain('environment: production');
      expect(j).toMatch(/npm ci --ignore-scripts/);
      expect(j).not.toMatch(/deploy\.ts build|publish\.ts|astro/);
      expect(j).toContain('persist-credentials: false');
    }
    expect(buildJob).not.toContain('--ignore-scripts');
  });

  it('the deploy job takes only the built site from the build job, as checked data', () => {
    expect(deployJob).toMatch(/needs: \[export-catalogue, build-site\]/);
    expect(deployJob).toMatch(/name: site\n/);
    expect(deployJob).not.toMatch(/name: catalogue\n/);
    expect(deployJob.indexOf('import-site')).toBeLessThan(deployJob.indexOf('- name: Deploy Workers'));
    expect(deployJob).toMatch(/DEPLOY_BEFORE: \$\{\{ needs\.export-catalogue\.outputs\.before \}\}/);
    expect(deployJob).toMatch(/SMOKE_CATALOGUE: \$\{\{ needs\.export-catalogue\.outputs\.smoke \}\}/);
    expect(deployJob).not.toMatch(/needs\.build-site\.outputs/);
  });

  it('rolls back on failure, cancellation or timeout', () => {
    expect(step(deployJob, 'Roll back')).toMatch(/if: failure\(\) \|\| cancelled\(\)/);
    expect(step(deployJob, 'Roll back')).toMatch(/deploy\.ts rollback$/);
  });

  it('never prints the export download URL', () => {
    expect(read('scripts/deploy/orchestrate.ts')).toMatch(/'-c', REMOTE_CONFIG\], true\);\n\s+const dump/);
  });

  it('deploys only after the checks, from main', () => {
    expect(exportJob).toMatch(/needs: \[typecheck, test, build\]/);
    expect(exportJob).toMatch(/if: github\.ref == 'refs\/heads\/main'/);
    for (const j of [buildJob, deployJob]) expect(j).toMatch(/if: needs\.export-catalogue\.outputs\.proceed == 'true'/);
  });

  it('serialises the whole production run, with a queue, without cancelling anything', () => {
    expect(pipeline).toMatch(/^concurrency:\n {2}group: \$\{\{ github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main' && 'production-deploy' \|\| format\('ci-\{0\}', github\.run_id\) \}\}\n {2}cancel-in-progress: false\n {2}queue: max$/m);
    expect(pipeline.match(/concurrency:/g)).toHaveLength(1);
  });

  it('reports only on pushes to main, in a separate workflow with no secret', () => {
    expect(pipeline).not.toMatch(/^ {2}report:/m);
    expect(pipeline).not.toMatch(/npm run (budget|lh)/);
    expect(report).toMatch(/on:\n {2}push:\n {4}branches: \[main\]/);
    expect(report).not.toContain('pull_request');
    expect(report).not.toContain('workflow_dispatch');
    expect(usesSecret(report)).toBe(false);
    expect(report).not.toContain('environment:');
  });

  it('does not use the local-only machine helpers', () => {
    for (const w of all) expect(w).not.toMatch(/gate\.sh|heavy\.sh|hb-locks|\/mnt\/data/);
  });
});

describe('catalogue allowlist', () => {
  const schema = read('packages/db/src/schema.ts');
  const tableOf = (variable: string): string => {
    const m = new RegExp(`export const ${variable} = sqliteTable\\(\\s*'([a-z_0-9]+)'`).exec(schema);
    if (!m) throw new Error(`no table for ${variable}`);
    return m[1]!;
  };

  it('holds exactly the tables the snapshot export reads, settings going by key', () => {
    expect(CATALOGUE_TABLES).not.toContain('settings');
    const froms = [...read('packages/db/src/export.ts').matchAll(/\.from\((\w+)\)/g)].map((m) => tableOf(m[1]!));
    expect([...new Set(froms)].sort()).toEqual([...CATALOGUE_TABLES, 'settings'].sort());
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
