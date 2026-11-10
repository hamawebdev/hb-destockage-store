/**
 * Meta Conversions API sender (META-0 contract §2, §4; MSET-3, D-017). One Purchase per newly created
 * order, in waitUntil, only with the visitor's consent signal from a page that carried the Pixel.
 * Credentials come from D1 at send time (admin → `settings`, @hb/db/meta-settings): the Pixel ID, the
 * sealed access token (opened with SETTINGS_ENCRYPTION_KEY) and the optional test event code.
 * Nothing here may throw into the order path. The access token goes in the JSON body, never the URL,
 * and never reaches a log line.
 */
import { importSettingsKey, openMetaToken, readMetaServerSettings, type MetaServerSettings, type SettingsReader } from '@hb/db/meta-settings';
import { buildPurchaseEvent, type MetaPurchaseEvent, type MetaSignals, type Lang, type PhoneE164 } from '@hb/shared';
import type { Env } from '../env.ts';
import { log } from '../http.ts';

export const GRAPH_ORIGIN = 'https://graph.facebook.com';
/** Confirm against Meta's current version at go-live (docs/META-GO-LIVE.md). */
export const GRAPH_VERSION = 'v25.0';
export const META_TIMEOUT_MS = 1500;
const META_ATTEMPTS = 2;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type MetaConfig =
  | { readonly on: false; readonly reason: MetaOffReason }
  | {
      readonly on: true;
      readonly eventsUrl: string;
      readonly token: string;
      readonly testEventCode?: string;
      readonly siteHost: string;
    };

/** Why no server event is sent. Logged as `skipped`; never a value. */
export type MetaOffReason = 'no_pixel' | 'pixel_mismatch' | 'no_token' | 'no_key' | 'token_unreadable' | 'no_graph_origin' | 'no_site_host';

const off = (reason: MetaOffReason): MetaConfig => ({ on: false, reason });

/** Where events go: Meta in production, and outside it only a loopback stand-in. Null = server events off. */
export function graphOrigin(env: Pick<Env, 'ENV' | 'CAPI_STANDIN_URL'>): string | null {
  if (env.ENV === 'production') return GRAPH_ORIGIN;
  const base = env.CAPI_STANDIN_URL;
  if (base === undefined || base === '') return null;
  try {
    const url = new URL(base);
    return LOOPBACK_HOSTS.has(url.hostname) && (url.protocol === 'http:' || url.protocol === 'https:') ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Server-side Meta settings for one send. Never throws: anything unusable means server events off.
 * `pagePixel` is the Pixel ID the order's page carried (from the consent signal); it must equal the
 * stored one, so a page built without Meta, or with another Pixel, never causes a server event.
 */
export async function readMetaConfig(
  env: Pick<Env, 'ENV' | 'CAPI_STANDIN_URL' | 'SETTINGS_ENCRYPTION_KEY'>,
  stored: MetaServerSettings,
  pagePixel: string,
  siteHost: string | undefined,
): Promise<MetaConfig> {
  if (stored.pixelId === null) return off('no_pixel');
  if (pagePixel !== stored.pixelId) return off('pixel_mismatch');
  if (stored.tokenEnc === null) return off('no_token');
  const origin = graphOrigin(env);
  if (origin === null) return off('no_graph_origin');
  if (siteHost === undefined) return off('no_site_host');
  let key;
  try {
    key = await importSettingsKey(env.SETTINGS_ENCRYPTION_KEY);
  } catch {
    return off('no_key');
  }
  let token: string;
  try {
    token = await openMetaToken(key, stored.tokenEnc);
  } catch {
    return off('token_unreadable');
  }
  return {
    on: true,
    eventsUrl: `${origin}/${GRAPH_VERSION}/${stored.pixelId}/events`,
    token,
    siteHost,
    ...(stored.testEventCode === null ? {} : { testEventCode: stored.testEventCode }),
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

/**
 * The whole server send for one created order, for waitUntil. Reads the settings from D1 here (one
 * statement), after the order has been answered. Never rejects.
 */
export async function sendMetaPurchase(
  env: Pick<Env, 'ENV' | 'CAPI_STANDIN_URL' | 'SETTINGS_ENCRYPTION_KEY'> & { readonly DB: SettingsReader },
  siteHost: string | undefined,
  order: { readonly ref: string; readonly createdAtMs: number; readonly totalDzd: number },
  ctx: MetaOrderContext,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  try {
    const stored = await readMetaServerSettings(env.DB);
    const cfg = await readMetaConfig(env, stored, ctx.signals.pixel, siteHost);
    if (!cfg.on) {
      log('meta_capi', { ref: order.ref, skipped: cfg.reason });
      return;
    }
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
