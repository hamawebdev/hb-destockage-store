// The production deployment, as one sequence (docs/DEPLOY.md). All I/O goes through `Io`, so the
// order of operations, the migration halt and the rollback are tested without Cloudflare.
import { dirname, join, relative, resolve } from 'node:path';
import { MigrationOrderError, planMigrations, type MigrationFile, type MigrationPlan } from './migrations.ts';
import type { SmokeSnapshot } from './smoke.ts';

export const DB_NAME = 'hb-destockage';
export const SITE_ORIGIN = 'https://comptoirdeluxe.com';
export const ADMIN_ORIGIN = 'https://admin.comptoirdeluxe.com';
export const PLACEHOLDER_D1_ID = '00000000-0000-4000-8000-000000000d1b';

/** Read by @hb/db exportCatalogSnapshot. Only these tables ever leave production D1. */
export const CATALOGUE_TABLES = [
  'categories',
  'products',
  'product_options',
  'option_values',
  'variants',
  'variant_option_values',
  'pack_items',
  'images',
  'content_pages',
  'settings',
  'wilayas',
] as const;

export interface Worker {
  readonly name: string;
  readonly config: string;
  readonly deployArgs: readonly string[];
}

const JOBS: Worker = { name: 'hb-jobs', config: 'apps/jobs/wrangler.jsonc', deployArgs: [] };
const WEB: Worker = { name: 'hb-web', config: 'apps/web/wrangler.jsonc', deployArgs: ['--env='] };
const ADMIN: Worker = { name: 'hb-admin', config: 'apps/admin/wrangler.jsonc', deployArgs: [] };
/** Deployment order: the queue consumer, then the producer, then the admin. */
export const DEPLOY_ORDER: readonly Worker[] = [JOBS, WEB, ADMIN];

// Wrangler config for D1 commands against production (it carries the binding and migrations dir).
const REMOTE_CONFIG = JOBS.config;

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunConfig {
  readonly mode: 'deploy' | 'publish';
  readonly sha: string;
  readonly event: string; // push | workflow_dispatch
  readonly ref: string;
  readonly approval: string;
  readonly repoRoot: string;
  readonly workDir: string; // private temporary directory
  readonly imageCache: string;
}

export interface Io {
  /** Runs wrangler from the repository root. `capture` keeps stdout for parsing instead of streaming it. */
  wrangler(args: readonly string[], opts?: { capture?: boolean }): Promise<CommandResult>;
  git(args: readonly string[]): Promise<CommandResult>;
  migrationFiles(): Promise<MigrationFile[]>;
  readConfig(path: string): Promise<WranglerConfig>;
  writeFile(path: string, content: string): Promise<void>;
  /** Copies R2 hb-media objects into the local bucket under persistDir. */
  loadOriginals(keys: readonly string[], persistDir: string, configFile: string): Promise<void>;
  /** Runs the publish build without Cloudflare credentials; returns the snapshot it wrote. */
  publish(args: readonly string[]): Promise<PublishedSnapshot>;
  smoke(snapshot: PublishedSnapshot, scope: 'all' | 'site'): Promise<string[]>;
  log(line: string): void;
  summary(line: string): void;
}

export interface PublishedSnapshot extends SmokeSnapshot {
  readonly settings?: { readonly turnstileSiteKey?: string | null };
}

export interface WranglerConfig {
  readonly name?: string;
  readonly workers_dev?: boolean;
  readonly preview_urls?: boolean;
  readonly vars?: Record<string, unknown>;
  readonly routes?: readonly (string | { pattern?: string; custom_domain?: boolean })[];
  readonly d1_databases?: readonly { database_id?: string }[];
}

export class DeployHalt extends Error {
  override readonly name = 'DeployHalt';
}

const fail = (message: string): never => {
  throw new DeployHalt(message);
};

async function wr(io: Io, args: readonly string[], capture = false): Promise<CommandResult> {
  const r = await io.wrangler(args, { capture });
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().split('\n').slice(-4).join(' ');
    throw new DeployHalt(`wrangler ${args.slice(0, 3).join(' ')} failed (exit ${r.code}): ${detail}`);
  }
  return r;
}

