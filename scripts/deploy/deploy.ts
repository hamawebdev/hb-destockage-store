// Entry point of the deploy job (.github/workflows/pipeline.yml). Docs: docs/DEPLOY.md.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { getPlatformProxy } from 'wrangler';
import { ADMIN_ORIGIN, DeployHalt, run, SITE_ORIGIN, type CommandResult, type Io, type PublishedSnapshot, type RunConfig, type WranglerConfig } from './orchestrate.ts';
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

/** Environment for the build: it never needs, so never gets, the Cloudflare credentials. */
function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HB_SITE_ORIGIN: SITE_ORIGIN, HB_PUBLISH: '1' };
  delete env['CLOUDFLARE_API_TOKEN'];
  delete env['CLOUDFLARE_ACCOUNT_ID'];
  return env;
}

async function pool<T>(items: readonly T[], size: number, f: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await f(items[next++]!);
    }),
  );
}

const summaryFile = process.env['GITHUB_STEP_SUMMARY'];

const io: Io = {
  wrangler: (args, opts) => exec(WRANGLER, args, opts),
  git: (args) => exec('git', args, { capture: true }),
  async migrationFiles() {
    const dir = join(REPO, 'packages/db/migrations');
    const names = (await readdir(dir)).filter((n) => n.endsWith('.sql'));
    return Promise.all(names.map(async (name) => ({ name, content: await readFile(join(dir, name), 'utf8') })));
  },
  async readConfig(path) {
    const { config, error } = ts.parseConfigFileTextToJson(path, await readFile(join(REPO, path), 'utf8'));
    if (error) throw new DeployHalt(`cannot parse ${path}`);
    return config as WranglerConfig;
  },
  writeFile: (path, content) => writeFile(path, content),
  async loadOriginals(keys, persistDir, configFile) {
    const dir = await mkdtemp(join(tmpdir(), 'hb-originals-'));
    const proxy = await getPlatformProxy<{ MEDIA: { put(key: string, value: Uint8Array): Promise<unknown> } }>({ configPath: configFile, persist: { path: join(persistDir, 'v3') } });
    try {
      let n = 0;
      await pool(keys, ORIGINALS_CONCURRENCY, async (key) => {
        const file = join(dir, `object-${n++}`);
        const r = await exec(WRANGLER, ['r2', 'object', 'get', `hb-media/${key}`, '--remote', '--file', file], { capture: true });
        if (r.code !== 0) throw new DeployHalt(`could not fetch image original ${key} from R2 hb-media: ${r.stderr.trim().slice(0, 300)}`);
        await proxy.env.MEDIA.put(key, await readFile(file));
        await rm(file);
      });
    } finally {
      await proxy.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  async publish(args) {
    const r = await exec(process.execPath, ['apps/jobs/scripts/publish.ts', ...args], { env: buildEnv() });
    if (r.code !== 0) throw new DeployHalt(`publish build failed (exit ${r.code})`);
    const root = join(REPO, '.wrangler/publish');
    const runs = (await readdir(root)).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => b - a);
    if (runs.length === 0) throw new DeployHalt('publish produced no run directory');
    const file = join(root, String(runs[0]), 'snapshot.json');
    if (!existsSync(file)) throw new DeployHalt(`publish wrote no snapshot at ${file}`);
    return JSON.parse(await readFile(file, 'utf8')) as PublishedSnapshot;
  },
  smoke: (snapshot, scope) =>
    runSmoke({ siteOrigin: SITE_ORIGIN, adminOrigin: ADMIN_ORIGIN }, snapshot, (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }), scope, {
      attempts: 18,
      delayMs: 10_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (l) => console.log(l),
    }),
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

const workDir = await mkdtemp(join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'hb-deploy-'));
try {
  required('CLOUDFLARE_API_TOKEN');
  required('CLOUDFLARE_ACCOUNT_ID');
  const mode = required('DEPLOY_MODE');
  if (mode !== 'deploy' && mode !== 'publish') throw new DeployHalt(`unknown mode ${mode}`);
  const imageCache = (process.env['HB_IMAGE_CACHE'] ?? join(homedir(), '.cache/hb-image-derivatives')).replace(/^~(?=\/)/, homedir());
  await mkdir(imageCache, { recursive: true });
  const cfg: RunConfig = {
    mode,
    sha: required('DEPLOY_SHA'),
    event: required('DEPLOY_EVENT'),
    ref: required('DEPLOY_REF'),
    approval: process.env['APPROVE_DESTRUCTIVE_MIGRATIONS'] ?? '',
    repoRoot: REPO,
    workDir,
    imageCache,
  };
  await run(cfg, io);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`::error::${message.replace(/\n/g, ' | ')}`);
  if (summaryFile) appendFileSync(summaryFile, `\n**Failed:** ${message}\n`);
  process.exitCode = 1;
} finally {
  await rm(workDir, { recursive: true, force: true });
}
