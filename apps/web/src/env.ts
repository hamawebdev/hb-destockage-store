/**
 * Bindings and vars of the storefront Worker (`wrangler.jsonc`). Plan: artifacts/WEB-0/plan.md §1.1.
 * Secrets are optional in the type: a missing secret degrades a layer (e.g. Turnstile ⇒ flagged),
 * it never takes the order path down.
 */
export type EnvName = 'development' | 'test' | 'production';

export interface Env {
  /** Workers static assets (the Astro build). */
  readonly ASSETS: Fetcher;
  /** The one D1 database (location hint weur). Read only on POST /api/* — never for a page view. */
  readonly DB: D1Database;
  /** `order.created` producer; consumer is apps/jobs. Message type: `@hb/shared` messages.ts. */
  readonly ORDERS: Queue<unknown>;
  /** Primary order rate limit, keyed on the normalised E.164 phone. Over limit ⇒ 429. */
  readonly ORDER_RL_PHONE: RateLimit;
  /** Secondary order rate limit, keyed on the IP (/64 for IPv6). Over limit ⇒ flag only. */
  readonly ORDER_RL_IP: RateLimit;
  /** RUM flood guard, keyed on the IP (/64): over the limit a beacon is dropped (still 204). */
  readonly RUM_RL_IP: RateLimit;

  readonly ENV: string;
  /** Comma-separated hostnames accepted in a Turnstile verdict. */
  readonly SITE_HOSTS: string;
  readonly MIN_FILL_MS: string;
  readonly MIN_REVIEW_MS: string;
  readonly RUM_SAMPLE: string;

  readonly TURNSTILE_SECRET?: string;
  readonly ORDER_SIGNING_KEY?: string;
  readonly IP_HASH_KEY?: string;

  /**
   * 32 random bytes, base64 (secret; D-017). Opens the Meta access token the admin stores sealed in
   * `settings` (`metaAccessTokenEnc`). Meta's Pixel ID, token and test event code are read from D1 at
   * send time, never from the environment. Unset or invalid: no server event, nothing else changes.
   */
  readonly SETTINGS_ENCRYPTION_KEY?: string;
  /** Local stand-in for Meta's Graph API. Ignored in production; outside it, only a loopback URL is used. */
  readonly CAPI_STANDIN_URL?: string;
}

export interface Config {
  readonly env: EnvName;
  readonly siteHosts: readonly string[];
  readonly minFillMs: number;
  readonly minReviewMs: number;
  /** 0–1 share of RUM beacons stored. */
  readonly rumSample: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const ENV_NAMES: readonly EnvName[] = ['development', 'test', 'production'];
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function intVar(name: string, raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name} must be in [${min}, ${max}]`);
  return n;
}

/**
 * Parses and validates the vars. Throws `ConfigError` on a bad value (fail loudly, not silently).
 * Messages name the variable, never its value (they reach the log line).
 */
export function readConfig(env: Env): Config {
  if (!ENV_NAMES.includes(env.ENV as EnvName)) {
    throw new ConfigError(`ENV must be one of ${ENV_NAMES.join('|')}`);
  }
  const siteHosts = String(env.SITE_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
  if (siteHosts.length === 0) throw new ConfigError('SITE_HOSTS must list at least one hostname');
  if (siteHosts.some((h) => !HOSTNAME_RE.test(h))) throw new ConfigError('SITE_HOSTS must be a comma-separated list of hostnames');
  // Production must name the real storefront: a local hostname would make every real Turnstile
  // verdict fail the hostname check and flag every order (rev-d, WEB-2 r2).
  if (env.ENV === 'production' && siteHosts.some((h) => LOCAL_HOSTS.has(h))) {
    throw new ConfigError('SITE_HOSTS must not contain a local hostname in production');
  }
  const rumSample = Number(env.RUM_SAMPLE);
  if (!Number.isFinite(rumSample) || rumSample < 0 || rumSample > 1) {
    throw new ConfigError('RUM_SAMPLE must be a number in [0, 1]');
  }
  return {
    env: env.ENV as EnvName,
    siteHosts,
    minFillMs: intVar('MIN_FILL_MS', String(env.MIN_FILL_MS), 0, 60_000),
    minReviewMs: intVar('MIN_REVIEW_MS', String(env.MIN_REVIEW_MS), 0, 60_000),
    rumSample,
  };
}
