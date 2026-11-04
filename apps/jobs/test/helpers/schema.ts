// Applies @hb/db's SQL migrations to a local D1 binding the way `wrangler d1 migrations apply` does
// (files in name order, statements split on drizzle-kit's breakpoint) and records them in
// d1_migrations. Plus minimal fixture rows for tests that need an order.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/db/migrations');

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
}

export async function applyMigrations(db: D1Database): Promise<string[]> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`,
    )
    .run();
  const files = migrationFiles();
  for (const file of files) {
    const stmts = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s));
    await db.batch([...stmts, db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(file)]);
  }
  return files;
}

/** Inserts wilaya 16, a commune, a customer and orders with the given ids. */
export async function insertOrders(db: D1Database, ids: number[]): Promise<void> {
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO wilayas (code, name_fr, name_ar) VALUES (16, 'Alger', 'الجزائر')`),
    db.prepare(`INSERT OR IGNORE INTO communes (id, wilaya_code, name_fr, name_ar) VALUES (1601, 16, 'Alger Centre', 'الجزائر الوسطى')`),
    db.prepare(`INSERT OR IGNORE INTO customers (id, phone_e164, name) VALUES (1, '+213560417403', 'Test Client')`),
    ...ids.map((id) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO orders (id, ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang,
             subtotal_dzd, fee_dzd, total_dzd, fee_source)
           VALUES (?1, ?2, ?3, 1, 'Test Client', '+213560417403', 16, 1601, 'fr', 15000, 400, 15400, 'admin')`,
        )
        .bind(id, `HB-T${String(id).padStart(4, '0')}`, crypto.randomUUID()),
    ),
  ]);
}
