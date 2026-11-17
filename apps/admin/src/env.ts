// Worker bindings, Hono generics and environment validation for the admin Worker.
// Owner: admin-core (ADMIN-1 contract). Other admin builders import `AppEnv` and nothing else
// from here.

import * as v from 'valibot';
import type { AdminUser, Db, DbAdminRole } from '@hb/db';
import type { Lang, Translator } from './i18n/index.ts';

/** Runtime environment. Defaults to `production` in wrangler.jsonc (fail-safe). */
export type RuntimeEnv = 'production' | 'development' | 'test';

/** Bindings and vars declared in `apps/admin/wrangler.jsonc` (secrets via `.dev.vars` / `wrangler secret`). */
export interface Env {
  /** Shared D1 database (same database as `apps/web`). */
  DB: D1Database;
  /** Product media (R2). */
  MEDIA: R2Bucket;
  /** Workers static assets (`public/`), fetched by the Worker after auth (`run_worker_first`). */
  ASSETS: Fetcher;
  ENV: RuntimeEnv;
  /** `https://<team>.cloudflareaccess.com` — exact JWT `iss`. */
  ACCESS_TEAM_DOMAIN: string;
  /** Access application AUD tag. */
  ACCESS_AUD: string;
  /** HMAC key for CSRF tokens (secret, ≥ 32 chars). */
  CSRF_SECRET: string;
  /** HMAC key for the dev-login cookie. Development only; absent in production. */
  DEV_SESSION_SECRET?: string;
  /** 32 random bytes, base64 (secret). Seals courier keys. Unset or invalid = couriers off, the admin still works. */
  COURIER_KEYS_KEY?: string;
  /** Local courier stand-in. Honoured only when ENV is not `production`. */
  COURIER_STANDIN_URL?: string;

  // Google Sheets (SHEET-3). All optional: the feature stays off until they and COURIER_KEYS_KEY are set.
  /** Secret. */
  GOOGLE_CLIENT_ID?: string;
  /** Secret. */
  GOOGLE_CLIENT_SECRET?: string;
  /** The admin's `/sheets/callback`, registered at Google. Fixed config, never derived from the request. */
  GOOGLE_REDIRECT_URI?: string;
  /** Non-production only: loopback stand-in base URL. Ignored in production. */
  GOOGLE_STANDIN_URL?: string;

  /**
   * 32 random bytes, base64 (secret; D-017). Seals the Meta access token stored in `settings`
   * (`metaAccessTokenEnc`). Shared with hb-web, which opens it at send time. Unset or invalid: the
   * Meta screen refuses to save a token; everything else works.
   */
  SETTINGS_ENCRYPTION_KEY?: string;

  /**
   * Telegram order messages (TGS-4). Non-production only: loopback stand-in base URL
   * (`http://127.0.0.1:<port>`). Ignored in production, where the Bot API address is fixed. The bot
   * token itself is entered on /telegram and sealed with COURIER_KEYS_KEY; it is never an env value.
   */
  TELEGRAM_STANDIN_URL?: string;

  /**
   * GitHub fine-grained token (secret; D-028), limited to this repository with "Actions: read and write".
   * /publish uses it to start the pipeline's `publish` mode and to list its runs. Unset: the page explains
   * that publishing from the admin is not enabled; everything else works.
   */
  GITHUB_PUBLISH_TOKEN?: string;
}

export type Role = DbAdminRole;

/** The authenticated admin, as handlers see it. */
export interface CurrentUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  uiLang: Lang;
}

export function toCurrentUser(row: Pick<AdminUser, 'id' | 'email' | 'name' | 'role' | 'uiLang'>): CurrentUser {
  return { id: row.id, email: row.email, name: row.name, role: row.role, uiLang: row.uiLang };
}

/** Per-request variables (`c.var.*`). */
export interface Variables {
  requestId: string;
  db: Db;
  user: CurrentUser;
  lang: Lang;
  dir: 'ltr' | 'rtl';
  t: Translator;
  csrfToken: string;
  /** Set by `requireRole`. `roleGuard` turns a response without it into a 500. */
  roleChecked: boolean;
  /** Set by `audit()` / `withAudit()` / `noAudit()`. `auditGuard` (ADMIN-3) enforces it on POST. */
  audited: boolean;
}

/** Hono generics for every admin router: `new Hono<AppEnv>()` (use `createRouter`). */
export interface AppEnv {
  Bindings: Env;
  Variables: Variables;
}

const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));

const EnvSchema = v.variant('ENV', [
  v.object({
    ENV: v.literal('production'),
    ACCESS_TEAM_DOMAIN: v.pipe(nonEmpty, v.regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/)),
    ACCESS_AUD: v.pipe(nonEmpty, v.regex(/^[a-f0-9]{64}$/)),
    CSRF_SECRET: v.pipe(v.string(), v.minLength(32)),
  }),
  v.object({
    ENV: v.picklist(['development', 'test']),
    ACCESS_TEAM_DOMAIN: v.optional(v.string()),
    ACCESS_AUD: v.optional(v.string()),
    CSRF_SECRET: v.pipe(v.string(), v.minLength(32)),
  }),
]);

/**
 * Validates the configuration. Returns the list of problems (empty = valid). Values are never
 * echoed, only the names of the offending keys.
 */
export function checkEnv(env: Partial<Env>): string[] {
  const r = v.safeParse(EnvSchema, env);
  if (r.success) return [];
  return [...new Set(r.issues.map((i) => v.getDotPath(i) ?? 'ENV'))];
}
