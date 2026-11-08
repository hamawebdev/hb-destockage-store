# @hb/db

Drizzle schema, D1 migrations, local seed and the order/fee write paths for the single D1 database
(`hb-destockage`, location hint `weur`). Owner: `db`. Reviewer: `rev-d`.

| Module | What |
|---|---|
| `src/schema.ts`, `src/enums.ts` | Schema contract (DB-1). Statuses, roles and langs are re-exported from `@hb/shared`. |
| `migrations/` | SQL migrations, applied in name order by `wrangler d1 migrations apply` (and by the tests). |
| `src/seed/` | `npm run seed -w @hb/db`: local-only seed of `data/` + photos (DB-3). |
| `src/orders.ts` | `createOrder`, dedup, version-guarded order changes (DB-4). |
| `src/fees.ts` (`@hb/db/fees`) | Admin-table `FeeProvider` (DB-6). |
| `src/order-contact.ts` | `updateOrderContact` (DB-6). |

## Local database (one per worktree)

D1 binding `DB`, `database_name` `hb-destockage`, local `database_id`
`00000000-0000-4000-8000-000000000d1b`, R2 binding `MEDIA` (`hb-media`), state in
`<worktree>/.wrangler/hb-local` (`--persist-to ../../.wrangler/hb-local` from `apps/*` and
`packages/db`). Details: `wrangler.jsonc`.

```sh
npm run migrate:local -w @hb/db   # migrations only
npm run seed -w @hb/db            # migrations + data/ + dev admin users + photos (refuses any non-local target)
```

## Rules for every migration

1. **Generate, then review the SQL by hand.** `cd packages/db && npx drizzle-kit generate --name <change>`,
   then read every line of the new file before committing. drizzle-kit 0.31 has produced wrong SQL here:
   - **Table rebuilds can copy a column the old table does not have** (`INSERT INTO __new_t ("x") SELECT "x" FROM t`).
     better-sqlite3 rejects it. **D1 silently stores the string `'x'` in every row**, because an unknown
     double-quoted identifier falls back to a string literal. This happened in 0006 and was fixed by hand.
   - `ADD COLUMN … REFERENCES` loses its `ON DELETE` action (0003, fixed by hand).
   - Rebuilds use `PRAGMA foreign_keys=OFF/ON`, which cannot take effect inside the transaction D1 runs a
     migration in. Use `PRAGMA defer_foreign_keys = on` / `off` (0006).
2. **Never edit an applied migration.** Add a new one. Consumers and reviewers have already applied it.
3. **Prefer triggers to new CHECKs on existing tables**: adding a CHECK means a table rebuild. Triggers
   live in hand-written migrations (`npx drizzle-kit generate --custom --name <change>`).
4. **D1 limits**: LIKE/GLOB patterns over about 50 bytes fail with "pattern too complex". Use a negated
   class or `substr`/`instr`.
5. `npm test -w @hb/db` must stay green. `test/migrations.test.ts` checks every migration step by step:
   - copies name only existing columns;
   - after each step the schema equals drizzle-kit's snapshot;
   - with data loaded at 0000, no text cell ends up equal to a column name, on SQLite **and** on workerd D1.
   Also run `npx drizzle-kit check` and `npx drizzle-kit generate` (it must say "No schema changes").

## Stock

- `createOrder` takes stock only from tracked variants (`stock IS NOT NULL`), and records it per line in
  `order_items.stock_taken` (qty, or 0 when untracked). A cancel or return adds back exactly
  `stock_taken`, once (`orders.stock_restored_at`), and only to a variant that is still tracked.
- Any future path that changes an order line's qty or variant must adjust `stock_taken` and the
  variant's stock in the same version-guarded batch. No such path exists in v1 (no line editing).

## Writing batches (D1)

- Every item in `db.batch([...])` must be a Drizzle **query builder** (`db.insert/update/select/delete`).
  In drizzle-orm 0.45, a raw `db.run(sql`…${param}`)` item throws "Cannot read properties of undefined
  (reading 'bind')" inside a D1 batch (`test/orders.test.ts` documents it).
- For a row that is written only if the order is still at version `v`, use
  `guardedInsertSelect(db, table, { column_name: value }, sql`FROM orders WHERE id = ${id} AND version = ${v}`)`
  and `orderGuard(id, v)`.
- Tests that depend on D1 semantics (batches, constraint messages, races) run on workerd through
  `wrangler getPlatformProxy` (`test/d1.ts`). Schema-only tests use better-sqlite3.
