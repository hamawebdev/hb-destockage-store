// Meta in the production pipeline (META-7; contract §2.1, §2.2, §10; lead condition 2).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeployHalt, deployWorkers, metaDeployArgs, metaProblems, type MetaSettings, type RunConfig, type Io } from '../deploy/orchestrate.ts';

const root = join(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const pipeline = read('.github/workflows/pipeline.yml');
const SHA = 'a'.repeat(40);
const REAL_LOOKING_ID = '123456789012345';
const NONE: MetaSettings = { pixelId: '', token: '', testEventCode: '' };

/** One job's text in pipeline.yml, up to the next job. */
function job(name: string): string {
  const start = pipeline.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = pipeline.slice(start + 1);
  const next = rest.slice(2).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 2);
}

function run(meta: MetaSettings | undefined, mode: 'deploy' | 'publish' = 'deploy') {
  const calls: string[][] = [];
  const steps: string[] = [];
  const summary: string[] = [];
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
    ...(meta === undefined ? {} : { meta }),
  };
  const io = {
    wrangler: async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'deployments') return { code: 0, stdout: JSON.stringify({ versions: [{ version_id: 'new', percentage: 100 }] }), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    writeState: async () => {},
    writeSecret: async (p: string, c: string) => {
      steps.push(`write ${p}`);
      written[p] = c;
    },
    removeFile: async (p: string) => void steps.push(`remove ${p}`),
    log: () => {},
    summary: (l: string) => void summary.push(l),
  } as unknown as Io;
  return { go: () => deployWorkers(cfg, io), calls, steps, summary, written };
}

const deploys = (calls: string[][]) => calls.filter((c) => c[0] === 'deploy');

describe('no Meta values: the pipeline is a no-op', () => {
  it.each([[undefined], [NONE]])('argv is exactly today\'s, nothing written (%j)', async (meta) => {
    const h = run(meta);
    await h.go();
    expect(deploys(h.calls)).toEqual([
      ['deploy', '--cwd', 'apps/jobs', '--no-experimental-provision', '--message', `pipeline ${SHA.slice(0, 12)}`],
      ['deploy', '--cwd', 'apps/web', '--env=', '--no-experimental-provision', '--message', `pipeline ${SHA.slice(0, 12)}`],
      ['deploy', '--cwd', 'apps/admin', '--no-experimental-provision', '--message', `pipeline ${SHA.slice(0, 12)}`],
    ]);
    expect(h.steps).toEqual([]);
  });
  it('a token with no Pixel ID does nothing', () => {
    expect(metaDeployArgs({ pixelId: '', token: 'x', testEventCode: '' }, '/w')).toEqual({ args: [], secretsFile: null });
  });
});

