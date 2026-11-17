// DB-5 — `@hb/db/export`: D1 → CAT-1 CatalogSnapshot for the publish pipeline (jobs JOBS-3).
// - ONE D1 batch of read builders (= one transaction): a consistent snapshot even while the admin
//   edits.
// - Every product status and every category/content row with its `active` flag (lead ruling;
//   builders filter: pack contents may reference draft components).
// - No customer, order, admin or audit data: only catalogue, content, settings, wilayas.
// - Array order is the contract (CAT-1): by `position` (or `sort`), then id.
// - The result is validated with @hb/catalog parseSnapshot before it is returned, so a publish fails
//   here, with the list of issues, rather than in the build.
import { asc, inArray } from 'drizzle-orm';
import {
  parseSnapshot,
  setAsideUnpublishable,
  settingsFromKeyValues,
  SNAPSHOT_VERSION,
  type CatalogSnapshot,
  type ContentBlock,
  type ContentPageKey,
  type IntegrityOptions,
  type SetAsideProduct,
  type SnapshotCategory,
  type SnapshotImage,
  type SnapshotProduct,
  type SnapshotSettings,
} from '@hb/catalog';
import {
  categories,
  contentPages,
  images,
  optionValues,
  packItems,
  productOptions,
  products,
  settings,
  variantOptionValues,
  variants,
  wilayas,
} from './schema.ts';
import { STOREFRONT_SETTINGS_KEYS } from './enums.ts';
import type { Db, Image } from './index.ts';

export interface ExportOptions {
  /** Epoch ms written to meta.generatedAt (default: now). */
  readonly generatedAt?: number;
  /** publish_runs.id of the run that exports (meta.publishRunId). */
  readonly publishRunId?: number | null;
  /** Passed to parseSnapshot (default: require all 69 wilayas). */
  readonly integrity?: IntegrityOptions;
  /**
   * Online products the storefront cannot show, published as drafts instead of failing the export (D-028).
   * Called once, before validation, with [] when there are none. Default: a warning line per product.
   */
  readonly onSetAside?: (products: readonly SetAsideProduct[]) => void;
}

/** Map.groupBy without the ES2024 lib. */
function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

const byPos = <T extends { position: number; id: number }>(a: T, b: T) => a.position - b.position || a.id - b.id;

function image(i: Image): SnapshotImage {
  return {
    id: i.id,
    variantId: i.variantId,
    ...(i.optionValueId === null ? {} : { optionValueId: i.optionValueId }),
    key: i.r2Key,
    width: i.width,
    height: i.height,
    alt: { ar: i.altAr, fr: i.altFr },
    position: i.position,
    placeholder: i.placeholder,
    ...(i.printedPricesDzd.length ? { printedPricesDzd: i.printedPricesDzd } : {}),
  };
}

/**
 * Settings go through an explicit allowlist (CART-1): only STOREFRONT_SETTINGS_KEYS, the same list the
 * deploy pipeline copies out of production (equal to @hb/catalog SNAPSHOT_SETTINGS_KEYS, tested), are
 * selected from D1, and settingsFromKeyValues reads only those again. Internal keys (jobs.*,
 * seed.owned, order/call settings) and the Meta server secrets (metaAccessTokenEnc,
 * metaTestEventCode, any metaAccess*) never reach the snapshot.
 * A missing required key fails the export (never a silent default).
 */
function readSettings(rows: readonly { key: string; value: unknown }[]): SnapshotSettings {
  // Unvalidated here; parseSnapshot below checks it with the rest of the snapshot.
  return settingsFromKeyValues(rows.map((r) => [r.key, r.value] as const), 'exportCatalogSnapshot') as SnapshotSettings;
}