async function queryD1(io: Io, config: string, target: readonly string[], sql: string): Promise<Record<string, unknown>[]> {
  const r = await wr(io, ['d1', 'execute', DB_NAME, ...target, '--json', '-y', '-c', config, '--command', sql], true);
  const parsed = JSON.parse(r.stdout) as { results?: Record<string, unknown>[] }[];
  return parsed[0]?.results ?? [];
}

/** Everything the pipeline needs from a Worker config; every problem at once, before any change. */
export function preflightProblems(configs: { jobs: WranglerConfig; web: WranglerConfig; admin: WranglerConfig }): string[] {
  const problems: string[] = [];
  const hasRoute = (c: WranglerConfig, host: string): boolean =>
    (c.routes ?? []).some((r) => (typeof r === 'string' ? r : (r.pattern ?? '')).replace(/\/\*$/, '') === host);
  const siteHost = new URL(SITE_ORIGIN).hostname;
  const adminHost = new URL(ADMIN_ORIGIN).hostname;

  const ids = new Set<string>();
  for (const [label, c] of Object.entries(configs)) {
    const id = c.d1_databases?.[0]?.database_id;
    if (!id || id === PLACEHOLDER_D1_ID) problems.push(`apps/${label}/wrangler.jsonc: d1_databases[0].database_id is not the production id`);
    else ids.add(id);
  }
  if (ids.size > 1) problems.push('the three Worker configs do not share one production D1 database_id');

  if (!hasRoute(configs.web, siteHost)) problems.push(`apps/web/wrangler.jsonc: routes has no entry for ${siteHost}`);
  const hosts = String(configs.web.vars?.['SITE_HOSTS'] ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  if (!hosts.includes(siteHost)) problems.push(`apps/web/wrangler.jsonc: vars.SITE_HOSTS must list ${siteHost}`);
  if (hosts.some((h) => h === 'localhost' || h === '127.0.0.1')) problems.push('apps/web/wrangler.jsonc: vars.SITE_HOSTS must not contain a local hostname');

  if (!hasRoute(configs.admin, adminHost)) problems.push(`apps/admin/wrangler.jsonc: routes has no entry for ${adminHost}`);
  if (configs.admin.workers_dev !== false) problems.push('apps/admin/wrangler.jsonc: workers_dev must be false (Access protects only the custom domain)');
  if (configs.admin.preview_urls !== false) problems.push('apps/admin/wrangler.jsonc: preview_urls must be false (Access protects only the custom domain)');
  const team = String(configs.admin.vars?.['ACCESS_TEAM_DOMAIN'] ?? '');
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || team.includes('placeholder')) {
    problems.push('apps/admin/wrangler.jsonc: vars.ACCESS_TEAM_DOMAIN is not the real https://<team>.cloudflareaccess.com');
  }
  if (!/^[0-9a-f]{64}$/.test(String(configs.admin.vars?.['ACCESS_AUD'] ?? ''))) {
    problems.push('apps/admin/wrangler.jsonc: vars.ACCESS_AUD is not a 64-hex Application Audience tag');
  }
  return problems;
}

/** Returns false when this push has been superseded by a newer commit on main. */
export async function verifyCommit(cfg: RunConfig, io: Io): Promise<boolean> {
  if (cfg.ref !== 'refs/heads/main') fail(`refusing to deploy from ${cfg.ref}: only refs/heads/main deploys`);
  if (!/^[0-9a-f]{40}$/.test(cfg.sha)) fail('the commit must be a full 40-character SHA');
  const head = (await io.git(['rev-parse', 'HEAD'])).stdout.trim();
  if (head !== cfg.sha) fail(`checked out ${head}, expected ${cfg.sha}`);
  const main = await io.git(['rev-parse', 'origin/main']);
  if (main.code !== 0) fail('origin/main is not available in this checkout');
  const tip = main.stdout.trim();
  const onMain = await io.git(['merge-base', '--is-ancestor', cfg.sha, tip]);
  if (onMain.code !== 0) fail(`commit ${cfg.sha} is not on main`);
  if (cfg.event === 'push' && tip !== cfg.sha) {
    io.log(`main has moved to ${tip}: this push is superseded, nothing deployed`);
    io.summary(`Skipped: main has moved on to \`${tip}\`; this commit was not deployed.`);
    return false;
  }
  return true;
}

