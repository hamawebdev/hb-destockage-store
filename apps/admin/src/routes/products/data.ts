/**
 * Product reads and writes (ACAT-2, plan §4). Each write is one D1 batch: guards first (they abort
 * the batch when the state the form was rendered with no longer holds, lib/guard.ts), then the
 * writes, then the audit row(s).
 */
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Context } from 'hono';
import {
  categories,
  images,
  optionValues,
  orderItems,
  packItems,
  productOptions,
  products,
  variantOptionValues,
  variants,
  type Category,
  type Image,
  type OptionValue,
  type Product,
  type ProductOption,
  type Variant,
} from '@hb/db';
import { checkProductIntegrity, type ProductKind, type SnapshotProduct } from '@hb/catalog';
import { audit } from '../../audit/audit.ts';
import type { AppEnv } from '../../env.ts';
import { bumpUpdatedAt, changedFields } from './lib/diff.ts';
import { guard, versionGuard } from './lib/guard.ts';
import type { MatrixPlan } from './lib/matrix.ts';
import { deleteUnreferencedMedia } from './lib/r2.ts';
import type { DraftOption, GridRow, ProductRow } from './validate.ts';

type Ctx = Context<AppEnv>;
type Batch = BatchItem<'sqlite'>[];

const run = async (c: Ctx, items: Batch): Promise<unknown[]> =>
  c.var.db.batch(items as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export interface AggVariant extends Variant {
  links: { optionId: number; valueId: number }[];
  /** In `order_items` or `pack_items`: never deleted. */
  referenced: boolean;
}
export interface AggOption extends ProductOption {
  values: OptionValue[];
}
export interface ProductAggregate {
  product: Product;
  options: AggOption[];
  variants: AggVariant[];
  images: Image[];
  packItems: { variantId: number; qty: number }[];
}

export async function loadAggregate(c: Ctx, id: number): Promise<ProductAggregate | null> {
  const db = c.var.db;
  const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  if (product === undefined) return null;
  const [opts, vals, vars, links, imgs, packs, refs] = await Promise.all([
    db.select().from(productOptions).where(eq(productOptions.productId, id)).orderBy(asc(productOptions.position), asc(productOptions.id)),
    db
      .select({ value: optionValues })
      .from(optionValues)
      .innerJoin(productOptions, eq(productOptions.id, optionValues.optionId))
      .where(eq(productOptions.productId, id))
      .orderBy(asc(optionValues.position), asc(optionValues.id)),
    db.select().from(variants).where(eq(variants.productId, id)).orderBy(asc(variants.position), asc(variants.id)),
    db
      .select({ variantId: variantOptionValues.variantId, valueId: variantOptionValues.optionValueId, optionId: optionValues.optionId })
      .from(variantOptionValues)
      .innerJoin(variants, eq(variants.id, variantOptionValues.variantId))
      .innerJoin(optionValues, eq(optionValues.id, variantOptionValues.optionValueId))
      .where(eq(variants.productId, id)),
    db.select().from(images).where(eq(images.productId, id)).orderBy(asc(images.position), asc(images.id)),
    db.select({ variantId: packItems.variantId, qty: packItems.qty }).from(packItems).where(eq(packItems.packProductId, id)).orderBy(asc(packItems.position)),
    db
      .select({ id: variants.id })
      .from(variants)
      .where(
        and(
          eq(variants.productId, id),
          sql`(exists (select 1 from order_items oi where oi.variant_id = ${variants.id}) or exists (select 1 from pack_items pi where pi.variant_id = ${variants.id}))`,
        ),
      ),
  ]);
  const referenced = new Set(refs.map((r) => r.id));
  return {
    product,
    options: opts.map((o) => ({ ...o, values: vals.map((x) => x.value).filter((x) => x.optionId === o.id) })),
    variants: vars.map((x) => ({
      ...x,
      links: links.filter((l) => l.variantId === x.id).map((l) => ({ optionId: l.optionId, valueId: l.valueId })),
      referenced: referenced.has(x.id),
    })),
    images: imgs,
    packItems: packs,
  };
}

export interface ListFilters {
  q: string | null;
  categoryIds: number[] | null;
  status: Product['status'] | null;
  kind: Product['kind'] | null;
}

export interface ListRow {
  id: number;
  nameFr: string;
  nameAr: string;
  brandLatin: string | null;
  kind: Product['kind'];
  status: Product['status'];
  placeholder: boolean;
  categoryNameFr: string;
  categoryNameAr: string;
  minPrice: number | null;
  maxPrice: number | null;
  variantCount: number;
  trackedStock: number | null;
}

export async function listProducts(c: Ctx, f: ListFilters, limit: number, offset: number): Promise<{ rows: ListRow[]; total: number }> {
  const db = c.var.db;
  const where: SQL[] = [];
  if (f.q !== null) {
    // instr(), not LIKE: D1 rejects LIKE patterns over ~50 bytes (db, DB-2 smoke log).
    const q = f.q;
    where.push(sql`(instr(lower(${products.nameFr}), lower(${q})) > 0 or instr(${products.nameAr}, ${q}) > 0
      or instr(lower(coalesce(${products.brandLatin}, '')), lower(${q})) > 0
      or exists (select 1 from variants vq where vq.product_id = ${products.id} and instr(lower(vq.sku), lower(${q})) > 0))`);
  }
  if (f.categoryIds !== null) where.push(f.categoryIds.length === 0 ? sql`0` : inArray(products.categoryId, f.categoryIds));
  if (f.status !== null) where.push(eq(products.status, f.status));
  if (f.kind !== null) where.push(eq(products.kind, f.kind));
  const cond = where.length > 0 ? and(...where) : undefined;
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: products.id,
        nameFr: products.nameFr,
        nameAr: products.nameAr,
        brandLatin: products.brandLatin,
        kind: products.kind,
        status: products.status,
        placeholder: products.placeholder,
        categoryNameFr: categories.nameFr,
        categoryNameAr: categories.nameAr,
        minPrice: sql<number | null>`(select min(price_dzd) from variants v where v.product_id = ${products.id} and v.active = 1)`,
        maxPrice: sql<number | null>`(select max(price_dzd) from variants v where v.product_id = ${products.id} and v.active = 1)`,
        variantCount: sql<number>`(select count(*) from variants v where v.product_id = ${products.id})`,
        trackedStock: sql<number | null>`(select sum(stock) from variants v where v.product_id = ${products.id} and v.active = 1)`,
      })
      .from(products)
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .where(cond)
      .orderBy(desc(products.updatedAt), desc(products.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(products).where(cond),
  ]);
  return { rows, total: totals[0]?.n ?? 0 };
}