describe('with Meta values', () => {
  const meta: MetaSettings = { pixelId: REAL_LOOKING_ID, token: 'a-real-looking-token', testEventCode: '' };

  it('only hb-web gets the Pixel ID and the secrets file', async () => {
    const h = run(meta);
    await h.go();
    const [jobs, web, admin] = deploys(h.calls);
    expect(jobs!.join(' ')).not.toContain('META');
    expect(admin!.join(' ')).not.toContain('META');
    expect(web).toEqual(expect.arrayContaining(['--var', `META_PIXEL_ID:${REAL_LOOKING_ID}`, '--secrets-file', '/tmp/w/meta-secrets.json']));
  });

  it('the token is never on a command line, and the file is removed', async () => {
    const h = run(meta);
    await h.go();
    expect(JSON.stringify(h.calls)).not.toContain(meta.token);
    expect(JSON.parse(h.written['/tmp/w/meta-secrets.json']!)).toEqual({ META_ACCESS_TOKEN: meta.token });
    expect(h.steps).toEqual(['write /tmp/w/meta-secrets.json', 'remove /tmp/w/meta-secrets.json']);
  });

  it('the secrets file is removed when a deploy fails', async () => {
    const h = run(meta);
    const failing = {
      ...h,
    };
    const io = {
      wrangler: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
      writeState: async () => {},
      writeSecret: async (p: string) => void failing.steps.push(`write ${p}`),
      removeFile: async (p: string) => void failing.steps.push(`remove ${p}`),
      log: () => {},
      summary: () => {},
    } as unknown as Io;
    const cfg = { mode: 'deploy', sha: SHA, event: 'push', ref: 'refs/heads/main', approval: '', olderCommit: 'no', shaExplicit: false, repoRoot: '/r', workDir: '/tmp/w', imageCache: '/c', before: {}, meta } as RunConfig;
    await expect(deployWorkers(cfg, io)).rejects.toThrow(DeployHalt);
    expect(failing.steps).toEqual(['write /tmp/w/meta-secrets.json', 'remove /tmp/w/meta-secrets.json']);
  });

  it('Pixel ID without a token: browser only, no secrets file', () => {
    expect(metaDeployArgs({ pixelId: REAL_LOOKING_ID, token: '', testEventCode: '' }, '/w')).toEqual({ args: ['--var', `META_PIXEL_ID:${REAL_LOOKING_ID}`], secretsFile: null });
  });

  it('META_TEST_EVENT_CODE is passed and warned about loudly', async () => {
    const h = run({ ...meta, testEventCode: 'TEST123' });
    await h.go();
    expect(deploys(h.calls)[1]).toEqual(expect.arrayContaining(['--var', 'META_TEST_EVENT_CODE:TEST123']));
    expect(h.summary.join('\n')).toMatch(/Warning: META_TEST_EVENT_CODE is set/);
  });

  it('refuses a test token, without printing it', async () => {
    const h = run({ ...meta, token: 'FAKE_TEST_TOKEN' });
    await expect(h.go()).rejects.toThrow(/META_ACCESS_TOKEN is a test value/);
    expect(deploys(h.calls)).toEqual([]);
  });
});

describe('check phase', () => {
  it.each([[undefined], [NONE], [{ ...NONE, pixelId: REAL_LOOKING_ID }]])('accepts %j', (m) => {
    expect(metaProblems(m)).toEqual([]);
  });
  it.each(['000000000000000', '0000000000000000', 'abc', '123', '12345678901234567'])('rejects %j, naming only the variable', (pixelId) => {
    const [problem] = metaProblems({ ...NONE, pixelId });
    expect(problem).toMatch(/META_PIXEL_ID/);
    expect(problem).not.toContain(pixelId);
  });
});

describe('the workflow', () => {
  it('passes the settings only to the steps named in the contract', () => {
    expect(job('export-catalogue')).toContain('META_PIXEL_ID: ${{ vars.META_PIXEL_ID }}');
    expect(job('build-site')).toContain('META_CONSENT_REQUIRED: ${{ vars.META_CONSENT_REQUIRED }}');
    expect(job('deploy')).toContain('META_ACCESS_TOKEN: ${{ secrets.META_ACCESS_TOKEN }}');
    expect((pipeline.match(/secrets\.META_ACCESS_TOKEN/g) ?? []).length).toBe(1);
  });
  it('the token and its file never reach an uploaded artifact', () => {
    const deployJob = job('deploy');
    expect(deployJob).not.toContain('upload-artifact');
    expect(job('export-catalogue')).not.toContain('META_ACCESS_TOKEN');
    expect(job('build-site')).not.toContain('META_ACCESS_TOKEN');
    expect(job('build-site')).not.toContain('secrets.');
  });
  it('the Pixel ID is a repository variable: build-site has no environment', () => {
    expect(job('build-site')).not.toMatch(/\n {4}environment:/);
    expect(pipeline).not.toMatch(/secrets\.META_PIXEL_ID/);
  });
});

describe('no fake value in production configuration', () => {
  it.each(['apps/web/wrangler.jsonc', '.github/workflows/pipeline.yml', 'scripts/deploy/deploy.ts'])('%s', (f) => {
    const text = read(f);
    expect(text).not.toContain('000000000000000');
    expect(text).not.toContain('FAKE_TEST_TOKEN');
  });
});