async function currentVersion(io: Io, w: Worker): Promise<string | null> {
  const r = await io.wrangler(['deployments', 'status', '--name', w.name, '--json'], { capture: true });
  if (r.code !== 0) {
    if (/10007|not found|no deployments|does not exist/i.test(`${r.stderr}${r.stdout}`)) return null; // first deployment
    throw new DeployHalt(`cannot read the current version of ${w.name}: ${r.stderr.trim().slice(0, 300)}`);
  }
  const d = JSON.parse(r.stdout) as { versions?: { version_id: string; percentage: number }[] };
  const versions = [...(d.versions ?? [])].sort((a, b) => b.percentage - a.percentage);
  if (versions.length === 0) return null;
  if (versions.length > 1) io.log(`${w.name} is on a gradual deployment; capturing its largest version for rollback`);
  return versions[0]!.version_id;
}

async function readMigrationState(io: Io): Promise<{ applied: string[]; userTables: number }> {
  const tables = (await queryD1(io, REMOTE_CONFIG, ['--remote'], "SELECT name FROM sqlite_master WHERE type='table'")).map((r) => String(r['name']));
  const user = tables.filter((t) => t !== 'd1_migrations' && !t.startsWith('sqlite_') && !t.startsWith('_cf_'));
  const applied = tables.includes('d1_migrations')
    ? (await queryD1(io, REMOTE_CONFIG, ['--remote'], 'SELECT name FROM d1_migrations ORDER BY id')).map((r) => String(r['name']))
    : [];
  return { applied, userTables: user.length };
}

function describePending(plan: MigrationPlan): string[] {
  return plan.destructive.flatMap((m) => m.reasons.map((r) => `- ${m.name}: ${r}`));
}

async function applyMigrations(cfg: RunConfig, io: Io): Promise<void> {
  const state = await readMigrationState(io);
  const approval = cfg.event === 'workflow_dispatch' ? cfg.approval : '';
  let plan: MigrationPlan;
  try {
    plan = planMigrations({ files: await io.migrationFiles(), applied: state.applied, userTables: state.userTables, approval });
  } catch (err) {
    if (err instanceof MigrationOrderError) throw new DeployHalt(err.message);
    throw err;
  }
  plan.warnings.forEach((w) => io.log(`warning: ${w}`));

  if (plan.action === 'halt') {
    io.summary('## Halted: destructive migration needs approval');
    io.summary(`Pending set sha256: \`${plan.hash}\``);
    describePending(plan).forEach((l) => io.summary(l));
    io.log(`pending migrations: ${plan.pending.map((m) => m.name).join(', ')}`);
    describePending(plan).forEach((l) => io.log(l));
    fail(
      `pending migrations would drop or rewrite existing data. Nothing was changed. To approve this exact set, start the workflow by hand ` +
        `with approve_destructive_migrations=${plan.hash}`,
    );
  }

  // Restore point before any schema change.
  const info = await wr(io, ['d1', 'time-travel', 'info', DB_NAME, '--json', '-c', REMOTE_CONFIG], true);
  const bookmark = (JSON.parse(info.stdout) as { bookmark?: string }).bookmark;
  if (!bookmark) fail('D1 Time Travel returned no bookmark; refusing to continue without a restore point');
  io.summary(`D1 restore point (Time Travel bookmark): \`${bookmark}\``);

  if (plan.action === 'none') {
    io.summary('Migrations: none pending.');
    return;
  }
  const note = plan.firstDeployment ? ' (first deployment)' : plan.destructive.length > 0 ? ` (approved, set ${plan.hash})` : '';
  io.summary(`Migrations to apply${note}: ${plan.pending.map((m) => `\`${m.name}\``).join(', ')}`);
  await wr(io, ['d1', 'migrations', 'apply', DB_NAME, '--remote', '-c', REMOTE_CONFIG]);
  io.summary('Migrations: applied.');
}

async function ensureNoPendingMigrations(io: Io): Promise<void> {
  const state = await readMigrationState(io);
  const plan = planMigrations({ files: await io.migrationFiles(), applied: state.applied, userTables: state.userTables, approval: '' });
  if (plan.pending.length > 0) {
    fail(`publish needs a database at this commit's schema, but migrations are pending: ${plan.pending.map((m) => m.name).join(', ')}. Run a full deploy first.`);
  }
}