/** SKUs among `skus` already used, optionally ignoring one product's own variants. */
export async function takenSkus(c: Ctx, skus: readonly string[], exceptProductId: number | null = null): Promise<Set<string>> {
  if (skus.length === 0) return new Set();
  const rows = await c.var.db
    .select({ sku: variants.sku })
    .from(variants)
    .where(and(inArray(variants.sku, [...skus]), exceptProductId === null ? undefined : sql`${variants.productId} <> ${exceptProductId}`));
  return new Set(rows.map((r) => r.sku));
}

/** All SKUs that start with `prefix` (the matrix generator avoids them). substr, not LIKE (D1 pattern limit). */
export async function skusWithPrefix(c: Ctx, prefix: string): Promise<Set<string>> {
  const rows = await c.var.db
    .select({ sku: variants.sku })
    .from(variants)
    .where(sql`substr(${variants.sku}, 1, ${prefix.length}) = ${prefix}`);
  return new Set(rows.map((r) => r.sku));
}

// ---------------------------------------------------------------------------------------------
// Create / details
// ---------------------------------------------------------------------------------------------

export interface FirstVariant {
  sku: string;
  priceDzd: number;
  compareAtDzd: number | null;
  stock: number | null;
  weightG: number | null;
}

/** Product (draft) + its default variant + audit, one batch. Returns the new id. */
export async function createProduct(c: Ctx, kind: ProductKind, row: ProductRow, first: FirstVariant): Promise<number> {
  const db = c.var.db;
  const productId = sql`(select id from products where slug_fr = ${row.slugFr})`;
  const [inserted] = await run(c, [
    db.insert(products).values({ ...row, kind, status: 'draft' }).returning({ id: products.id }),
    db.insert(variants).values({ ...first, productId: productId as unknown as number, isDefault: true, active: true, position: 0 }),
    audit(c, { action: 'product.create', entity: 'products', entityId: productId, before: null, after: { ...row, kind, status: 'draft', variant: first } }),
  ]);
  const id = (inserted as { id: number }[])[0]?.id;
  if (id === undefined) throw new Error('createProduct: no id');
  return id;
}

