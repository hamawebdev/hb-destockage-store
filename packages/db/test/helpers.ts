// Test helpers: apply the SQL migrations to an empty SQLite database exactly as
// `wrangler d1 migrations apply` does (files in name order, statements split on drizzle-kit's
// breakpoint marker), with foreign keys ON as in D1.
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../src/schema.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
}

export function applyMigrations(sqlite: Database.Database): string[] {
  const applied: string[] = [];
  for (const file of migrationFiles()) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const stmt of text.split('--> statement-breakpoint')) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
    applied.push(file);
  }
  return applied;
}

export function freshDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