/** Exports the catalogue, builds the site from it, returns the snapshot. Deploys nothing. */
async function buildFromProduction(cfg: RunConfig, io: Io): Promise<PublishedSnapshot> {
  const [counts] = await queryD1(
    io,
    REMOTE_CONFIG,
    ['--remote'],
    "SELECT (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM wilayas) AS wilayas, (SELECT count(*) FROM settings WHERE key = 'storeName') AS store_name",
  );
  const products = Number(counts?.['products'] ?? 0);
  const wilayas = Number(counts?.['wilayas'] ?? 0);
  const storeName = Number(counts?.['store_name'] ?? 0);
  if (products === 0 || wilayas < 69 || storeName === 0) {
    fail(
      `the production catalogue is empty or incomplete (products=${products}, wilayas=${wilayas}, storeName=${storeName}). ` +
        'No Worker was deployed. Load the catalogue once from the CLI, outside this pipeline, then run it again.',
    );
  }

  const exportFile = join(cfg.workDir, 'catalogue.sql');
  const persist = join(cfg.workDir, 'persist');
  const configFile = join(cfg.workDir, 'wrangler.json');
  await io.writeFile(
    configFile,
    JSON.stringify({
      name: 'hb-pipeline-local',
      compatibility_date: '2026-11-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: DB_NAME,
          database_id: PLACEHOLDER_D1_ID,
          migrations_dir: relative(dirname(configFile), resolve(cfg.repoRoot, 'packages/db/migrations')),
        },
      ],
      r2_buckets: [{ binding: 'MEDIA', bucket_name: 'hb-media' }],
    }),
  );

  await wr(io, ['d1', 'export', DB_NAME, '--remote', '--no-schema', '-y', '--output', exportFile, ...CATALOGUE_TABLES.flatMap((t) => ['--table', t]), '-c', REMOTE_CONFIG]);
  const local = ['--local', '--persist-to', persist];
  await wr(io, ['d1', 'migrations', 'apply', DB_NAME, ...local, '-c', configFile]);

  // content_pages and settings keep a foreign key to admin_users, which never leaves production.
  // Empty stand-ins for the referenced ids, in the throw-away local database, satisfy it.
  const authors = await queryD1(
    io,
    REMOTE_CONFIG,
    ['--remote'],
    'SELECT updated_by AS id FROM content_pages WHERE updated_by IS NOT NULL UNION SELECT updated_by AS id FROM settings WHERE updated_by IS NOT NULL',
  );
  const ids = authors.map((a) => Number(a['id'])).filter(Number.isInteger);
  if (ids.length > 0) {
    const rows = ids.map((id) => `(${id}, 'author-${id}@pipeline.invalid', 'n/a', 'owner', 0)`).join(', ');
    await queryD1(io, configFile, local, `INSERT OR IGNORE INTO admin_users (id, email, name, role, active) VALUES ${rows}`);
  }
  await wr(io, ['d1', 'execute', DB_NAME, ...local, '-y', '-c', configFile, '--file', exportFile]);

  const imageRows = await queryD1(io, configFile, local, 'SELECT DISTINCT r2_key AS key FROM images WHERE r2_key IS NOT NULL');
  const keys = imageRows.map((r) => String(r['key']));
  const unsafe = keys.filter((k) => k === '' || k.startsWith('/') || k.split('/').includes('..'));
  if (unsafe.length > 0) fail(`refusing unsafe image keys: ${unsafe.slice(0, 5).join(', ')}`);
  await io.loadOriginals(keys, persist, configFile);
  io.summary(`Catalogue exported from production (${products} products, ${keys.length} image originals).`);

  const snapshot = await io.publish([
    '--enqueue', '--source', 'd1', '--persist-to', persist, '--site-origin', SITE_ORIGIN, '--image-cache', cfg.imageCache, '--budget', 'skip',
  ]);
  if (snapshot.settings?.turnstileSiteKey == null) io.summary('Warning: settings.turnstileSiteKey is empty: the order form will not load Turnstile (orders are accepted and flagged).');
  return snapshot;
}