export function detailsSnapshot(p: Product | ProductRow): ProductRow {
  return {
    categoryId: p.categoryId,
    nameFr: p.nameFr,
    nameAr: p.nameAr,
    brandLatin: p.brandLatin,
    summaryFr: p.summaryFr,
    summaryAr: p.summaryAr,
    descriptionFr: p.descriptionFr,
    descriptionAr: p.descriptionAr,
    slugFr: p.slugFr,
    slugAr: p.slugAr,
    sort: p.sort,
    placeholder: p.placeholder,
    translationPlaceholder: [...p.translationPlaceholder],
  };
}

/** Conditional on the product version; false = stale. */
export async function updateDetails(c: Ctx, before: Product, version: number, row: ProductRow): Promise<'updated' | 'unchanged' | 'conflict'> {
  const diff = changedFields(detailsSnapshot(before), row);
  if (diff === null) return 'unchanged';
  const db = c.var.db;
  const [res] = await run(c, [
    db.update(products).set({ ...row, updatedAt: bumpUpdatedAt() }).where(and(eq(products.id, before.id), eq(products.updatedAt, version))),
    audit(c, { action: 'product.update', entity: 'products', entityId: before.id, ...diff }, { when: sql`changes() = 1` }),
  ]);
  return changesOf(res) === 1 ? 'updated' : 'conflict';
}

// ---------------------------------------------------------------------------------------------
// Variant grid
// ---------------------------------------------------------------------------------------------

type VariantPatch = Partial<Pick<Variant, 'sku' | 'priceDzd' | 'compareAtDzd' | 'stock' | 'weightG' | 'active'>>;

/**
 * Saves the grid in one batch. Guards: each changed variant still has the version it was rendered
 * with, and each stock change still sees the stock that was shown (orders decrement stock without
 * the admin knowing). Stock changes get their own `stock.set` audit row.
 */
export async function saveGrid(c: Ctx, agg: ProductAggregate, rows: readonly GridRow[], defaultId: number | null): Promise<'saved' | 'unchanged'> {
  const db = c.var.db;
  const byId = new Map(agg.variants.map((x) => [x.id, x]));
  const items: Batch = [];
  const writes: Batch = [];
  const before: Record<number, VariantPatch> = {};
  const after: Record<number, VariantPatch> = {};
  const stockBefore: Record<number, number | null> = {};
  const stockAfter: Record<number, number | null> = {};
  for (const r of rows) {
    const cur = byId.get(r.id);
    if (cur === undefined) continue;
    const next: VariantPatch = { sku: r.sku, priceDzd: r.priceDzd, compareAtDzd: r.compareAtDzd, weightG: r.weightG, active: r.active };
    const diff = changedFields(cur as VariantPatch, next);
    const stockChanged = r.stock !== r.stockWas;
    if (diff === null && !stockChanged) continue;
    items.push(versionGuard(db, 'variants', 'id', r.id, r.version));
    if (stockChanged) {
      items.push(guard(db, sql`exists (select 1 from variants where id = ${r.id} and stock is ${r.stockWas})`));
      stockBefore[r.id] = r.stockWas;
      stockAfter[r.id] = r.stock;
    }
    if (diff !== null) {
      before[r.id] = diff.before;
      after[r.id] = diff.after;
    }
    writes.push(
      db
        .update(variants)
        .set({ ...(diff?.after ?? {}), ...(stockChanged ? { stock: r.stock } : {}), updatedAt: bumpUpdatedAt() })
        .where(and(eq(variants.id, r.id), eq(variants.productId, agg.product.id))),
    );
  }
  const currentDefault = agg.variants.find((x) => x.isDefault)?.id ?? null;
  const defaultChanged = defaultId !== currentDefault;
  if (writes.length === 0 && !defaultChanged) return 'unchanged';
  if (defaultChanged) {
    writes.push(db.update(variants).set({ isDefault: false }).where(and(eq(variants.productId, agg.product.id), eq(variants.isDefault, true))));
    if (defaultId !== null) writes.push(db.update(variants).set({ isDefault: true }).where(and(eq(variants.id, defaultId), eq(variants.productId, agg.product.id))));
  }
  writes.push(db.update(products).set({ updatedAt: bumpUpdatedAt() }).where(eq(products.id, agg.product.id)));
  const audits: Batch = [];
  if (Object.keys(after).length > 0 || defaultChanged) {
    audits.push(
      audit(c, {
        action: 'variant.update',
        entity: 'variants',
        entityId: agg.product.id,
        before: { variants: before, ...(defaultChanged ? { defaultVariantId: currentDefault } : {}) },
        after: { variants: after, ...(defaultChanged ? { defaultVariantId: defaultId } : {}) },
      }),
    );
  }
  if (Object.keys(stockAfter).length > 0) {
    audits.push(audit(c, { action: 'stock.set', entity: 'variants', entityId: agg.product.id, before: { stock: stockBefore }, after: { stock: stockAfter } }));
  }
  await run(c, [...items, ...writes, ...audits]);
  return 'saved';
}

