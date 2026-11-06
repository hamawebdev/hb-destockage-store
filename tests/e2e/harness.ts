/**
 * End-to-end harness (MEAS-4): boots the local web Worker (storefront + /api/*) and the admin
 * Worker on measure's port block over ONE seeded local D1, and tells each spec which features
 * exist in this checkout.
 *
 * Specs are written against the contracts (web routes/order.ts, shared order-schema, db schema and
 * seed, admin auth) and skip themselves with a reason until the feature is in the checkout.
 * HB_E2E_STRICT=1 turns every such skip into a failure (acceptance runs: nothing may be missing).
 *
 * Ports (measure block 4110–4119): web 4110 (inspector 4111), admin 4118 (inspector 4119).
 * External servers instead: HB_E2E_WEB_URL / HB_E2E_ADMIN_URL (then D1 checks use HB_E2E_PERSIST).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WEB_PORT = 4110;
export const ADMIN_PORT = 4118;
export const PERSIST = process.env['HB_E2E_PERSIST'] ?? path.join(REPO, '.wrangler/e2e');
export const DIST = path.join(REPO, 'apps/storefront/dist');
const WRANGLER = path.join(REPO, 'node_modules/.bin/wrangler');
export const ARTIFACTS = process.env['HB_E2E_OUT'] ?? path.join(REPO, 'artifacts/e2e');

const has = (rel: string, re?: RegExp): boolean => {
  const p = path.join(REPO, rel);
  if (!existsSync(p)) return false;
  return re ? re.test(readFileSync(p, 'utf8')) : true;
};

/**
 * Feature probes: null when present, otherwise the reason a spec must wait. Each names the task
 * that delivers it, so a skip says what it is waiting for.
 */
export const FEATURES: Record<Feature, () => string | null> = {
  storefront: () => (existsSync(path.join(DIST, 'ar/index.html')) ? null : 'storefront not built (npm run build -w @hb/storefront)'),
  seed: () => (!has('packages/db/src/seed/cli.ts') ? 'DB seed command not in this checkout (DB-3)'
    : !has('data/catalog') ? 'seed catalogue data/catalog not in this checkout (SEED)'
    : !has('data/geo') ? 'geo dataset data/geo not in this checkout (GEO)' : null),
  webOrder: () => (has('apps/web/src/routes/order.ts') ? null : 'POST /api/order not in this checkout (WEB order route)'),
  webQuote: () => (has('apps/web/src/routes/quote.ts') ? null : 'POST /api/quote not in this checkout'),
  orderForm: () => {
    const dir = path.join(DIST, 'fr/p');
    if (!existsSync(dir)) return 'no product pages in the build';
    const html = spawnSync('grep', ['-rl', 'action="/api/order"', dir], { encoding: 'utf8' }).stdout;
    return html.trim() ? null : 'no product page with <form action="/api/order"> in the build (ORDER form)';
  },
  geoFiles: () => (existsSync(path.join(DIST, 'geo/communes/ar/1.json')) ? null : 'per-wilaya commune JSON not in the build (CAT-5 /geo/communes/<lang>/<code>.json)'),
  adminAuth: () => (has('apps/admin/src/auth/dev-routes.tsx') ? null : 'admin auth (ADMIN-1 dev login + Access JWT) not in this checkout'),
  adminOrders: () => (has('apps/admin/src/routes/orders/index.tsx', /\bref\b/) ? null : 'admin order list not in this checkout (ADMIN orders)'),
  adminTransitions: () => {
    const dir = path.join(REPO, 'apps/admin/src/routes/orders');
    if (!existsSync(dir)) return 'admin order routes not in this checkout';
    const hit = spawnSync('grep', ['-rlE', "r\\.post\\(['\"]/:[a-zA-Z]+/(transition|status)", dir], { encoding: 'utf8' }).stdout;
    return hit.trim() ? null : 'admin order status transitions not in this checkout (ADMIN orders: POST /orders/:id/transition)';
  },
};
export type Feature = 'storefront' | 'seed' | 'webOrder' | 'webQuote' | 'orderForm' | 'geoFiles' | 'adminAuth' | 'adminOrders' | 'adminTransitions';

/** Reason the given features are not all available, or null. */
export function missing(...need: Feature[]): string | null {
  const reasons = need.map((f) => FEATURES[f]()).filter((r): r is string => !!r);
  return reasons.length ? reasons.join('; ') : null;
}

export const STRICT = process.env['HB_E2E_STRICT'] === '1';

// ---------------------------------------------------------------------------------------------
// local D1
// ---------------------------------------------------------------------------------------------

/** Run SQL against the shared local D1 (read-only use in specs). */
export function d1<T = Record<string, unknown>>(sql: string): T[] {
  const r = spawnSync(WRANGLER, ['d1', 'execute', 'hb-destockage', '--local', '--persist-to', PERSIST, '--json', '--command', sql], {
    cwd: path.join(REPO, 'packages/db'), encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
  if (r.status !== 0) throw new Error(`d1 query failed (${r.status}): ${sql}\n${r.stderr.slice(-1500)}`);
  const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))) as Array<{ results: T[] }>;
  return out[0]?.results ?? [];
}

