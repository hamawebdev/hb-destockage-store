/**
 * D1 reads used to price a request server-side (quote and order). Always fresh: nothing here is
 * cached, so a price, stock or status edit applies to the next request. One `batch()` = one D1
 * round trip. Plan: WEB-0 §3 layer 6, §5.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import {
  communes,
  optionValues,
  productOptions,
  products,
  variantOptionValues,
  variants,
  type Db,
} from '@hb/db';

/** A variant as the order flow sees it. `sellable` = variant active and its product active. */
export interface VariantForSale {
  readonly id: number;
  readonly productId: number;
  readonly priceDzd: number;
  /** NULL = stock not tracked (always orderable). */
  readonly stock: number | null;
  readonly weightG: number | null;
  readonly sellable: boolean;
}

/** Name/SKU snapshot stored on `order_items` (catalogue edits never change a placed order). */
export interface VariantSnapshot {
  readonly productId: number;
  readonly sku: string;
  readonly nameFr: string;
  readonly nameAr: string;
  /** Option values in option order, e.g. "Rouge / XL"; null for a product without options. */
  readonly variantLabelFr: string | null;
  readonly variantLabelAr: string | null;
  /** Product slugs, for the no-JS review page's «edit» link (`/{lang}/p/<slug>/`). */
  readonly slugFr: string;
  readonly slugAr: string;
}

export interface PricingReads {
  readonly variants: ReadonlyMap<number, VariantForSale>;
  /** Wilaya of the requested commune; `null` = unknown commune; `undefined` = no commune asked. */
  readonly communeWilaya: number | null | undefined;
  /** Present when requested (`snapshots: true`): the order path and the no-JS review page. */
  readonly snapshots?: ReadonlyMap<number, VariantSnapshot> | undefined;
}

export async function readPricing(
  db: Db,
  variantIds: readonly number[],
  communeId: number | undefined,
  opts: { readonly snapshots?: boolean } = {},
): Promise<PricingReads> {
  const ids = [...variantIds];
  const variantQuery = db
    .select({
      id: variants.id,
      productId: variants.productId,
      priceDzd: variants.priceDzd,
      stock: variants.stock,
      weightG: variants.weightG,
      active: variants.active,
      sku: variants.sku,
      productStatus: products.status,
      nameFr: products.nameFr,
      nameAr: products.nameAr,
      slugFr: products.slugFr,
      slugAr: products.slugAr,
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(inArray(variants.id, ids));
  const communeQuery = db
    .select({ wilayaCode: communes.wilayaCode })
    .from(communes)
    .where(eq(communes.id, communeId ?? -1))
    .limit(1);
  const labelQuery = db
    .select({
      variantId: variantOptionValues.variantId,
      valueFr: optionValues.valueFr,
      valueAr: optionValues.valueAr,
    })
    .from(variantOptionValues)
    .innerJoin(optionValues, eq(optionValues.id, variantOptionValues.optionValueId))
    .innerJoin(productOptions, eq(productOptions.id, optionValues.optionId))
    .where(inArray(variantOptionValues.variantId, ids))
    .orderBy(asc(variantOptionValues.variantId), asc(productOptions.position), asc(productOptions.id));

  let rows: Awaited<typeof variantQuery>;
  let communeRows: Awaited<typeof communeQuery>;
  let labelRows: Awaited<typeof labelQuery> = [];
  if (opts.snapshots === true) [rows, communeRows, labelRows] = await db.batch([variantQuery, communeQuery, labelQuery]);
  else [rows, communeRows] = await db.batch([variantQuery, communeQuery]);

  const map = new Map<number, VariantForSale>();
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      productId: r.productId,
      priceDzd: r.priceDzd,
      stock: r.stock,
      weightG: r.weightG,
      sellable: r.active && r.productStatus === 'active',
    });
  }
  const communeWilaya = communeId === undefined ? undefined : (communeRows[0]?.wilayaCode ?? null);
  if (opts.snapshots !== true) return { variants: map, communeWilaya };

  const labels = new Map<number, { fr: string[]; ar: string[] }>();
  for (const l of labelRows) {
    const e = labels.get(l.variantId) ?? { fr: [], ar: [] };
    e.fr.push(l.valueFr);
    e.ar.push(l.valueAr);
    labels.set(l.variantId, e);
  }
  const snapshots = new Map<number, VariantSnapshot>();
  for (const r of rows) {
    const l = labels.get(r.id);
    snapshots.set(r.id, {
      productId: r.productId,
      sku: r.sku,
      nameFr: r.nameFr,
      nameAr: r.nameAr,
      variantLabelFr: l === undefined ? null : l.fr.join(' / '),
      variantLabelAr: l === undefined ? null : l.ar.join(' / '),
      slugFr: r.slugFr,
      slugAr: r.slugAr,
    });
  }
  return { variants: map, communeWilaya, snapshots };
}

/**
 * No-JS size × colour radios: the active variant of `productId` whose option values are exactly
 * `optionValueIds` (one per option). Null when the combination does not exist.
 */
export async function resolveVariant(db: Db, productId: number, optionValueIds: readonly number[]): Promise<number | null> {
  if (optionValueIds.length === 0) return null;
  const rows = await db
    .select({ variantId: variantOptionValues.variantId, optionValueId: variantOptionValues.optionValueId })
    .from(variantOptionValues)
    .innerJoin(variants, eq(variants.id, variantOptionValues.variantId))
    .where(eq(variants.productId, productId));
  const byVariant = new Map<number, Set<number>>();
  for (const r of rows) {
    const s = byVariant.get(r.variantId) ?? new Set<number>();
    s.add(r.optionValueId);
    byVariant.set(r.variantId, s);
  }
  const wanted = new Set(optionValueIds);
  for (const [variantId, values] of byVariant) {
    if (values.size === wanted.size && [...wanted].every((v) => values.has(v))) return variantId;
  }
  return null;
}

/** Communes of one wilaya, for the no-JS review page's commune select. */
export async function communesOf(db: Db, wilayaCode: number): Promise<readonly { id: number; nameFr: string; nameAr: string }[]> {
  return db
    .select({ id: communes.id, nameFr: communes.nameFr, nameAr: communes.nameAr })
    .from(communes)
    .where(eq(communes.wilayaCode, wilayaCode))
    .orderBy(asc(communes.nameFr));
}
