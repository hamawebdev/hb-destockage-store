// Real D1 for tests (rev-d checklist §0): workerd's D1 through wrangler's getPlatformProxy, with the
// repo migrations applied statement by statement (as `wrangler d1 migrations apply` does).
// Each call gets a fresh, private persist directory.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import type { AnyD1Database } from 'drizzle-orm/d1';
import { createDb, type Db } from '../src/index.ts';
import { MIGRATIONS_DIR, migrationFiles } from './helpers.ts';

export interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  run(): Promise<{ meta: { changes: number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface RawD1 {
  prepare(sql: string): D1Stmt;
  batch(s: D1Stmt[]): Promise<unknown[]>;
}

const configPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));

/** A fresh, empty workerd D1 (no migrations applied). */
export async function freshD1Empty(): Promise<{ d1: RawD1; db: Db; dispose: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'hb-db-test-'));
  const proxy = await getPlatformProxy<{ DB: RawD1 }>({ configPath, persist: { path: dir } });
  const d1 = proxy.env.DB;
  return {
    d1,
    db: createDb(d1 as unknown as AnyD1Database),
    dispose: async () => {
      await proxy.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A fresh workerd D1 with every repo migration applied. */
export async function freshD1(): Promise<{ d1: RawD1; db: Db; dispose: () => Promise<void> }> {
  const ctx = await freshD1Empty();
  for (const file of migrationFiles()) {
    for (const stmt of readFileSync(join(MIGRATIONS_DIR, file), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await ctx.d1.prepare(stmt).run();
    }
  }
  return ctx;
}

/** Run several statements in order (setup only). */
export async function exec(d1: RawD1, sql: string): Promise<void> {
  for (const s of sql.split(';').map((x) => x.trim()).filter(Boolean)) await d1.prepare(s).run();
}
