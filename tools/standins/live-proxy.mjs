#!/usr/bin/env node
// LOCAL ACCEPTANCE ONLY. NEVER DEPLOY THIS, never run it on a server, never expose its port.
//
// A loopback HTTP server that forwards to the REAL Telegram and Google services, so a developer can
// rehearse the owner's flow on a laptop while the Workers' loopback guard stays untouched (outside
// production they only talk to http://127.0.0.1:<port>, TELEGRAM_STANDIN_URL / GOOGLE_STANDIN_URL).
// Production never uses it: with ENV=production the Workers call the real hosts directly.
//
//   node tools/standins/live-proxy.mjs --port 4430
//
//   /bot<token>/<method>     → https://api.telegram.org/bot<token>/<method>
//   /o/oauth2/v2/auth?…      → 302 to https://accounts.google.com/o/oauth2/v2/auth?… (same query)
//   /token                   → https://oauth2.googleapis.com/token
//   /revoke                  → https://oauth2.googleapis.com/revoke
//   /v4/spreadsheets…        → https://sheets.googleapis.com/v4/spreadsheets…
//   /drive/v3/files…         → https://www.googleapis.com/drive/v3/files…
//   /__control/sheet?id=…    → 302 to https://docs.google.com/spreadsheets/d/<id>/edit
//   POST /__control/down     every forwarded call fails with a closed connection (rehearse an outage)
//   POST /__control/up       back to forwarding
//   GET  /__control/state    {down}
//
// It binds 127.0.0.1 only, stores nothing, and logs nothing but: method, the path with the bot
// token and every query string removed, and the status. No header, no body, no token, ever.
// A path it does not proxy is answered 404 and printed as "/<not-proxied>".
// Node built-ins only.
import { createServer } from 'node:http';

const MAX_BODY = 16 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
/** Request headers that are forwarded; everything else (host, cookies, forwarding headers) is dropped. */
const FORWARD_REQUEST = ['authorization', 'content-type', 'accept', 'if-match', 'if-none-match'];
const FORWARD_RESPONSE = ['content-type', 'retry-after', 'etag', 'www-authenticate', 'cache-control'];

const BOT_PATH = /^\/bot(\d{5,12}:[A-Za-z0-9_-]{30,64})\/([A-Za-z]{1,40})$/;

/** What may be printed for a request: never the bot token, never a query string. */
export function safePath(pathname) {
  return pathname.replace(/^\/bot[^/]*/, '/bot<token>').slice(0, 200);
}

/** → {forward: URL string} | {redirect: URL string} | null (not a known path). */
export function routeFor(pathname, search) {
  const bot = BOT_PATH.exec(pathname);
  if (bot) return { forward: `https://api.telegram.org/bot${bot[1]}/${bot[2]}${search}` };
  if (pathname === '/o/oauth2/v2/auth') return { redirect: `https://accounts.google.com/o/oauth2/v2/auth${search}` };
  if (pathname === '/token') return { forward: 'https://oauth2.googleapis.com/token' };
  if (pathname === '/revoke') return { forward: `https://oauth2.googleapis.com/revoke${search}` };
  // Path characters Google uses for ids, ranges and the ":batchUpdate" style verbs; no "..", no "//".
  const tail = /^[A-Za-z0-9_\-/:.!$'%]*$/;
  for (const [prefix, target] of [
    ['/v4/spreadsheets', 'https://sheets.googleapis.com/v4/spreadsheets'],
    ['/drive/v3/files', 'https://www.googleapis.com/drive/v3/files'],
  ]) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}:`)) {
      const rest = pathname.slice(prefix.length);
      if (!tail.test(rest) || rest.includes('..') || rest.includes('//')) return null;
      return { forward: `${target}${rest}${search}` };
    }
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

export function startLiveProxy(port = 0, { fetch: doFetch = fetch, log = console.log } = {}) {
  let down = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const known = url.pathname.startsWith('/__control/') || routeFor(url.pathname, '') !== null;
    // A path we do not proxy is not printed at all: it could be a mistyped URL with a token in it.
    const shown = known ? safePath(url.pathname) : '/<not-proxied>';
    const say = (status) => log(`${req.method} ${shown} ${status}`);
    const reply = (status, body = '', headers = {}) => {
      res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers });
      res.end(body);
      say(status);
    };
    (async () => {
      if (url.pathname.startsWith('/__control/')) {
        if (req.method === 'POST' && url.pathname === '/__control/down') down = true;
        else if (req.method === 'POST' && url.pathname === '/__control/up') down = false;
        else if (req.method === 'GET' && url.pathname === '/__control/sheet') {
          const id = url.searchParams.get('id') ?? '';
          if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return reply(400, 'bad id');
          return reply(302, '', { Location: `https://docs.google.com/spreadsheets/d/${id}/edit` });
        } else if (!(req.method === 'GET' && url.pathname === '/__control/state')) return reply(404, 'unknown control route');
        return reply(200, JSON.stringify({ down }), { 'Content-Type': 'application/json' });
      }
      const route = routeFor(url.pathname, url.search);
      if (!route) return reply(404, 'not proxied');
      if (route.redirect) return reply(302, '', { Location: route.redirect });
      const body = await readBody(req);
      if (body === null) return reply(413, 'too large');
      if (down) {
        res.socket?.destroy();
        say('dropped');
        return undefined;
      }
      const headers = {};
      for (const h of FORWARD_REQUEST) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];
      let upstream;
      try {
        upstream = await doFetch(route.forward, {
          method: req.method,
          headers,
          ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body }),
          redirect: 'manual',
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
      } catch {
        // The caught error may quote the upstream URL (the bot token): never printed.
        res.socket?.destroy();
        say('unreachable');
        return undefined;
      }
      const out = Buffer.from(await upstream.arrayBuffer());
      const outHeaders = { 'Content-Length': out.length };
      for (const h of FORWARD_RESPONSE) {
        const v = upstream.headers.get(h);
        if (v !== null) outHeaders[h] = v;
      }
      res.writeHead(upstream.status, outHeaders);
      res.end(out);
      say(upstream.status);
      return undefined;
    })().catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
      say('error');
    });
  });
  return new Promise((resolve) => {
    // Loopback only, on purpose: this must never listen on a routable address.
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const i = process.argv.indexOf('--port');
  const { port } = await startLiveProxy(i >= 0 ? Number(process.argv[i + 1]) : 0);
  console.log(`live-proxy (LOCAL ACCEPTANCE ONLY, never deploy) listening on http://127.0.0.1:${port}`);
}