// ---------------------------------------------------------------------------------------------
// Options + matrix (applied together)
// ---------------------------------------------------------------------------------------------

export interface IdBase {
  option: number;
  value: number;
  variant: number;
}

/** Current max ids: new rows get explicit ids above them (a concurrent insert makes the batch fail on the PK). */
export async function maxIds(c: Ctx): Promise<IdBase> {
  const [row] = await c.var.db
    .select({
      option: sql<number>`(select coalesce(max(id), 0) from product_options)`,
      value: sql<number>`(select coalesce(max(id), 0) from option_values)`,
      variant: sql<number>`(select coalesce(max(id), 0) from variants)`,
    })
    .from(sql`(select 1)`);
  return row ?? { option: 0, value: 0, variant: 0 };
}

/** Temporary (negative) ids for new options/values, so the generator can run before ids exist. */
export type TempValue = DraftOption['values'][number] & { tid: number };
export type TempOption = Omit<DraftOption, 'values'> & { tid: number; values: TempValue[] };

export function withTempIds(draft: readonly DraftOption[]): { options: TempOption[] } {
  let o = 0;
  let val = 0;
  return {
    options: draft.map((opt) => ({
      ...opt,
      tid: opt.id ?? -++o,
      values: opt.values.map((x) => ({ ...x, tid: x.id ?? -1000 - ++val })),
    })),
  };
}

export interface OptionsApply {
  version: number;
  draft: ReturnType<typeof withTempIds>;
  plan: MatrixPlan | null;
  /** Variable product reduced to a single variant with no options. */
  toSimple: boolean;
  newVariantPrice: number;
  newVariantWeight: number | null;
  ids: IdBase;
}

