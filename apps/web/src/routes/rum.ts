/**
 * POST /api/rum — real-user monitoring beacon from shell's inline script (plan WEB-0 §8; payload
 * agreed with shell: {v:1, lang, tpl, path, navType, prerendered, ttfb, dns, connect, tls, proto,
 * lcp, activationStart}). Answers 204 with no body; never sets cookies; stores no IP and no id.
 *
 * Storage contract with jobs (purge after 90 days, Algiers-day rollups):
 * - `at` is ALWAYS the Worker's receive time, never a client value;
 * - `path` is the URL pathname only (no query, no fragment), under /ar/ or /fr/ (or /404.html), ≤ 200 chars.
 * One row per metric present (TTFB, LCP, DNS, CONNECT, TLS), inserted after the response (waitUntil).
 * Prerendered pages: LCP and TTFB are taken relative to `activationStart` (what the visitor saw).
 * Sampling: RUM_SAMPLE (0–1). Flood guard: RUM_RL_IP per IP; over the limit the beacon is dropped (204).
 */
import type { Hono } from 'hono';
import * as v from 'valibot';
import { createDb, rumEvents, type NewRumEvent } from '@hb/db';
import { readConfig, type Env } from '../env.ts';
import { log } from '../http.ts';
import { ipRateKey } from '../order/crypto.ts';

export const MAX_RUM_BYTES = 1024;
export const MAX_PATH = 200;
const MS = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(60_000));

export const RumBeaconSchema = v.object({
  v: v.literal(1),
  lang: v.picklist(['ar', 'fr']),
  tpl: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,31}$/)),
  path: v.pipe(v.string(), v.maxLength(1024)),
  navType: v.optional(v.picklist(['navigate', 'reload', 'back_forward', 'prerender', 'back-forward-cache', 'restore'])),
  prerendered: v.optional(v.boolean()),
  effectiveType: v.optional(v.picklist(['slow-2g', '2g', '3g', '4g'])),
  proto: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9./-]{1,16}$/i))),
  ttfb: v.optional(MS),
  lcp: v.optional(MS),
  dns: v.optional(MS),
  connect: v.optional(MS),
  tls: v.optional(MS),
  activationStart: v.optional(MS),
});
export type RumBeacon = v.InferOutput<typeof RumBeaconSchema>;

/** Pathname only, under the storefront; null when it is not one of ours. */
export function cleanPath(raw: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(raw, 'https://x.invalid').pathname;
  } catch {
    return null;
  }
  if (!(pathname.startsWith('/ar/') || pathname.startsWith('/fr/') || pathname === '/404.html')) return null;
  return pathname.slice(0, MAX_PATH);
}

type Metric = 'TTFB' | 'LCP' | 'DNS' | 'CONNECT' | 'TLS';
type Rating = 'good' | 'needs-improvement' | 'poor';

/** web.dev thresholds: LCP 2.5 s / 4 s, TTFB 0.8 s / 1.8 s. Network phases are not rated. */
export function rate(metric: Metric, value: number): Rating | null {
  const t = metric === 'LCP' ? [2500, 4000] : metric === 'TTFB' ? [800, 1800] : null;
  if (t === null) return null;
  return value <= t[0]! ? 'good' : value <= t[1]! ? 'needs-improvement' : 'poor';
}

export function toRows(b: RumBeacon, path: string, at: number, cf: { colo?: unknown; country?: unknown; asn?: unknown } | undefined): NewRumEvent[] {
  const shift = b.prerendered === true && b.activationStart !== undefined ? b.activationStart : 0;
  const metrics: [Metric, number | undefined][] = [
    ['TTFB', b.ttfb === undefined ? undefined : Math.max(0, b.ttfb - shift)],
    ['LCP', b.lcp === undefined ? undefined : Math.max(0, b.lcp - shift)],
    ['DNS', b.dns],
    ['CONNECT', b.connect],
    ['TLS', b.tls],
  ];
  const base = {
    at,
    template: b.tpl,
    path,
    lang: b.lang,
    navType: b.navType ?? null,
    effectiveType: b.effectiveType ?? null,
    proto: b.proto ?? null,
    prerendered: b.prerendered === true,
    colo: typeof cf?.colo === 'string' ? cf.colo.slice(0, 8) : null,
    country: typeof cf?.country === 'string' ? cf.country.slice(0, 2) : null,
    asn: typeof cf?.asn === 'number' && Number.isSafeInteger(cf.asn) ? cf.asn : null,
  };
  return metrics
    .filter((m): m is [Metric, number] => m[1] !== undefined)
    .map(([metric, value]) => ({ ...base, metric, value: Math.round(value * 10) / 10, rating: rate(metric, value) }));
}

export function registerRum(app: Hono<{ Bindings: Env }>, random: () => number = Math.random): void {
  app.post('/api/rum', async (c) => {
    const empty = (status: 204 | 400 | 403 | 413 | 415) => c.body(null, status);
    if (c.req.header('Sec-Fetch-Site') === 'cross-site') return empty(403);
    const type = (c.req.header('Content-Type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
    // sendBeacon(string) sends text/plain; a Blob can be application/json.
    if (type !== 'application/json' && type !== 'text/plain') return empty(415);
    const len = Number(c.req.header('Content-Length') ?? '0');
    if (len > MAX_RUM_BYTES) return empty(413);
    const buf = await c.req.raw.arrayBuffer();
    if (buf.byteLength > MAX_RUM_BYTES) return empty(413);
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf));
    } catch {
      return empty(400);
    }
    const parsed = v.safeParse(RumBeaconSchema, json);
    if (!parsed.success) return empty(400);
    const path = cleanPath(parsed.output.path);
    if (path === null) return empty(400);
    const rows = toRows(parsed.output, path, Date.now(), c.req.raw.cf as { colo?: unknown; country?: unknown; asn?: unknown } | undefined);
    if (rows.length === 0) return empty(400);

    const config = readConfig(c.env);
    if (random() >= config.rumSample) return empty(204);
    const ip = c.req.header('CF-Connecting-IP');
    const db = createDb(c.env.DB);
    c.executionCtx.waitUntil(
      (async () => {
        if (ip !== undefined && !(await c.env.RUM_RL_IP.limit({ key: ipRateKey(ip) })).success) return;
        await db.insert(rumEvents).values(rows);
      })().catch((err: unknown) => log('rum_insert_failed', { error: err instanceof Error ? err.name : 'unknown' })),
    );
    return empty(204);
  });
  app.all('/api/rum', (c) => c.body(null, 405, { Allow: 'POST' }));
}