async function rollback(io: Io, deployed: readonly Worker[], before: ReadonlyMap<string, string | null>): Promise<boolean> {
  let ok = true;
  for (const w of [...deployed].reverse()) {
    const previous = before.get(w.name) ?? null;
    if (previous === null) {
      io.summary(`Rollback ${w.name}: no previous version (first deployment), left in place.`);
      continue;
    }
    const r = await io.wrangler(['rollback', previous, '--name', w.name, '-y', '--message', 'automatic rollback: pipeline failure'], { capture: true });
    if (r.code === 0) {
      io.summary(`Rollback ${w.name}: back to version \`${previous}\`.`);
    } else {
      ok = false;
      io.summary(`Rollback ${w.name}: FAILED (exit ${r.code}). Roll back by hand to version \`${previous}\`.`);
    }
  }
  return ok;
}

export async function run(cfg: RunConfig, io: Io): Promise<void> {
  io.summary(`# Deployment: ${cfg.mode} of \`${cfg.sha}\``);
  if (!(await verifyCommit(cfg, io))) return;

  const problems = preflightProblems({
    jobs: await io.readConfig(JOBS.config),
    web: await io.readConfig(WEB.config),
    admin: await io.readConfig(ADMIN.config),
  });
  if (problems.length > 0) {
    problems.forEach((p) => io.summary(`- ${p}`));
    fail(`Worker configuration is not ready for production:\n${problems.join('\n')}`);
  }

  const targets = cfg.mode === 'publish' ? [WEB] : DEPLOY_ORDER;
  const before = new Map<string, string | null>();
  for (const w of targets) before.set(w.name, await currentVersion(io, w));

  if (cfg.mode === 'deploy') await applyMigrations(cfg, io);
  else await ensureNoPendingMigrations(io);

  const snapshot = await buildFromProduction(cfg, io);

  const deployed: Worker[] = [];
  try {
    for (const w of targets) {
      deployed.push(w); // recorded first: a deploy that failed half-way is rolled back too
      // --no-experimental-provision: a missing bucket or queue must fail the deploy, never be created by it.
      await wr(io, ['deploy', '-c', w.config, ...w.deployArgs, '--no-experimental-provision', '--message', `pipeline ${cfg.sha.slice(0, 12)}`]);
      io.log(`${w.name} deployed`);
    }
    for (const w of targets) {
      const previous = before.get(w.name);
      io.summary(`Deployed ${w.name}: version \`${await currentVersion(io, w)}\` (previous: \`${previous ?? 'none, first deployment'}\`)`);
    }
    const smoke = await io.smoke(snapshot, cfg.mode === 'publish' ? 'site' : 'all');
    if (smoke.length > 0) throw new DeployHalt(`smoke checks failed:\n${smoke.join('\n')}`);
    io.summary('Smoke checks: passed.');
  } catch (err) {
    io.summary(`## Deployment failed: ${err instanceof Error ? err.message : String(err)}`);
    const rolledBack = await rollback(io, deployed, before);
    io.summary(rolledBack ? 'Rollback finished. A Worker rollback does not undo migrations: see docs/DEPLOY.md.' : '## Rollback incomplete: see the lines above.');
    throw err;
  }
}