export async function applyOptions(c: Ctx, agg: ProductAggregate, a: OptionsApply): Promise<void> {
  const db = c.var.db;
  const pid = agg.product.id;
  const realOpt = new Map<number, number>();
  const realVal = new Map<number, number>();
  let no = a.ids.option;
  let nv = a.ids.value;
  for (const o of a.draft.options) {
    realOpt.set(o.tid, o.id ?? ++no);
    for (const x of o.values) realVal.set(x.tid, x.id ?? ++nv);
  }
  const rv = (tid: number): number => realVal.get(tid) ?? tid;
  const items: Batch = [versionGuard(db, 'products', 'id', pid, a.version)];

  // Deleted variants: must still be unreferenced when the batch runs.
  const del = a.plan?.deleteVariantIds ?? [];
  if (del.length > 0) {
    items.push(
      guard(
        db,
        sql`not exists (select 1 from order_items where variant_id in ${del}) and not exists (select 1 from pack_items where variant_id in ${del})`,
      ),
    );
    items.push(db.delete(variants).where(and(inArray(variants.id, del), eq(variants.productId, pid))));
  }
  // Removed options / values (cascade: their variant links).
  const keepOpt = a.draft.options.flatMap((o) => (o.id === null ? [] : [o.id]));
  const removedOpt = agg.options.filter((o) => !keepOpt.includes(o.id)).map((o) => o.id);
  if (removedOpt.length > 0) items.push(db.delete(productOptions).where(inArray(productOptions.id, removedOpt)));
  const keepVal = a.draft.options.flatMap((o) => o.values.flatMap((x) => (x.id === null ? [] : [x.id])));
  const removedVal = agg.options.filter((o) => keepOpt.includes(o.id)).flatMap((o) => o.values.map((x) => x.id)).filter((id) => !keepVal.includes(id));
  if (removedVal.length > 0) items.push(db.delete(optionValues).where(inArray(optionValues.id, removedVal)));

  // Upsert options and values in position order.
  a.draft.options.forEach((o, i) => {
    const oid = realOpt.get(o.tid) as number;
    if (o.id === null) items.push(db.insert(productOptions).values({ id: oid, productId: pid, kind: o.kind, nameFr: o.nameFr, nameAr: o.nameAr, position: i }));
    else items.push(db.update(productOptions).set({ nameFr: o.nameFr, nameAr: o.nameAr, position: i }).where(and(eq(productOptions.id, oid), eq(productOptions.productId, pid))));
    o.values.forEach((x, j) => {
      const vid = rv(x.tid);
      const set = { valueFr: x.valueFr, valueAr: x.valueAr, swatchHex: x.swatchHex, position: j };
      if (x.id === null) items.push(db.insert(optionValues).values({ id: vid, optionId: oid, ...set }));
      else items.push(db.update(optionValues).set(set).where(and(eq(optionValues.id, vid), eq(optionValues.optionId, oid))));
    });
  });

  if (a.plan !== null) {
    for (const l of a.plan.addLinks) {
      for (const tid of l.optionValueIds) items.push(db.insert(variantOptionValues).values({ variantId: l.variantId, optionValueId: rv(tid) }));
    }
    let nvar = a.ids.variant;
    const skuToId = new Map<string, number>();
    a.plan.rows.forEach((row, position) => {
      if (row.kind === 'keep') {
        items.push(db.update(variants).set({ position, updatedAt: bumpUpdatedAt() }).where(and(eq(variants.id, row.variantId), eq(variants.productId, pid))));
        return;
      }
      const id = ++nvar;
      skuToId.set(row.sku, id);
      items.push(
        db.insert(variants).values({ id, productId: pid, sku: row.sku, priceDzd: a.newVariantPrice, compareAtDzd: null, stock: null, weightG: a.newVariantWeight, active: true, isDefault: false, position }),
      );
      for (const tid of row.optionValueIds) items.push(db.insert(variantOptionValues).values({ variantId: id, optionValueId: rv(tid) }));
    });
    const d = a.plan.defaultVariant;
    const defaultId = d === null ? null : 'variantId' in d ? d.variantId : (skuToId.get(d.sku) ?? null);
    items.push(db.update(variants).set({ isDefault: false }).where(and(eq(variants.productId, pid), eq(variants.isDefault, true))));
    if (defaultId !== null) items.push(db.update(variants).set({ isDefault: true }).where(eq(variants.id, defaultId)));
  }
  const kind: ProductKind = a.toSimple ? 'simple' : 'variable';
  items.push(db.update(products).set({ kind, updatedAt: bumpUpdatedAt() }).where(eq(products.id, pid)));
  items.push(
    audit(c, {
      action: 'variant.generate',
      entity: 'products',
      entityId: pid,
      before: { kind: agg.product.kind, options: summarizeOptions(agg.options), variants: agg.variants.map((x) => x.sku) },
      after: {
        kind,
        options: a.draft.options.map((o) => ({ kind: o.kind, nameFr: o.nameFr, values: o.values.map((x) => x.valueFr) })),
        created: a.plan?.rows.flatMap((r) => (r.kind === 'create' ? [r.sku] : [])) ?? [],
        deletedVariantIds: del,
      },
    }),
  );
  await run(c, items);
}

function summarizeOptions(options: readonly AggOption[]) {
  return options.map((o) => ({ kind: o.kind, nameFr: o.nameFr, values: o.values.map((x) => x.valueFr) }));
}

// ---------------------------------------------------------------------------------------------
// Status and activation check
// ---------------------------------------------------------------------------------------------

export type ActivationIssue = { rule: 'price' } | { rule: 'category' } | { rule: 'integrity'; detail: string };

