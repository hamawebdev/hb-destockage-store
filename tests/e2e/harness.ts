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
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    : !has('data/geo') ? 'geo dataset data/geo not in this checkout (GEO)'
    : !has('data/content') ? 'content pages data/content not in this checkout (PAGES)'
    : !has('data/photos/manifest.json') ? 'photo manifest data/photos/manifest.json not in this checkout (SEED)' : null),
  webOrder: () => (has('apps/web/src/routes/order.ts') ? null : 'POST /api/order not in this checkout (WEB order route)'),
  webQuote: () => (has('apps/web/src/routes/quote.ts') ? null : 'POST /api/quote not in this checkout'),
  orderForm: () => {
    // ORDER-STEP: the form lives on /{lang}/order/<slug>/, reached from the product page's #cat-buy
    const dir = path.join(DIST, 'fr/order');
    const steps = existsSync(dir) ? readdirSync(dir).filter((d) => d !== 'confirmation' && d !== 'review' && existsSync(path.join(dir, d, 'index.html'))) : [];
    if (!steps.some((d) => readFileSync(path.join(dir, d, 'index.html'), 'utf8').includes('action="/api/order"'))) return 'no order step page with <form action="/api/order"> in the build (ORDER-STEP: /{lang}/order/<slug>/)';
    const products = path.join(DIST, 'fr/p');
    const hasCta = existsSync(products) && readdirSync(products).some((d) => { const f = path.join(products, d, 'index.html'); return existsSync(f) && readFileSync(f, 'utf8').includes('id="cat-buy"'); });
    return hasCta ? null : 'no product page with the #cat-buy order CTA in the build (ORDER-STEP product page)';
  },
  geoFiles: () => (existsSync(path.join(DIST, 'geo/communes/ar/1.json')) ? null : 'per-wilaya commune JSON not in the build (CAT-5 /geo/communes/<lang>/<code>.json)'),
  homeChoice: () => {
    // CART-0's choice view needs a homepage card whose product has options. The seed features only packs,
    // so this spec runs on a scratch build that features a variable product (homeFeaturedProductIds).
    const home = path.join(DIST, 'fr/index.html');
    if (!existsSync(home)) return 'storefront not built';
    const ids = [...readFileSync(home, 'utf8').matchAll(/data-cart-add="(\d+)"/g)].map((m) => m[1]);
    const opts = ids.some((id) => (JSON.parse(readFileSync(path.join(DIST, `fr/cart/items/${id}.json`), 'utf8')) as { options: unknown[] }).options.length > 0);
    return opts ? null : 'no homepage card has a product with options in this build (feature a variable product via homeFeaturedProductIds)';
  },
  adminAuth: () => (has('apps/admin/src/auth/dev-routes.tsx') ? null : 'admin auth (ADMIN-1 dev login + Access JWT) not in this checkout'),
  adminOrders: () => (ORDER_ROUTES().some(([m, p]) => m === 'GET' && p === '/:ref') ? null : 'admin order list and detail not in this checkout (admin-orders route table: GET /:ref)'),
  adminTransitions: () => {
    const have = ORDER_ROUTES().map(([m, p]) => `${m} ${p}`);
    const want = ['POST /:ref/call', 'POST /:ref/transition'].filter((r) => !have.includes(r));
    return want.length ? `admin order actions not in this checkout (admin-orders route table: ${want.join(', ')})` : null;
  },
};
export type Feature = 'storefront' | 'seed' | 'webOrder' | 'webQuote' | 'orderForm' | 'geoFiles' | 'adminAuth' | 'adminOrders' | 'adminTransitions' | 'homeChoice';

/**
 * admin-orders' route table: the `//   GET  /:ref   …` header of apps/admin/src/routes/orders/index.tsx
 * (paths relative to /orders). Read from the table, not from code, so a refactor of how routes
 * are written does not hide them.
 */
