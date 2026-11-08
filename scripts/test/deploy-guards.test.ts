// Standing rules of the pipeline, checked against the files themselves.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOGUE_TABLES, PLACEHOLDER_D1_ID } from '../deploy/orchestrate.ts';

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

  it('reads the Cloudflare secrets in the deploy step only', () => {
    const lines = pipeline.split('\n').filter((l) => /secrets\.[A-Z]/.test(l));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatch(/CLOUDFLARE_(API_TOKEN|ACCOUNT_ID): \$\{\{ secrets\./);
    const deployJob = pipeline.slice(pipeline.indexOf('\n  deploy:'));
    expect(deployJob).toContain('environment: production');
    expect(deployJob.search(/secrets\.[A-Z]/)).toBeGreaterThan(deployJob.indexOf('name: Deploy'));
    expect(pipeline.search(/secrets\.[A-Z]/)).toBeGreaterThan(pipeline.indexOf('\n  deploy:'));
  });

  it('deploys only after the checks, one at a time, from main', () => {
    const deployJob = pipeline.slice(pipeline.indexOf('\n  deploy:'));
    expect(deployJob).toMatch(/needs: \[typecheck, test, build\]/);
    expect(deployJob).toMatch(/if: github\.ref == 'refs\/heads\/main'/);
    expect(deployJob).toMatch(/concurrency:\n\s+group: production-deploy\n\s+cancel-in-progress: false/);
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

describe('the classifier sees the real migrations directory', () => {
  it('the deploy script reads packages/db/migrations', () => {
    expect(read('scripts/deploy/deploy.ts')).toContain('packages/db/migrations');
  });
});
