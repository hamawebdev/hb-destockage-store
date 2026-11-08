// Entry point of the deploy job's steps (.github/workflows/pipeline.yml). Docs: docs/DEPLOY.md.
//   node scripts/deploy/deploy.ts <check|prepare|build|deploy|smoke|rollback>
// prepare, deploy and rollback hold the Cloudflare token; check, build and smoke never have it.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { parseJsonc } from './config.ts';
import {
  ADMIN_ORIGIN,
  build,
  check,
  DeployHalt,
  deployWorkers,
  prepare,
  rollback,
  SITE_ORIGIN,
  smoke,
  type CommandResult,
  type DeployState,
  type Io,
  type OlderCommit,
  type PublishedSnapshot,
  type RunConfig,
  type WranglerConfig,
} from './orchestrate.ts';
import { runSmoke } from './smoke.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WRANGLER = join(REPO, 'node_modules/.bin/wrangler');
const ORIGINALS_CONCURRENCY = 4;

function exec(cmd: string, args: readonly string[], opts: { capture?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
  return new Promise((done, reject) => {
    const child = spawn(cmd, args, { cwd: REPO, env: opts.env ?? process.env, stdio: ['ignore', opts.capture ? 'pipe' : 'inherit', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
      if (!opts.capture) process.stderr.write(b);
    });
    child.on('error', reject);
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

async function pool<T>(items: readonly T[], size: number, f: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await f(items[i]!, i);
      }
    }),
  );
}

const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
const outputFile = process.env['GITHUB_OUTPUT'];
const workDir = join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'hb-deploy');
const stateFile = join(workDir, 'state.json');

const io: Io = {
  wrangler: (args, opts) => exec(WRANGLER, args, opts),
  git: (args) => exec('git', args, { capture: true }),
  async migrationFiles() {
    const dir = join(REPO, 'packages/db/migrations');
    const names = (await readdir(dir)).filter((n) => n.endsWith('.sql'));
    return Promise.all(names.map(async (name) => ({ name, content: await readFile(join(dir, name), 'utf8') })));
  },
  async readConfig(path) {
    return parseJsonc(path, await readFile(join(REPO, path), 'utf8')) as WranglerConfig;
  },
  writeFile: (path, content) => writeFile(path, content),
  readFile: (path) => readFile(path, 'utf8'),
  readState: async () => (existsSync(stateFile) ? (JSON.parse(await readFile(stateFile, 'utf8')) as DeployState) : {}),
  writeState: (state) => writeFile(stateFile, JSON.stringify(state)),
  async fetchOriginals(keys, dir) {
    await mkdir(dir, { recursive: true });
    await pool(keys, ORIGINALS_CONCURRENCY, async (key, i) => {
      const r = await exec(WRANGLER, ['r2', 'object', 'get', `hb-media/${key}`, '--remote', '--file', join(dir, String(i))], { capture: true });
      if (r.code !== 0) throw new DeployHalt(`could not fetch image original ${key} from R2 hb-media: ${r.stderr.trim().slice(0, 300)}`);
    });
  },
  async loadOriginals(keys, dir, persistDir, configFile) {
    const proxy = await getPlatformProxy<{ MEDIA: { put(key: string, value: Uint8Array): Promise<unknown> } }>({ configPath: configFile, persist: { path: join(persistDir, 'v3') } });
    try {
      for (const [i, key] of keys.entries()) await proxy.env.MEDIA.put(key, await readFile(join(dir, String(i))));
    } finally {
      await proxy.dispose();
    }
  },
  async publish(args) {
    const r = await exec(process.execPath, ['apps/jobs/scripts/publish.ts', ...args], { env: { ...process.env, HB_SITE_ORIGIN: SITE_ORIGIN, HB_PUBLISH: '1' } });
    if (r.code !== 0) throw new DeployHalt(`publish build failed (exit ${r.code})`);
    const root = join(REPO, '.wrangler/publish');
    const runs = (await readdir(root)).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => b - a);
    if (runs.length === 0) throw new DeployHalt('publish produced no run directory');
    const file = join(root, String(runs[0]), 'snapshot.json');
    if (!existsSync(file)) throw new DeployHalt(`publish wrote no snapshot at ${file}`);
    return file;
  },
  readSnapshot: async (path) => JSON.parse(await readFile(path, 'utf8')) as PublishedSnapshot,
  smoke: (snapshot, scope) =>
    runSmoke({ siteOrigin: SITE_ORIGIN, adminOrigin: ADMIN_ORIGIN }, snapshot, (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }), scope, {
      attempts: 18,
      delayMs: 10_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (l) => console.log(l),
    }),
  setOutput(name, value) {
    if (outputFile) appendFileSync(outputFile, `${name}=${value}\n`);
  },
  log: (line) => console.log(line),
  summary(line) {
    console.log(line);
    if (summaryFile) appendFileSync(summaryFile, `${line}\n`);
  },
};

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new DeployHalt(`${name} is not set`);
  return v;
};

const PHASES = { check, prepare, build, deploy: deployWorkers, smoke, rollback } as const;
const NEEDS_TOKEN = new Set(['prepare', 'deploy', 'rollback']);
const OLDER_COMMIT: readonly OlderCommit[] = ['no', 'yes', 'with-newer-migrations'];

try {
  const phase = process.argv[2] ?? '';
  if (!Object.hasOwn(PHASES, phase)) throw new DeployHalt(`usage: deploy.ts <${Object.keys(PHASES).join('|')}>`);
  if (NEEDS_TOKEN.has(phase)) {
    required('CLOUDFLARE_API_TOKEN');
    required('CLOUDFLARE_ACCOUNT_ID');
  } else if (process.env['CLOUDFLARE_API_TOKEN']) {
    throw new DeployHalt(`the ${phase} step must run without the Cloudflare token`);
  }
  const mode = required('DEPLOY_MODE');
  if (mode !== 'deploy' && mode !== 'publish') throw new DeployHalt(`unknown mode ${mode}`);
  const olderCommit = (process.env['OLDER_COMMIT'] || 'no') as OlderCommit;
  if (!OLDER_COMMIT.includes(olderCommit)) throw new DeployHalt(`unknown older_commit ${olderCommit}`);
  const imageCache = (process.env['HB_IMAGE_CACHE'] ?? join(homedir(), '.cache/hb-image-derivatives')).replace(/^~(?=\/)/, homedir());
  await mkdir(workDir, { recursive: true });
  await mkdir(imageCache, { recursive: true });
  const cfg: RunConfig = {
    mode,
    sha: required('DEPLOY_SHA'),
    event: required('DEPLOY_EVENT'),
    ref: required('DEPLOY_REF'),
    approval: process.env['APPROVE_DESTRUCTIVE_MIGRATIONS'] ?? '',
    olderCommit,
    repoRoot: REPO,
    workDir,
    imageCache,
  };
  await PHASES[phase as keyof typeof PHASES](cfg, io);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`::error::${message.replace(/\n/g, ' | ')}`);
  if (summaryFile) appendFileSync(summaryFile, `\n**Failed:** ${message}\n`);
  process.exitCode = 1;
}
