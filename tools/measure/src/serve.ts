#!/usr/bin/env node
/**
 * Serve the built storefront for measurement.
 *
 *  - `wrangler`: `wrangler dev` of apps/web (Workers static assets + the Worker: production-like
 *    headers, brotli, run_worker_first routes). Used when apps/web/wrangler.jsonc exists and the
 *    site under test is the default dist (wrangler serves `assets.directory` from its config).
 *  - `static`: a small Node server over any dist directory: brotli (q11, cached) for text when the
 *    client accepts it, the `_headers` file applied (Cloudflare syntax: path pattern with `*`,
 *    indented `Name: value` lines), Workers-like trailing-slash handling and 404 page.
 *  - `auto` (default): wrangler when possible, else static.
 *
 * CLI (for QA and manual checks): node tools/measure/src/serve.ts [--mode auto|static|wrangler]
 *   [--dist <dir>] [--port <n>]; prints the base URL and serves until Ctrl-C.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliCompressSync, constants as Z } from 'node:zlib';
import { DEFAULT_DIST, REPO_ROOT } from './lib/paths.ts';

export type ServeMode = 'auto' | 'static' | 'wrangler';
export interface Server { baseUrl: string; mode: 'static' | 'wrangler' | 'external'; stop: () => Promise<void> }

/** Default port: the measure block is 4110–4119 (team/owners.json); 4112 = lh/shots server. */
export const DEFAULT_PORT = 4112;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = /^(text\/|application\/(json|xml|manifest)|image\/svg)/;

interface HeaderRule { re: RegExp; headers: Array<[string, string]> }

/** Parse a Cloudflare `_headers` file. Detached headers (`! Name`) are ignored. */
export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let cur: HeaderRule | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      const pat = raw.trim().replace(/^https?:\/\/[^/]+/, '');
      const re = new RegExp(`^${pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+')).join('.*')}$`);
      cur = { re, headers: [] };
      rules.push(cur);
    } else if (cur) {
      const m = /^\s+([^:!][^:]*):\s*(.*)$/.exec(raw);
      if (m) cur.headers.push([(m[1] ?? '').trim(), (m[2] ?? '').trim()]);
    }
  }
  return rules;
}

/** Map a request path to a file, Workers static-assets style ("auto-trailing-slash", "404-page"). */
export function resolveStatic(dist: string, urlPath: string): { file: string | null; status: number; redirect?: string } {
  let p: string;
  try { p = decodeURIComponent(urlPath); } catch { return { file: null, status: 400 }; }
  const abs = path.normalize(path.join(dist, p));
  if (abs !== dist && !abs.startsWith(dist + path.sep)) return { file: null, status: 403 };
  const isFile = (f: string): boolean => existsSync(f) && statSync(f).isFile();
  if (p.endsWith('/')) {
    if (isFile(path.join(abs, 'index.html'))) return { file: path.join(abs, 'index.html'), status: 200 };
  } else {
    if (isFile(abs)) return { file: abs, status: 200 };
    if (isFile(`${abs}.html`)) return { file: `${abs}.html`, status: 200 };
    if (isFile(path.join(abs, 'index.html'))) return { file: null, status: 307, redirect: `${p}/` };
  }
  // nearest 404.html walking up the path
  let dir = p.endsWith('/') ? p : path.posix.dirname(p);
  for (;;) {
    const f = path.join(dist, dir, '404.html');
    if (isFile(f)) return { file: f, status: 404 };
    if (dir === '/' || dir === '.') break;
    dir = path.posix.dirname(dir.replace(/\/$/, '')) + '/';
    if (dir === '//') dir = '/';
  }
  return { file: null, status: 404 };
}

