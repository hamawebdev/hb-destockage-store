/**
 * Which snapshot entities get pages. Shared by the route map, the page-props builders and the
 * sitemap so they can never disagree.
 *  - A category is published when it and every ancestor are `active`.
 *  - A product is published when `status === 'active'`, it has ≥ 1 active variant, and its
 *    category is published.
 *  - A content page is published when `active`.
 * Ordering: `sort`, then `id`.
 */
import type { CatalogSnapshot, Id, SnapshotCategory, SnapshotContentPage, SnapshotProduct } from './types.ts';

const bySortThenId = <T extends { sort: number; id: Id }>(a: T, b: T): number => a.sort - b.sort || a.id - b.id;

export function publishedCategories(snapshot: CatalogSnapshot): SnapshotCategory[] {
  const byId = new Map(snapshot.categories.map((c) => [c.id, c]));
  const isPublished = (c: SnapshotCategory, depth = 0): boolean => {
    if (!c.active || depth > byId.size) return false;
    if (c.parentId === null) return true;
    const parent = byId.get(c.parentId);
    return parent !== undefined && isPublished(parent, depth + 1);
  };
  return snapshot.categories.filter((c) => isPublished(c)).sort(bySortThenId);
}

export function publishedProducts(snapshot: CatalogSnapshot): SnapshotProduct[] {
  const cats = new Set(publishedCategories(snapshot).map((c) => c.id));
  return snapshot.products
    .filter((p) => p.status === 'active' && cats.has(p.categoryId) && p.variants.some((v) => v.active))
    .sort(bySortThenId);
}

export function publishedContentPages(snapshot: CatalogSnapshot): SnapshotContentPage[] {
  return snapshot.contentPages.filter((c) => c.active).sort(bySortThenId);
}

/** Ids of `categoryId` and all its descendants (any status). */
export function categoryDescendantIds(snapshot: CatalogSnapshot, categoryId: Id): Set<Id> {
  const ids = new Set<Id>([categoryId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of snapshot.categories) {
      if (c.parentId !== null && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** Published products in the category or its descendants, in listing order. */
export function categoryProductIds(
  snapshot: CatalogSnapshot,
  categoryId: Id,
  products: readonly SnapshotProduct[] = publishedProducts(snapshot),
): Id[] {
  const ids = categoryDescendantIds(snapshot, categoryId);
  return products.filter((p) => ids.has(p.categoryId)).map((p) => p.id);
}
