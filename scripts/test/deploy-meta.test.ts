// Meta in the production pipeline after MSET-5 (D-017): the pipeline passes no Meta value at all.
// The Pixel ID, token, test code and consent live in the admin (D1). The only thing the pipeline
// handles is SETTINGS_ENCRYPTION_KEY, uploaded to hb-web and hb-admin with --secrets-file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeployHalt, deployWorkers, settingsKeyDeployArgs, settingsKeyProblems, settingsSql, SETTINGS_KEY_WORKERS, type RunConfig, type Io } from '../deploy/orchestrate.ts';

const root = join(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const pipeline = read('.github/workflows/pipeline.yml');
const SHA = 'a'.repeat(40);
/** A well-formed key for these tests only (32 bytes of 0x07). Never a real value. */
const KEY = Buffer.alloc(32, 7).toString('base64');
const OLD_VARS = /META_(PIXEL_ID|ACCESS_TOKEN|TEST_EVENT_CODE|CONSENT_REQUIRED|GRAPH_BASE)/;

/** One job's text in pipeline.yml, up to the next job. */
function job(name: string): string {
  const start = pipeline.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = pipeline.slice(start + 1);
  const next = rest.slice(2).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 2);
}

function run(settingsKey: string | undefined, mode: 'deploy' | 'publish' = 'deploy', failDeploy = false) {
  const calls: string[][] = [];
  const steps: string[] = [];
  const summary: string[] = [];
  const logs: string[] = [];
  const written: Record<string, string> = {};
  const cfg: RunConfig = {
    mode,
    sha: SHA,
    event: 'push',
    ref: 'refs/heads/main',
    approval: '',
    olderCommit: 'no',
    shaExplicit: false,
    repoRoot: '/repo',
    workDir: '/tmp/w',
    imageCache: '/tmp/c',
    before: { 'hb-jobs': 'old', 'hb-web': 'old', 'hb-admin': 'old' },
    ...(settingsKey === undefined ? {} : { settingsKey }),
  };
  const io = {
    wrangler: async (args: readonly string[]) => {
      calls.push([...args]);
      if (failDeploy && args[0] === 'deploy') return { code: 1, stdout: '', stderr: 'boom' };
      if (args[0] === 'deployments') return { code: 0, stdout: JSON.stringify({ versions: [{ version_id: 'new', percentage: 100 }] }), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    writeState: async () => {},
    writeSecret: async (p: string, c: string) => {
      steps.push(`write ${p}`);
      written[p] = c;
    },
    removeFile: async (p: string) => void steps.push(`remove ${p}`),
    log: (l: string) => void logs.push(l),
    summary: (l: string) => void summary.push(l),
  } as unknown as Io;
  return { go: () => deployWorkers(cfg, io), calls, steps, summary, logs, written };
}

const deploys = (calls: string[][]) => calls.filter((c) => c[0] === 'deploy');
const BASE = [
  ['deploy', '--cwd', 'apps/jobs', '--no-experimental-provision', '--message', `pipeline ${SHA.slice(0, 12)}`],
  ['deploy', '--cwd', 'apps/web', '--env=', '--no-experimental-provision', '--message', `pipeline ${SHA.slice(0, 12)}`],
  ['deploy', '--cwd', 'apps/admin', '--no-experimental-provision', '--message', `pipeline ${SHA.slice(0, 12)}`],
];

describe('no key: the deploy is exactly the pre-Meta deploy', () => {
  it.each([[undefined], [''], ['   ']])('argv unchanged, nothing written (%j)', async (key) => {
    const h = run(key);
    await h.go();
    expect(deploys(h.calls)).toEqual(BASE);
    expect(h.steps).toEqual([]);
    expect(h.summary.join('\n')).toContain('SETTINGS_ENCRYPTION_KEY not provided');
  });
});

describe('with SETTINGS_ENCRYPTION_KEY', () => {
  it('hb-web and hb-admin get the secrets file, hb-jobs does not', async () => {
    expect(SETTINGS_KEY_WORKERS).toEqual(['hb-web', 'hb-admin']);
    const h = run(KEY);
    await h.go();
    const [jobs, web, admin] = deploys(h.calls);
    expect(jobs).toEqual(BASE[0]);
    expect(web).toEqual([...BASE[1]!.slice(0, 4), '--secrets-file', '/tmp/w/settings-secrets.json', ...BASE[1]!.slice(4)]);
    expect(admin).toEqual([...BASE[2]!.slice(0, 3), '--secrets-file', '/tmp/w/settings-secrets.json', ...BASE[2]!.slice(3)]);
  });

  it('publish mode deploys hb-web only, with the key', async () => {
    const h = run(KEY, 'publish');
    await h.go();
    expect(deploys(h.calls)).toEqual([[...BASE[1]!.slice(0, 4), '--secrets-file', '/tmp/w/settings-secrets.json', ...BASE[1]!.slice(4)]]);
  });

  it('the key is never on a command line, in a log or in the summary, and its file is removed', async () => {
    const h = run(KEY);
    await h.go();
    expect(JSON.parse(h.written['/tmp/w/settings-secrets.json']!)).toEqual({ SETTINGS_ENCRYPTION_KEY: KEY });
    const visible = JSON.stringify([h.calls, h.logs, h.summary]);
    expect(visible).not.toContain(KEY);
    expect(h.steps).toEqual(['write /tmp/w/settings-secrets.json', 'remove /tmp/w/settings-secrets.json']);
  });

  it('the secrets file is removed when a deploy fails', async () => {
    const h = run(KEY, 'deploy', true);
    await expect(h.go()).rejects.toThrow(DeployHalt);
    expect(h.steps).toEqual(['write /tmp/w/settings-secrets.json', 'remove /tmp/w/settings-secrets.json']);
  });

  it.each(['short', Buffer.alloc(16, 1).toString('base64'), Buffer.alloc(33, 1).toString('base64'), 'not base64!!'])('a malformed key (%j) halts before any deploy, naming only the variable', async (bad) => {
    const [problem] = settingsKeyProblems(bad);
    expect(problem).toMatch(/SETTINGS_ENCRYPTION_KEY/);
    expect(problem).not.toContain(bad);
    const h = run(bad);
    await expect(h.go()).rejects.toThrow(/SETTINGS_ENCRYPTION_KEY/);
    expect(deploys(h.calls)).toEqual([]);
    expect(h.steps).toEqual([]);
  });

  it('settingsKeyDeployArgs', () => {
    expect(settingsKeyDeployArgs(undefined, '/w')).toEqual({ args: [], secretsFile: null });
    expect(settingsKeyDeployArgs(KEY, '/w')).toEqual({ args: ['--secrets-file', '/w/settings-secrets.json'], secretsFile: '/w/settings-secrets.json' });
  });
});

describe('the production export never carries the Meta token or test code', () => {
  it.each(['metaAccessTokenEnc', 'metaAccessToken', 'metaTestEventCode'])('%s is refused even if it reached the query', (key) => {
    expect(() => settingsSql([{ key, value: '"x"', updated_at: 1 }])).toThrow(DeployHalt);
  });
});

describe('the workflow passes no Meta value', () => {
  it('no META_* variable or secret anywhere in pipeline.yml', () => {
    expect(pipeline).not.toMatch(OLD_VARS);
    expect(pipeline).not.toMatch(/vars\.META_|secrets\.META_/);
  });
  it('SETTINGS_ENCRYPTION_KEY only on "Deploy Workers", never in export or build', () => {
    expect((pipeline.match(/secrets\.SETTINGS_ENCRYPTION_KEY/g) ?? []).length).toBe(1);
    expect(job('deploy')).toContain('SETTINGS_ENCRYPTION_KEY: ${{ secrets.SETTINGS_ENCRYPTION_KEY }}');
    expect(job('export-catalogue')).not.toContain('SETTINGS_ENCRYPTION_KEY');
    expect(job('build-site')).not.toContain('SETTINGS_ENCRYPTION_KEY');
    expect(job('deploy')).not.toContain('upload-artifact');
  });
  it.each(['scripts/deploy/orchestrate.ts', 'scripts/deploy/deploy.ts', 'scripts/deploy/config.ts', 'scripts/deploy/smoke.ts', 'scripts/deploy/migrations.ts', 'apps/web/wrangler.jsonc', 'apps/admin/wrangler.jsonc'])('%s names no old Meta variable', (f) => {
    expect(read(f)).not.toMatch(OLD_VARS);
  });
});

describe('no fake value in production configuration', () => {
  it.each(['apps/web/wrangler.jsonc', 'apps/admin/wrangler.jsonc', '.github/workflows/pipeline.yml', 'scripts/deploy/deploy.ts'])('%s', (f) => {
    const text = read(f);
    for (const fake of ['000000000000000', '100000000000001', 'FAKE_TEST_TOKEN', KEY]) expect(text).not.toContain(fake);
  });
});
