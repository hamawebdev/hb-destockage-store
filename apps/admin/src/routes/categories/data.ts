/**
 * Category reads and writes (ACAT-1, plan §5). Every write is one D1 batch (a transaction) with
 * its audit row; conditional writes (optimistic concurrency, cycle guard, delete guard) carry an
 * audit row that is only inserted when the write changed exactly one row (`changes() = 1`, i.e.
 * the statement just before it in the batch).
 */
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { categories, images, products, type Category } from '@hb/db';
import { audit } from '../../audit/audit.ts';
import type { AppEnv } from '../../env.ts';
import { bumpUpdatedAt, changedFields } from '../products/lib/diff.ts';
import { deleteUnreferencedMedia } from '../products/lib/r2.ts';
import { descendantIds } from './tree.ts';
import type { CategoryRow } from './validate.ts';

type Ctx = Context<AppEnv>;

/** Audit only if the previous statement in the batch changed exactly one row. */
const ONE_ROW_CHANGED = sql`changes() = 1`;

export async function loadCategories(c: Ctx): Promise<Category[]> {
  return c.var.db.select().from(categories).orderBy(asc(categories.sort), asc(categories.id));
}

export async function loadCategory(c: Ctx, id: number): Promise<Category | undefined> {
  const rows = await c.var.db.select().from(categories).where(eq(categories.id, id)).limit(1);
  return rows[0];
}

export interface ProductCounts {
  total: number;
  active: number;
}

/** Products per category id (direct children only). */
export async function productCounts(c: Ctx): Promise<Map<number, ProductCounts>> {
  const rows = await c.var.db
    .select({ categoryId: products.categoryId, status: products.status, n: count() })
    .from(products)
    .groupBy(products.categoryId, products.status);
  const out = new Map<number, ProductCounts>();
  for (const r of rows) {
    const cur = out.get(r.categoryId) ?? { total: 0, active: 0 };
    cur.total += r.n;
    if (r.status === 'active') cur.active += r.n;
    out.set(r.categoryId, cur);
  }
  return out;
}

/** Active products in the category and all its descendants (they leave the storefront on archive). */
export function activeProductsInSubtree(all: readonly Category[], counts: Map<number, ProductCounts>, id: number): number {
  let n = 0;
  for (const cid of descendantIds(all, id)) n += counts.get(cid)?.active ?? 0;
  return n;
}

/** Plain snapshot for the audit log (no timestamps). */
export function snapshot(row: Category | CategoryRow): CategoryRow {
  return {
    nameFr: row.nameFr,
    nameAr: row.nameAr,
    descriptionFr: row.descriptionFr,
    descriptionAr: row.descriptionAr,
    slugFr: row.slugFr,
    slugAr: row.slugAr,
    parentId: row.parentId,
    sort: row.sort,
    active: row.active,
    placeholder: row.placeholder,
    translationPlaceholder: [...row.translationPlaceholder],
  };
}

/** Inserts the category and its audit row in one batch; returns the new id. */
export async function createCategory(c: Ctx, row: CategoryRow): Promise<number> {
  const db = c.var.db;
  const [inserted] = await db.batch([
    db.insert(categories).values(row).returning({ id: categories.id }),
    audit(c, {
      action: 'category.create',
      entity: 'categories',
      entityId: sql`(select id from categories where slug_fr = ${row.slugFr})`,
      before: null,
      after: row,
    }),
  ]);
  const id = inserted[0]?.id;
  if (id === undefined) throw new Error('createCategory: no id returned');
  return id;
}

export type UpdateOutcome = 'updated' | 'unchanged' | 'conflict';

/**
 * Conditional update: only if `updated_at` still equals the version the form was rendered with,
 * and the new parent is not the category itself or one of its descendants (checked in SQL with a
 * recursive CTE, so two concurrent moves cannot create a cycle).
 */
export async function updateCategory(c: Ctx, before: Category, version: number, row: CategoryRow): Promise<UpdateOutcome> {
  const diff = changedFields(snapshot(before), row);
  if (diff === null) return 'unchanged';
  const db = c.var.db;
  const id = before.id;
  const notInSubtree =
    row.parentId === null
      ? sql`1`
      : sql`${row.parentId} not in (with recursive d(id) as (select ${id} union all select k.id from categories k join d on k.parent_id = d.id) select id from d)`;
  const [result] = await db.batch([
    db
      .update(categories)
      .set({ ...row, updatedAt: bumpUpdatedAt() })
      .where(and(eq(categories.id, id), eq(categories.updatedAt, version), notInSubtree)),
    audit(c, { action: 'category.update', entity: 'categories', entityId: id, ...diff }, { when: ONE_ROW_CHANGED }),
  ]);
  return changesOf(result) === 1 ? 'updated' : 'conflict';
}

/** Archive (`active = 0`) or restore (`active = 1`). No-op when already in that state. */
export async function setCategoryActive(c: Ctx, id: number, active: boolean): Promise<boolean> {
  const db = c.var.db;
  const [result] = await db.batch([
    db
      .update(categories)
      .set({ active, updatedAt: bumpUpdatedAt() })
      .where(and(eq(categories.id, id), eq(categories.active, !active))),
    audit(
      c,
      {
        action: active ? 'category.restore' : 'category.archive',
        entity: 'categories',
        entityId: id,
        before: { active: !active },
        after: { active },
      },
      { when: ONE_ROW_CHANGED },
    ),
  ]);
  return changesOf(result) === 1;
}

/**
 * Deletes a category that has no products and no sub-categories (guard inside the DELETE, so a
 * product added meanwhile still blocks it). Its images go with it (FK cascade); their R2 objects
 * are removed afterwards when no other image row references the key.
 */
export async function deleteCategory(c: Ctx, before: Category): Promise<boolean> {
  const db = c.var.db;
  const id = before.id;
  const keys = (await db.select({ key: images.r2Key }).from(images).where(eq(images.categoryId, id))).map((r) => r.key);
  const [result] = await db.batch([
    db
      .delete(categories)
      .where(
        and(
          eq(categories.id, id),
          sql`not exists (select 1 from products where category_id = ${id})`,
          sql`not exists (select 1 from categories k where k.parent_id = ${id})`,
        ),
      ),
    audit(
      c,
      { action: 'category.delete', entity: 'categories', entityId: id, before: { ...snapshot(before), imageKeys: keys }, after: null },
      { when: ONE_ROW_CHANGED },
    ),
  ]);
  if (changesOf(result) !== 1) return false;
  await deleteUnreferencedMedia(c, keys);
  return true;
}

/** Ids of categories using `slug` in `lang`, for the uniqueness pre-check. */
export async function slugOwners(c: Ctx, lang: 'fr' | 'ar', slugs: readonly string[]): Promise<{ id: number; slug: string }[]> {
  if (slugs.length === 0) return [];
  const col = lang === 'fr' ? categories.slugFr : categories.slugAr;
  return c.var.db.select({ id: categories.id, slug: col }).from(categories).where(inArray(col, [...slugs]));
}

function changesOf(result: unknown): number {
  const meta = (result as { meta?: { changes?: number } } | undefined)?.meta;
  return meta?.changes ?? 0;
}