/** Fresh local D1 with migrations only (when the seed command is not in the checkout). */
export function migrateFresh(): boolean {
  if (!existsSync(path.join(REPO, 'packages/db/migrations'))) return false;
  rmSync(PERSIST, { recursive: true, force: true });
  mkdirSync(PERSIST, { recursive: true });
  const r = spawnSync(WRANGLER, ['d1', 'migrations', 'apply', 'hb-destockage', '--local', '--persist-to', PERSIST], {
    cwd: path.join(REPO, 'packages/db'), encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
  if (r.status !== 0) throw new Error(`migrations failed (${r.status}):\n${(r.stdout + r.stderr).slice(-3000)}`);
  return true;
}

/** Fresh local D1: migrations + seed (data/). */
export function seedFresh(): void {
  rmSync(PERSIST, { recursive: true, force: true });
  mkdirSync(PERSIST, { recursive: true });
  const r = spawnSync(process.execPath, ['packages/db/src/seed/cli.ts', '--persist-to', PERSIST, '--no-photos'], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, ENV: 'development', CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
  if (r.status !== 0) throw new Error(`seed failed (${r.status}):\n${(r.stdout + r.stderr).slice(-3000)}`);
}

// ---------------------------------------------------------------------------------------------
// workers
// ---------------------------------------------------------------------------------------------

export interface Running { url: string; stop: () => Promise<void> }

/**
 * Local test values (never real secrets) for every key the app lists in its .dev.vars.example,
 * so a checkout without .dev.vars boots: ENV=development (admin dev login), Turnstile's
 * documented always-pass test secret, random-looking fillers for keys and HMAC secrets.
 */
export function testSecrets(name: 'web' | 'admin'): Record<string, string> {
  const out: Record<string, string> = name === 'admin' ? { ENV: 'development' } : {};
  const ex = path.join(REPO, 'apps', name, '.dev.vars.example');
  const keys = existsSync(ex) ? readFileSync(ex, 'utf8').split('\n').map((l) => /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(l)?.[1]).filter((k): k is string => !!k) : [];
  for (const k of [...keys, ...(name === 'web' ? ['ORDER_SIGNING_KEY', 'IP_HASH_KEY', 'TURNSTILE_SECRET'] : ['DEV_SESSION_SECRET', 'CSRF_SECRET'])]) {
    if (k in out) continue;
    out[k] = k === 'ENV' ? 'development' : k === 'TURNSTILE_SECRET' ? '1x0000000000000000000000000000000AA' : `e2e-${k.toLowerCase().replace(/_/g, '-')}-6f1c0a9e3b7d4f2a8c5e1b9d7a3f6c2e`;
  }
  return out;
}

async function waitHttp(url: string, ms: number, child: ChildProcess, log: () => string): Promise<void> {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`worker exited (${child.exitCode}) before ${url} answered:\n${log().slice(-3000)}`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
      if (r.status < 500) return;
      last = `HTTP ${r.status}`;
    } catch (e) { last = (e as Error).message; }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  throw new Error(`${url} not ready after ${ms} ms (${last}):\n${log().slice(-3000)}`);
}

export async function startWorker(name: 'web' | 'admin', logDir: string): Promise<Running> {
  const port = name === 'web' ? WEB_PORT : ADMIN_PORT;
  const cwd = path.join(REPO, 'apps', name);
  const args = ['dev', '--env=', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 1),
    '--persist-to', PERSIST, '--log-level', 'warn', '--show-interactive-dev-session=false'];
  for (const [k, v] of Object.entries(testSecrets(name))) args.push('--var', `${k}:${v}`);
  const child = spawn(WRANGLER, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  let log = '';
  const keep = (d: Buffer): void => { log = (log + d.toString()).slice(-50_000); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const url = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, `${name}.log`), log);
    if (child.exitCode !== null || child.pid === undefined) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    await new Promise((ok) => setTimeout(ok, 1500));
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  };
  try {
    await waitHttp(name === 'web' ? `${url}/api/health` : `${url}/__dev/login`, 150_000, child, () => log);
  } catch (e) {
    await stop();
    throw e;
  }
  return { url, stop };
}

// ---------------------------------------------------------------------------------------------
// helpers shared by specs
// ---------------------------------------------------------------------------------------------

/** Every integer in a text, with digit-group separators (space, nbsp, narrow nbsp, dot, comma) removed. */
export function integersIn(text: string): number[] {
  const t = text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  return (t.match(/\d{1,3}(?:[\s  .,]\d{3})+|\d+/g) ?? []).map((s) => Number(s.replace(/\D/g, '')));
}

/** A valid Algerian mobile number unique per run (national format 05/06/07 + 8 digits). */
export function testPhone(seed: number): string {
  return `06${String(60_000_000 + (seed % 9_999_999)).padStart(8, '0').slice(0, 8)}`;
}
