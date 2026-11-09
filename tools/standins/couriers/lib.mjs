// Shared helpers for the courier stand-ins. Node built-ins only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GEO = (name) => fileURLToPath(new URL(`../../../data/geo/${name}`, import.meta.url));

export const stripAccents = (value) => value.normalize('NFD').replace(/\p{M}/gu, '');

// 59-69 sit under their pre-2026 parent, as the couriers still list them.
const PARENT = { 59: 3, 60: 5, 61: 7, 62: 12, 63: 13, 64: 14, 65: 17, 66: 17, 67: 26, 68: 28, 69: 32 };

/**
 * Courier-side geography: our dataset folded into 58 wilayas, with accents removed. The spelling
 * deliberately differs from ours wherever a name has an accent, so an adapter that sends our
 * spelling instead of the courier's is refused.
 */
export function loadGeo() {
  const wilayas = JSON.parse(readFileSync(GEO('wilayas.json'), 'utf8'))
    .filter((w) => w.code <= 58)
    .map((w) => ({ code: w.code, name: stripAccents(w.name_fr) }));
  const nameOf = new Map(wilayas.map((w) => [w.code, w.name]));
  const communes = JSON.parse(readFileSync(GEO('communes.json'), 'utf8')).map((c) => {
    const wilayaCode = PARENT[c.wilaya_code] ?? c.wilaya_code;
    return {
      id: c.id,
      name: stripAccents(c.name_fr),
      wilayaCode,
      wilayaName: nameOf.get(wilayaCode),
    };
  });
  return { wilayas, communes };
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export function sendText(res, status, body, contentType = 'text/plain') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Algeria local time (UTC+1, no DST) as couriers print it. */
export function algeriaTimestamp(at = Date.now()) {
  return new Date(at + 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
}

export function isLoopbackUrl(value) {
  try {
    const { hostname, protocol } = new URL(value);
    return protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost');
  } catch {
    return false;
  }
}

/** Fixed-window request counters: `{ perSecond, perMinute }` limits, `null` to not limit. */
export function createQuota({ perSecond, perMinute }) {
  let second = { at: 0, used: 0 };
  let minute = { at: 0, used: 0 };
  return {
    reset() {
      second = { at: 0, used: 0 };
      minute = { at: 0, used: 0 };
    },
    /** Counts a request. Returns the seconds to wait when over a limit, else `null`. */
    take(now = Date.now()) {
      const s = Math.floor(now / 1000);
      const m = Math.floor(now / 60_000);
      if (second.at !== s) second = { at: s, used: 0 };
      if (minute.at !== m) minute = { at: m, used: 0 };
      if (minute.used >= perMinute) return 60 - Math.floor((now % 60_000) / 1000);
      if (second.used >= perSecond) return 1;
      second.used += 1;
      minute.used += 1;
      return null;
    },
    left() {
      return { second: perSecond - second.used, minute: perMinute - minute.used };
    },
  };
}