export async function startStatic(dist: string, port: number): Promise<Server> {
  const root = path.resolve(dist);
  const hf = path.join(root, '_headers');
  const rules = existsSync(hf) ? parseHeadersFile(readFileSync(hf, 'utf8')) : [];
  const cache = new Map<string, Buffer>();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const r = resolveStatic(root, u.pathname);
    for (const rule of rules) if (rule.re.test(u.pathname)) for (const [k, v] of rule.headers) res.setHeader(k, v);
    if (r.redirect) { res.writeHead(r.status, { location: r.redirect + u.search }); res.end(); return; }
    if (!r.file) { res.writeHead(r.status, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    const type = TYPES[path.extname(r.file).toLowerCase()] ?? 'application/octet-stream';
    let body: Buffer = readFileSync(r.file);
    res.setHeader('content-type', type);
    if (COMPRESSIBLE.test(type)) {
      res.setHeader('vary', 'accept-encoding');
      if (/\bbr\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
        let br = cache.get(r.file);
        if (!br) {
          br = brotliCompressSync(body, { params: { [Z.BROTLI_PARAM_QUALITY]: 11, [Z.BROTLI_PARAM_SIZE_HINT]: body.length } });
          cache.set(r.file, br);
        }
        body = br;
        res.setHeader('content-encoding', 'br');
      }
    }
    res.setHeader('content-length', body.length);
    res.writeHead(r.status);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => ok()); });
  const actual = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${actual}`,
    mode: 'static',
    stop: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

const WEB_DIR = path.join(REPO_ROOT, 'apps/web');
const WRANGLER = path.join(REPO_ROOT, 'node_modules/.bin/wrangler');

export function canUseWrangler(dist: string): boolean {
  return existsSync(path.join(WEB_DIR, 'wrangler.jsonc')) && existsSync(WRANGLER) && path.resolve(dist) === path.resolve(DEFAULT_DIST);
}

async function waitFor(url: string, timeoutMs: number, child?: ChildProcess): Promise<void> {
  const end = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < end) {
    if (child && child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.status < 500) return;
      last = `HTTP ${r.status}`;
    } catch (e) { last = (e as Error).message; }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  throw new Error(`server not ready at ${url} after ${timeoutMs} ms (${last})`);
}

export async function startWrangler(port: number, logFile?: string): Promise<Server> {
  const persist = path.join(REPO_ROOT, '.wrangler/measure-local');
  const child = spawn(WRANGLER, ['dev', '--env=', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 1),
    '--persist-to', persist, '--log-level', 'warn', '--show-interactive-dev-session=false'], {
    cwd: WEB_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  });
  let log = '';
  const keep = (d: Buffer): void => { log = (log + d.toString()).slice(-20000); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.pid === undefined) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    await new Promise((ok) => setTimeout(ok, 1500));
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    if (logFile) { const { writeFileSync } = await import('node:fs'); writeFileSync(logFile, log); }
  };
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${baseUrl}/ar/`, 120_000, child);
  } catch (e) {
    await stop();
    throw new Error(`wrangler dev failed: ${(e as Error).message}\n${log.slice(-3000)}`);
  }
  return { baseUrl, mode: 'wrangler', stop };
}

export async function startServer(opts: { mode?: ServeMode; dist?: string; port?: number; logFile?: string }): Promise<Server> {
  const dist = path.resolve(opts.dist ?? DEFAULT_DIST);
  const port = opts.port ?? DEFAULT_PORT;
  const mode = opts.mode ?? 'auto';
  if (mode === 'wrangler' || (mode === 'auto' && canUseWrangler(dist))) {
    if (!canUseWrangler(dist)) throw new Error('wrangler mode needs apps/web/wrangler.jsonc, node_modules/.bin/wrangler and the default dist');
    return startWrangler(port, opts.logFile);
  }
  if (!existsSync(dist)) throw new Error(`dist not found: ${dist}`);
  return startStatic(dist, port);
}

export function externalServer(baseUrl: string): Server {
  return { baseUrl: baseUrl.replace(/\/+$/, ''), mode: 'external', stop: async () => {} };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { mode: { type: 'string' }, dist: { type: 'string' }, port: { type: 'string' } } });
  const s = await startServer({
    mode: (values.mode as ServeMode | undefined) ?? 'auto',
    ...(values.dist ? { dist: values.dist } : {}),
    port: Number(values.port ?? DEFAULT_PORT),
  });
  console.log(`${s.mode} server: ${s.baseUrl}  (Ctrl-C to stop)`);
  const bye = (): void => { void s.stop().then(() => process.exit(0)); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