export function ORDER_ROUTES(): Array<[method: 'GET' | 'POST', path: string]> {
  const f = path.join(REPO, 'apps/admin/src/routes/orders/index.tsx');
  if (!existsSync(f)) return [];
  const out: Array<['GET' | 'POST', string]> = [];
  for (const m of readFileSync(f, 'utf8').matchAll(/^\/\/\s+(GET|POST)\s+(\/\S*)/gm)) out.push([m[1] as 'GET' | 'POST', m[2]!]);
  return out;
}

/** A syntactically valid order ref that matches the routes' `:ref` pattern. */
export const SAMPLE_REF = 'HB-AAAAA';

/**
 * Every admin route to probe without auth: each section admin-core mounts in apps/admin/src/app.ts
 * (`app.route('/x', …)`, GET and POST), the orders routes from admin-orders' route table, and the
 * core's own pages. Empty when the admin is not in this checkout.
 */
export function ADMIN_ROUTES(): Array<[method: 'GET' | 'POST', path: string]> {
  const app = path.join(REPO, 'apps/admin/src/app.ts');
  if (!existsSync(app)) return [];
  const mounts = [...readFileSync(app, 'utf8').matchAll(/app\.route\('(\/[a-z-]+)'/g)].map((m) => m[1]!);
  const routes: Array<['GET' | 'POST', string]> = [['GET', '/'], ['GET', '/assets/admin.css'], ['POST', '/settings/language']];
  for (const m of mounts) routes.push(['GET', m], ['POST', m]);
  for (const [meth, p] of ORDER_ROUTES()) routes.push([meth, `/orders${p === '/' ? '' : p.replace(':ref', SAMPLE_REF)}`]);
  return [...new Map(routes.map((r) => [`${r[0]} ${r[1]}`, r])).values()];
}

/** Reason the given features are not all available, or null. */
export function missing(...need: Feature[]): string | null {
  const reasons = need.map((f) => FEATURES[f]()).filter((r): r is string => !!r);
  return reasons.length ? reasons.join('; ') : null;
}

export const STRICT = process.env['HB_E2E_STRICT'] === '1';

// ---------------------------------------------------------------------------------------------
// local D1
// ---------------------------------------------------------------------------------------------

/** SQLite busy: a running Worker holds the write lock on the shared local D1 file. */
const BUSY = /SQLITE_BUSY|database is locked/;
const D1_ATTEMPTS = 8;

/**
 * Run SQL against the shared local D1 (read-only use in specs). The Workers write the same SQLite
 * file (an order, its events, the admin's audit rows), so a read can meet SQLITE_BUSY: retry it
 * with backoff (8 attempts, ~5 s in total) instead of failing the spec (rehearsal-1 finding).
 */
export function d1<T = Record<string, unknown>>(sql: string): T[] {
  let r = spawnSync(WRANGLER, ['d1', 'execute', 'hb-destockage', '--local', '--persist-to', PERSIST, '--json', '--command', sql], {
    cwd: path.join(REPO, 'packages/db'), encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
  for (let attempt = 1; r.status !== 0 && attempt < D1_ATTEMPTS && BUSY.test(`${r.stdout}${r.stderr}`); attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * attempt); // synchronous backoff
    r = spawnSync(WRANGLER, ['d1', 'execute', 'hb-destockage', '--local', '--persist-to', PERSIST, '--json', '--command', sql], {
      cwd: path.join(REPO, 'packages/db'), encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    });
  }
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
  // web: its wrangler.jsonc top level is production; development values come from the dev script
  // (tooling f4696e9: --var ENV:development --var SITE_HOSTS:localhost,127.0.0.1), as here
  const out: Record<string, string> = name === 'admin' ? { ENV: 'development' } : { ENV: 'development', SITE_HOSTS: 'localhost,127.0.0.1' };
  const ex = path.join(REPO, 'apps', name, '.dev.vars.example');
  const keys = existsSync(ex) ? readFileSync(ex, 'utf8').split('\n').map((l) => /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(l)?.[1]).filter((k): k is string => !!k) : [];
  for (const k of [...keys, ...(name === 'web' ? ['ORDER_SIGNING_KEY', 'IP_HASH_KEY', 'TURNSTILE_SECRET'] : ['DEV_SESSION_SECRET', 'CSRF_SECRET'])]) {
    if (k in out) continue;
    out[k] = k === 'ENV' ? 'development' : k === 'TURNSTILE_SECRET' ? '1x0000000000000000000000000000000AA' : `e2e-${k.toLowerCase().replace(/_/g, '-')}-6f1c0a9e3b7d4f2a8c5e1b9d7a3f6c2e`;
  }
  return out;
}

/** Throws when something already listens on 127.0.0.1:port (e.g. another checkout's e2e run). */
export function assertPortFree(port: number): Promise<void> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', (e: NodeJS.ErrnoException) => fail(new Error(e.code === 'EADDRINUSE'
      ? `port ${port} is already in use (another e2e run or dev server?): refusing to test against a Worker this run did not start`
      : `port ${port}: ${e.message}`)));
    srv.listen(port, '127.0.0.1', () => srv.close(() => ok()));
  });
}

