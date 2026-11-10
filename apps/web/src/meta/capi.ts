/**
 * Meta Conversions API sender (META-0 contract §2, §4). One Purchase per newly created order, in
 * waitUntil, only with the visitor's consent signal. Nothing here may throw into the order path.
 * The access token goes in the JSON body, never the URL, and never reaches a log line.
 */
import { buildPurchaseEvent, type MetaPurchaseEvent, type MetaSignals, type Lang, type PhoneE164 } from '@hb/shared';
import type { Env } from '../env.ts';
import { log } from '../http.ts';

export const GRAPH_ORIGIN = 'https://graph.facebook.com';
/** Confirm against Meta's current version at go-live (docs/META-GO-LIVE.md). */
export const GRAPH_VERSION = 'v25.0';
export const META_TIMEOUT_MS = 1500;
const META_ATTEMPTS = 2;

const PIXEL_ID_RE = /^\d{15,16}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type MetaConfig =
  | { readonly on: false }
  | {
      readonly on: true;
      readonly eventsUrl: string;
      readonly token: string;
      readonly testEventCode?: string;
      readonly siteHost: string;
    };

const OFF: MetaConfig = { on: false };

/** Where events go: Meta in production, and outside it only a loopback stand-in. Null = server events off. */
function graphOrigin(env: Pick<Env, 'ENV' | 'META_GRAPH_BASE'>): string | null {
  if (env.ENV === 'production') return GRAPH_ORIGIN;
  const base = env.META_GRAPH_BASE;
  if (base === undefined || base === '') return null;
  try {
    const url = new URL(base);
    return LOOPBACK_HOSTS.has(url.hostname) && (url.protocol === 'http:' || url.protocol === 'https:') ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Server-side Meta settings. Never throws: anything unusable means server events off, so a bad
 * Meta value can never take /api/* down. Log lines name variables, never values.
 */
export function readMetaConfig(env: Pick<Env, 'ENV' | 'META_PIXEL_ID' | 'META_ACCESS_TOKEN' | 'META_TEST_EVENT_CODE' | 'META_GRAPH_BASE'>, siteHost: string | undefined): MetaConfig {
  const pixelId = env.META_PIXEL_ID ?? '';
  const token = env.META_ACCESS_TOKEN ?? '';
  if (pixelId === '' || token === '') return OFF;
  if (!PIXEL_ID_RE.test(pixelId)) {
    log('meta_config_invalid', { variable: 'META_PIXEL_ID' });
    return OFF;
  }
  const origin = graphOrigin(env);
  if (origin === null) {
    log('meta_config_invalid', { variable: 'META_GRAPH_BASE' });
    return OFF;
  }
  if (siteHost === undefined) return OFF;
  const testEventCode = env.META_TEST_EVENT_CODE;
  return {
    on: true,
    eventsUrl: `${origin}/${GRAPH_VERSION}/${pixelId}/events`,
    token,
    siteHost,
    ...(testEventCode ? { testEventCode } : {}),
  };
}

type FetchFn = typeof fetch;

/** POSTs one event: one retry on a network error, timeout or 5xx, none on 4xx. Never throws. */
export async function sendPurchase(cfg: Extract<MetaConfig, { on: true }>, event: MetaPurchaseEvent, fetchFn: FetchFn = fetch): Promise<void> {
  const ref = event.event_id;
  const body = JSON.stringify({
    data: [event],
    access_token: cfg.token,
    ...(cfg.testEventCode === undefined ? {} : { test_event_code: cfg.testEventCode }),
  });
  for (let attempt = 1; attempt <= META_ATTEMPTS; attempt++) {
    try {
      const res = await fetchFn(cfg.eventsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(META_TIMEOUT_MS),
      });
      await res.body?.cancel();
      log('meta_capi', { ref, status: res.status, attempt });
      if (res.status < 500) return;
    } catch (err) {
      log('meta_capi', { ref, attempt, error: err instanceof Error ? err.name : 'unknown' });
    }
  }
}

export interface MetaOrderContext {
  readonly signals: MetaSignals;
  readonly lang: Lang;
  readonly phoneE164: PhoneE164;
  readonly items: readonly { readonly variantId: number; readonly qty: number }[];
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** The whole server send for one created order, for waitUntil. Never rejects. */
export async function sendMetaPurchase(
  env: Pick<Env, 'ENV' | 'META_PIXEL_ID' | 'META_ACCESS_TOKEN' | 'META_TEST_EVENT_CODE' | 'META_GRAPH_BASE'>,
  siteHost: string | undefined,
  order: { readonly ref: string; readonly createdAtMs: number; readonly totalDzd: number },
  ctx: MetaOrderContext,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  try {
    const cfg = readMetaConfig(env, siteHost);
    if (!cfg.on) return;
    const event = await buildPurchaseEvent({ ...order, ...ctx, siteHost: cfg.siteHost });
    if (event === null) {
      log('meta_capi', { ref: order.ref, skipped: 'no_user_agent' });
      return;
    }
    await sendPurchase(cfg, event, fetchFn);
  } catch (err) {
    log('meta_capi', { ref: order.ref, error: err instanceof Error ? err.name : 'unknown' });
  }
}
