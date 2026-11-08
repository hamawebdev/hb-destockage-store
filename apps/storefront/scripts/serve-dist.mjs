// Tiny static server over dist/ for the local Chrome checks (tap-targets, lcp-element).
// Owner: shell.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.avif': 'image/avif', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.js': 'text/javascript', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain' };

/**
 * Map a request URL to a file path inside `root`, or null when it would escape it
 * (`/..%2F..%2Fetc%2Fpasswd`, `/%2e%2e/x`, bad escapes).
 * @param {string} root absolute directory
 * @param {string} url request URL (path + query)
 * @returns {string | null}
 */
export function resolveInside(root, url) {
  const base = resolve(root);
  let path;
  try {
    path = decodeURIComponent(new URL(url, 'http://x').pathname);
  } catch {
    return null;
  }
  if (path.includes('\0')) return null;
  const f = resolve(base, '.' + path);
  return f === base || f.startsWith(base + sep) ? f : null;
}

/** @param {string} root @param {number} port @returns {import('node:http').Server} */
export function serveDist(root, port) {
  return createServer(async (req, res) => {
    let f = resolveInside(root, req.url ?? '/');
    if (f === null) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      if ((await stat(f)).isDirectory()) f = join(f, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' });
      res.end(await readFile(f));
    } catch {
      res.writeHead(404);
      res.end();
    }
  }).listen(port, '127.0.0.1');
}
