/**
 * D1 reads used to price a request server-side (quote and order). Always fresh: nothing here is
 * cached, so a price, stock or status edit applies to the next request. Plan: WEB-0 §3 layer 6, §5.
 */
import { eq, inArray } from 'drizzle-orm';
import { communes, products, variants, type Db } from '@hb/db';

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

export interface PricingReads {
  readonly variants: ReadonlyMap<number, VariantForSale>;
  /** Wilaya of the requested commune; `null` = unknown commune; `undefined` = no commune asked. */
  readonly communeWilaya: number | null | undefined;
}

/** One D1 round trip (`batch`) for the variants and, when given, the commune. */
export async function readPricing(
  db: Db,
  variantIds: readonly number[],
  communeId: number | undefined,
): Promise<PricingReads> {
  const variantQuery = db
    .select({
      id: variants.id,
      productId: variants.productId,
      priceDzd: variants.priceDzd,
      stock: variants.stock,
      weightG: variants.weightG,
      active: variants.active,
      productStatus: products.status,
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(inArray(variants.id, [...variantIds]));

  let rows: Awaited<typeof variantQuery>;
  let communeWilaya: number | null | undefined;
  if (communeId === undefined) {
    rows = await variantQuery;
  } else {
    const communeQuery = db
      .select({ wilayaCode: communes.wilayaCode })
      .from(communes)
      .where(eq(communes.id, communeId))
      .limit(1);
    const [v, c] = await db.batch([variantQuery, communeQuery]);
    rows = v;
    communeWilaya = c[0]?.wilayaCode ?? null;
  }

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
  return { variants: map, communeWilaya };
}
