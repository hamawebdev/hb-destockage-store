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

  readonly ENV: string;
  /** Comma-separated hostnames accepted in a Turnstile verdict. */
  readonly SITE_HOSTS: string;
  readonly MIN_FILL_MS: string;
  readonly MIN_REVIEW_MS: string;
  readonly RUM_SAMPLE: string;

  readonly TURNSTILE_SECRET?: string;
  readonly ORDER_SIGNING_KEY?: string;
  readonly IP_HASH_KEY?: string;
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

function intVar(name: string, raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name} must be in [${min}, ${max}], got ${n}`);
  return n;
}

/** Parses and validates the vars. Throws `ConfigError` on a bad value (fail loudly, not silently). */
export function readConfig(env: Env): Config {
  if (!ENV_NAMES.includes(env.ENV as EnvName)) {
    throw new ConfigError(`ENV must be one of ${ENV_NAMES.join('|')}, got ${JSON.stringify(env.ENV)}`);
  }
  const siteHosts = String(env.SITE_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
  if (siteHosts.length === 0) throw new ConfigError('SITE_HOSTS must list at least one hostname');
  const rumSample = Number(env.RUM_SAMPLE);
  if (!Number.isFinite(rumSample) || rumSample < 0 || rumSample > 1) {
    throw new ConfigError(`RUM_SAMPLE must be a number in [0, 1], got ${JSON.stringify(env.RUM_SAMPLE)}`);
  }
  return {
    env: env.ENV as EnvName,
    siteHosts,
    minFillMs: intVar('MIN_FILL_MS', String(env.MIN_FILL_MS), 0, 60_000),
    minReviewMs: intVar('MIN_REVIEW_MS', String(env.MIN_REVIEW_MS), 0, 60_000),
    rumSample,
  };
}