/** Everything that would stop this product from being published (ACAT-0 §4.3). */
export async function activationIssues(c: Ctx, agg: ProductAggregate): Promise<ActivationIssue[]> {
  const db = c.var.db;
  const cats = await db.select().from(categories);
  const packVariantIds = agg.packItems.map((p) => p.variantId);
  const kinds =
    packVariantIds.length === 0
      ? []
      : await db.select({ id: variants.id, kind: products.kind }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(inArray(variants.id, packVariantIds));
  const snapshot = toSnapshot(agg, 'active');
  const issues: ActivationIssue[] = checkProductIntegrity(snapshot, {
    variantKindById: new Map(kinds.map((k) => [k.id, k.kind])),
    categoryIds: new Set(cats.map((k) => k.id)),
  }).map((i) => ({ rule: 'integrity' as const, detail: i.message }));
  if (agg.variants.some((x) => x.active && x.priceDzd < 1)) issues.push({ rule: 'price' });
  if (!categoryPublished(cats, agg.product.categoryId)) issues.push({ rule: 'category' });
  return issues;
}

function categoryPublished(cats: readonly Category[], id: number): boolean {
  const byId = new Map(cats.map((k) => [k.id, k]));
  let cur = byId.get(id);
  for (let i = 0; cur !== undefined && i <= cats.length; i++) {
    if (!cur.active) return false;
    if (cur.parentId === null) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

/** The product as CAT-1 sees it in a snapshot (with the status it would have). */
export function toSnapshot(agg: ProductAggregate, status: Product['status']): SnapshotProduct {
  const p = agg.product;
  return {
    id: p.id,
    kind: p.kind,
    categoryId: p.categoryId,
    slug: { fr: p.slugFr, ar: p.slugAr },
    name: { fr: p.nameFr, ar: p.nameAr },
    brandLatin: p.brandLatin,
    summary: { fr: p.summaryFr, ar: p.summaryAr },
    description: { fr: p.descriptionFr, ar: p.descriptionAr },
    status,
    placeholder: p.placeholder,
    translationPlaceholder: p.translationPlaceholder,
    sort: p.sort,
    options: agg.options.map((o) => ({
      id: o.id,
      type: o.kind,
      name: { fr: o.nameFr, ar: o.nameAr },
      position: o.position,
      values: o.values.map((x) => ({ id: x.id, value: { fr: x.valueFr, ar: x.valueAr }, swatchHex: x.swatchHex, position: x.position })),
    })),
    variants: agg.variants.map((x) => ({
      id: x.id,
      sku: x.sku,
      priceDzd: x.priceDzd,
      compareAtDzd: x.compareAtDzd,
      stock: x.stock,
      weightG: x.weightG,
      active: x.active,
      isDefault: x.isDefault,
      optionValueIds: x.links.map((l) => l.valueId),
    })),
    packItems: agg.packItems,
    images: agg.images.map((img) => ({
      id: img.id,
      variantId: img.variantId,
      key: img.r2Key,
      width: img.width,
      height: img.height,
      alt: { fr: img.altFr, ar: img.altAr },
      position: img.position,
      placeholder: img.placeholder,
    })),
  };
}

export async function setStatus(c: Ctx, agg: ProductAggregate, version: number, to: Product['status']): Promise<boolean> {
  const db = c.var.db;
  const [res] = await run(c, [
    db.update(products).set({ status: to, updatedAt: bumpUpdatedAt() }).where(and(eq(products.id, agg.product.id), eq(products.updatedAt, version))),
    audit(
      c,
      { action: 'product.status', entity: 'products', entityId: agg.product.id, before: { status: agg.product.status }, after: { status: to } },
      { when: sql`changes() = 1` },
    ),
  ]);
  return changesOf(res) === 1;
}

// ---------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------

export async function isReferenced(c: Ctx, productId: number): Promise<boolean> {
  const [row] = await c.var.db
    .select({ n: count() })
    .from(orderItems)
    .where(eq(orderItems.productId, productId));
  if ((row?.n ?? 0) > 0) return true;
  const [p] = await c.var.db
    .select({ n: count() })
    .from(packItems)
    .innerJoin(variants, eq(variants.id, packItems.variantId))
    .where(eq(variants.productId, productId));
  return (p?.n ?? 0) > 0;
}

/** Deletes an unreferenced product with its variants, options and images (guarded in the batch). */
export async function deleteProduct(c: Ctx, agg: ProductAggregate): Promise<void> {
  const db = c.var.db;
  const pid = agg.product.id;
  const keys = agg.images.map((i) => i.r2Key);
  await run(c, [
    guard(
      db,
      sql`not exists (select 1 from order_items where product_id = ${pid})
        and not exists (select 1 from pack_items pi join variants v on v.id = pi.variant_id where v.product_id = ${pid})`,
    ),
    db.delete(packItems).where(eq(packItems.packProductId, pid)),
    db.delete(variants).where(eq(variants.productId, pid)),
    db.delete(productOptions).where(eq(productOptions.productId, pid)),
    db.delete(products).where(eq(products.id, pid)),
    audit(c, {
      action: 'product.delete',
      entity: 'products',
      entityId: pid,
      before: { ...detailsSnapshot(agg.product), kind: agg.product.kind, status: agg.product.status, variants: agg.variants.map((x) => x.sku), imageKeys: keys },
      after: null,
    }),
  ]);
  await deleteUnreferencedMedia(c, keys);
}

function changesOf(result: unknown): number {
  return (result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
}