export async function exportCatalogSnapshot(db: Db, opts: ExportOptions = {}): Promise<CatalogSnapshot> {
  const [cats, prods, opts_, vals, vars, links, packs, imgs, pages, sets, wils] = await db.batch([
    db.select().from(categories).orderBy(asc(categories.id)),
    db.select().from(products).orderBy(asc(products.id)),
    db.select().from(productOptions),
    db.select().from(optionValues),
    db.select().from(variants),
    db.select().from(variantOptionValues),
    db.select().from(packItems),
    db.select().from(images),
    db.select().from(contentPages).orderBy(asc(contentPages.id)),
    db.select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, [...STOREFRONT_SETTINGS_KEYS])),
    db.select().from(wilayas).orderBy(asc(wilayas.code)),
  ]);

  const valsByOption = groupBy([...vals].sort(byPos), (v) => v.optionId);
  const optsByProduct = groupBy([...opts_].sort(byPos), (o) => o.productId);
  const optionPos = new Map(opts_.map((o) => [o.id, o.position] as const));
  const optionOfValue = new Map(vals.map((v) => [v.id, v.optionId] as const));
  const linksByVariant = groupBy(links, (l) => l.variantId);
  const varsByProduct = groupBy([...vars].sort(byPos), (v) => v.productId);
  const packsByProduct = groupBy(
    [...packs].sort((a, b) => a.position - b.position || a.variantId - b.variantId),
    (p) => p.packProductId,
  );
  const sortedImgs = [...imgs].sort(byPos);
  const imgsByProduct = groupBy(sortedImgs.filter((i) => i.productId !== null), (i) => i.productId!);
  const imgByCategory = new Map<number, Image>();
  for (const i of sortedImgs) if (i.categoryId !== null && !imgByCategory.has(i.categoryId)) imgByCategory.set(i.categoryId, i);

  const outCategories: SnapshotCategory[] = cats.map((c) => {
    const img = imgByCategory.get(c.id);
    return {
      id: c.id,
      parentId: c.parentId,
      slug: { ar: c.slugAr, fr: c.slugFr },
      name: { ar: c.nameAr, fr: c.nameFr },
      description: c.descriptionFr === null && c.descriptionAr === null ? null : { ar: c.descriptionAr ?? '', fr: c.descriptionFr ?? '' },
      sort: c.sort,
      active: c.active,
      placeholder: c.placeholder,
      translationPlaceholder: c.translationPlaceholder,
      ...(img ? { image: image(img) } : {}),
    };
  });

  const outProducts: SnapshotProduct[] = prods.map((p) => ({
    id: p.id,
    kind: p.kind,
    categoryId: p.categoryId,
    slug: { ar: p.slugAr, fr: p.slugFr },
    name: { ar: p.nameAr, fr: p.nameFr },
    brandLatin: p.brandLatin,
    summary: { ar: p.summaryAr, fr: p.summaryFr },
    description: { ar: p.descriptionAr, fr: p.descriptionFr },
    status: p.status,
    placeholder: p.placeholder,
    translationPlaceholder: p.translationPlaceholder,
    sort: p.sort,
    options: (optsByProduct.get(p.id) ?? []).map((o) => ({
      id: o.id,
      type: o.kind,
      name: { ar: o.nameAr, fr: o.nameFr },
      position: o.position,
      values: (valsByOption.get(o.id) ?? []).map((v) => ({ id: v.id, value: { ar: v.valueAr, fr: v.valueFr }, swatchHex: v.swatchHex, position: v.position })),
    })),
    variants: (varsByProduct.get(p.id) ?? []).map((v) => ({
      id: v.id,
      sku: v.sku,
      priceDzd: v.priceDzd,
      compareAtDzd: v.compareAtDzd,
      stock: v.stock,
      weightG: v.weightG,
      active: v.active,
      isDefault: v.isDefault,
      // One value per option, in option order.
      optionValueIds: (linksByVariant.get(v.id) ?? [])
        .map((l) => l.optionValueId)
        .sort((a, b) => (optionPos.get(optionOfValue.get(a)!) ?? 0) - (optionPos.get(optionOfValue.get(b)!) ?? 0) || a - b),
    })),
    packItems: (packsByProduct.get(p.id) ?? []).map((it) => ({ variantId: it.variantId, qty: it.qty })),
    images: (imgsByProduct.get(p.id) ?? []).map(image),
  }));

  const aside = setAsideUnpublishable(outProducts, new Set(outCategories.map((c) => c.id)));
  if (opts.onSetAside) opts.onSetAside(aside.setAside);
  else for (const p of aside.setAside) console.warn(`export: product ${p.id} (${p.name.fr}) is online but cannot be shown, published as a draft: ${p.issues.map((i) => i.message).join('; ')}`);

  const snapshot: CatalogSnapshot = {
    meta: { version: SNAPSHOT_VERSION, source: 'd1', generatedAt: opts.generatedAt ?? Date.now(), publishRunId: opts.publishRunId ?? null },
    categories: outCategories,
    products: aside.products,
    contentPages: pages.map((c) => ({
      id: c.id,
      key: c.key as ContentPageKey,
      slug: { ar: c.slugAr, fr: c.slugFr },
      title: { ar: c.titleAr, fr: c.titleFr },
      summary: { ar: c.summaryAr, fr: c.summaryFr },
      body: { ar: c.bodyAr as readonly ContentBlock[], fr: c.bodyFr as readonly ContentBlock[] },
      sort: c.sort,
      active: c.active,
      placeholder: c.placeholder,
      updatedAt: c.updatedAt,
    })),
    settings: readSettings(sets),
    wilayas: wils.map((w) => ({ code: w.code, name: { ar: w.nameAr, fr: w.nameFr }, courierCode: w.courierCode })),
  };
  return parseSnapshot(snapshot, 'd1 export', opts.integrity);
}
