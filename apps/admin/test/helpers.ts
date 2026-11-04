// Test harness: a real D1 (wrangler getPlatformProxy, in-memory) with the real migrations from packages/db,
// seeded admin users, and the admin app with an injectable identity provider.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy, type PlatformProxy } from 'wrangler';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import type { IdentifyFn } from '../src/auth/authenticate.ts';
import type { AppEnv, Env } from '../src/env.ts';

const WRANGLER_CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);
const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url).href);

export const USERS = {
  owner: 'owner@test.local',
  confirmer: 'confirmer@test.local',
  logistics: 'logistics@test.local',
  content: 'content@test.local',
  inactive: 'inactive@test.local',
  ownerAr: 'owner-ar@test.local',
} as const;

export const TEST_USER_HEADER = 'x-test-user';

/** Test identity provider: trusts a test header. Only ever passed to createApp() in tests. */
export const testIdentify: IdentifyFn = async (c) => {
  const email = c.req.header(TEST_USER_HEADER);
  return email ? { ok: true, email } : { ok: false, status: 401 };
};

export interface Harness {
  proxy: PlatformProxy<Env>;
  db: D1Database;
  env: Env;
  app: Hono<AppEnv>;
  /** Request as a user (by email); `init.headers` merged. */
  as: (email: string | null, path: string, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

export async function migrate(db: D1Database): Promise<void> {
  for (const file of readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()) {
    const text = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const stmt of text.split('--> statement-breakpoint')) {
      if (stmt.trim()) await db.prepare(stmt).run();
    }
  }
}

export async function seedUsers(db: D1Database): Promise<void> {
  const rows: [string, string, string, number, string][] = [
    [USERS.owner, 'Owner', 'owner', 1, 'fr'],
    [USERS.confirmer, 'Confirmer', 'confirmer', 1, 'fr'],
    [USERS.logistics, 'Logistics', 'logistics', 1, 'fr'],
    [USERS.content, 'Content', 'content', 1, 'fr'],
    [USERS.inactive, 'Inactive', 'owner', 0, 'fr'],
    [USERS.ownerAr, 'مالك', 'owner', 1, 'ar'],
  ];
  await db.batch(
    rows.map((r) => db.prepare('insert into admin_users (email, name, role, active, ui_lang) values (?, ?, ?, ?, ?)').bind(...r)),
  );
}

export const CSRF_SECRET = 'test-csrf-secret-0123456789abcdef0123456789';

export function testEnv(db: D1Database, over: Partial<Env> = {}): Env {
  return {
    DB: db,
    MEDIA: {} as R2Bucket,
    ASSETS: {
      fetch: async (req: Request | string) => {
        const url = new URL(typeof req === 'string' ? req : req.url);
        return new Response(`/* asset ${url.pathname} */`, { headers: { 'Content-Type': 'text/css', ETag: '"x"' } });
      },
    } as unknown as Fetcher,
    ENV: 'test',
    ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com',
    ACCESS_AUD: 'a'.repeat(64),
    CSRF_SECRET,
    ...over,
  };
}

export async function harness(identify: IdentifyFn = testIdentify): Promise<Harness> {
  // Bindings from the real wrangler.jsonc, in memory (persist: false), via wrangler's Miniflare.
  const proxy = await getPlatformProxy<Env>({ configPath: WRANGLER_CONFIG, persist: false });
  const db = proxy.env.DB;
  await migrate(db);
  await seedUsers(db);
  const env = testEnv(db);
  const app = createApp({ identify });
  const as = (email: string | null, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (email) headers.set(TEST_USER_HEADER, email);
    return Promise.resolve(app.request(path, { ...init, headers }, env));
  };
  return { proxy, db, env, app, as, close: () => proxy.dispose() };
}

/** Pulls the CSRF token out of a rendered page. */
export function csrfFrom(html: string): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('no _csrf in page');
  return m[1]!;
}

/** A same-origin urlencoded POST. */
export function form(data: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' },
    body: new URLSearchParams(data).toString(),
  };
}
