// Starts the real Worker in workerd (wrangler test harness, env "test"), applies db's migrations
// to the harness's local D1 and loads the fixture catalogue.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHarness, type TestHarness } from 'wrangler';
import type { Env } from '../../src/env.ts';
import { SEED_SQL } from './seed.ts';

export const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface Started {
  readonly server: TestHarness;
  readonly env: Env;
}

/** Test-only secrets (never real values). */
export const TEST_SECRETS = { ORDER_SIGNING_KEY: 'test-signing-key', IP_HASH_KEY: 'test-ip-salt' } as const;

export async function startSeeded(secrets: Record<string, string> = TEST_SECRETS): Promise<Started> {
  const server = createTestHarness({ root: WEB_ROOT, workers: [{ configPath: './wrangler.jsonc', env: 'test', secrets }] });
  await server.listen();
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations('DB');
  const env = await worker.getEnv();
  await env.DB.batch(SEED_SQL.map((s) => env.DB.prepare(s)));
  return { server, env };
}

export function postForm(server: TestHarness, path: string, fields: Record<string, string> | [string, string][], headers: Record<string, string> = {}): ReturnType<TestHarness['fetch']> {
  return server.fetch(path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

export function postJson(
  server: TestHarness,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): ReturnType<TestHarness['fetch']> {
  return server.fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
