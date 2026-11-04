// drizzle-kit config. Paths are relative to packages/db (run from there). After a schema change:
//   cd packages/db && npx drizzle-kit generate --name <change> && npx drizzle-kit check
// Output is plain SQL in packages/db/migrations/NNNN_<name>.sql, which both drizzle-kit and
// `wrangler d1 migrations apply` read (wrangler ignores the meta/ folder).
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
