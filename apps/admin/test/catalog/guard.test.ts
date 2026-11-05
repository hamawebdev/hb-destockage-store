// The batch-aborting guard (routes/products/lib/guard.ts) on a real D1.
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { categories, createDb } from '@hb/db';
import { guard, isGuardAbort, versionGuard } from '../../src/routes/products/lib/guard.ts';
import { harness, type Harness } from '../helpers.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const auditCount = async () => (await h.db.prepare('select count(*) n from audit_log').first<{ n: number }>())!.n;

test('a guard that holds writes nothing and lets the batch apply', async () => {
  const db = createDb(h.db);
  const before = await auditCount();
  await db.batch([
    guard(db, sql`1 = 1`),
    db.insert(categories).values({ slugFr: 'g1', slugAr: 'g1', nameFr: 'G', nameAr: 'غ' }),
  ]);
  expect(await auditCount()).toBe(before);
  expect(await db.select().from(categories).where(eq(categories.slugFr, 'g1'))).toHaveLength(1);
});

test('a failing guard aborts the whole batch, including statements before it', async () => {
  const db = createDb(h.db);
  const before = await auditCount();
  const err = await db
    .batch([
      db.insert(categories).values({ slugFr: 'g2', slugAr: 'g2', nameFr: 'G', nameAr: 'غ' }),
      guard(db, sql`1 = 0`),
    ])
    .then(() => null, (e: unknown) => e);
  expect(isGuardAbort(err)).toBe(true);
  expect(await db.select().from(categories).where(eq(categories.slugFr, 'g2'))).toHaveLength(0);
  expect(await auditCount()).toBe(before);
});

test('versionGuard: current version passes, any other aborts', async () => {
  const db = createDb(h.db);
  const [row] = await db.select().from(categories).where(eq(categories.slugFr, 'g1'));
  await db.batch([versionGuard(db, 'categories', 'id', row!.id, row!.updatedAt), db.update(categories).set({ sort: 1 }).where(eq(categories.id, row!.id))]);
  const err = await db
    .batch([versionGuard(db, 'categories', 'id', row!.id, row!.updatedAt - 1), db.update(categories).set({ sort: 2 }).where(eq(categories.id, row!.id))])
    .then(() => null, (e: unknown) => e);
  expect(isGuardAbort(err)).toBe(true);
  expect((await db.select().from(categories).where(eq(categories.id, row!.id)))[0]!.sort).toBe(1);
});

test('isGuardAbort does not match other constraint errors', () => {
  expect(isGuardAbort(new Error('UNIQUE constraint failed: categories.slug_fr'))).toBe(false);
});