/**
 * Ready = our child is alive and the URL answers (< 500). The port was free before the child
 * started (assertPortFree), so what answers is this run's Worker, not another checkout's.
 */
async function waitReady(url: string, ms: number, child: ChildProcess, log: () => string): Promise<void> {
  const end = Date.now() + ms;
  let last = 'no answer yet';
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`worker exited (${child.exitCode}) before it was ready:\n${log().slice(-3000)}`);
    let r: Response | null = null;
    try { r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' }); } catch (e) { last = (e as Error).message; }
    if (r && r.status < 500) return;
    if (r) {
      const body = await r.text().catch(() => '');
      // self-check: a Worker that rejects its own configuration never becomes ready, so fail now
      if (body.includes('config_invalid')) {
        throw new Error(`${url} answers HTTP ${r.status} config_invalid: the Worker rejects its configuration (testSecrets() passes `
          + `ENV=development and SITE_HOSTS=localhost,127.0.0.1, as the dev script does; a newly required var must be added there):\n${body.slice(0, 500)}`);
      }
      last = `HTTP ${r.status}`;
    }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  throw new Error(`${url} not ready after ${ms} ms (${last}):\n${log().slice(-3000)}`);
}

export async function startWorker(name: 'web' | 'admin', logDir: string): Promise<Running> {
  const port = name === 'web' ? WEB_PORT : ADMIN_PORT;
  await assertPortFree(port);
  await assertPortFree(port + 1);
  const cwd = path.join(REPO, 'apps', name);
  const args = ['dev', '--env=', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 1),
    '--persist-to', PERSIST, '--log-level', 'warn', '--show-interactive-dev-session=false'];
  // The admin's custom-domain route (BOOT-0) makes `wrangler dev` hand the Worker that hostname for every request, so its
  // dev-only login (dev-gate.ts: loopback hostnames only) would answer 404. Serve a copy of the config without `routes`:
  // requests then keep the Host they were sent with, which the admin-auth spec relies on. Local runs only.
  let tempConfig: string | null = null;
  if (name === 'admin') {
    const real = readFileSync(path.join(cwd, 'wrangler.jsonc'), 'utf8');
    const stripped = real.replace(/^\s*"routes"\s*:.*\n/m, '');
    if (stripped !== real) {
      tempConfig = path.join(cwd, '.wrangler-e2e.jsonc');
      writeFileSync(tempConfig, stripped);
      args.push('--config', tempConfig);
    }
  }
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
    if (tempConfig) rmSync(tempConfig, { force: true });
    if (child.exitCode !== null || child.pid === undefined) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    await new Promise((ok) => setTimeout(ok, 1500));
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  };
  try {
    await waitReady(name === 'web' ? `${url}/api/health` : `${url}/__dev/login`, 150_000, child, () => log);
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
