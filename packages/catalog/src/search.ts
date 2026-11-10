/**
 * CAT-5 — per-language search index (pure). One entry per published product, from the same
 * `ProductCard` the listings show (so price, "from", stock and placeholder flags never disagree
 * with the cards). Keys come from geo's `searchKey` (folded text plus spelling alternatives joined
 * by `|`); the client folds the query with geo's `normalizeForSearch` and matches with
 * `entry.k.includes(query)`.
 */
import { productCard, type BuildContext } from './build.ts';
import type { Lang, SearchIndex, SearchIndexEntry, StockState } from './types.ts';
import { assertSameOriginPath } from './url.ts';

/** geo's `data/geo/search.mjs` (GEO-5). */
export interface SearchFolding {
  searchKey(name: string, lang?: Lang): string;
  normalizeForSearch(s: string, lang?: Lang): string;
}

const STOCK_CODE: Readonly<Record<StockState, 0 | 1 | 2>> = { in_stock: 0, low_stock: 1, out_of_stock: 2 };

/** Fields folded into `k`, in this order, `|`-separated: name, brand, category, option values. */
export function searchFields(ctx: BuildContext, productId: number, lang: Lang): string[] {
  const p = ctx.productById.get(productId)!;
  const cat = ctx.categoryById.get(p.categoryId)!;
  const values = p.options.flatMap((o) => o.values.map((x) => x.value[lang]));
  return [p.name[lang], ...(p.brandLatin ? [p.brandLatin] : []), cat.name[lang], ...values];
}

export function buildSearchIndex(ctx: BuildContext, lang: Lang, folding: SearchFolding): SearchIndex {
  const entries: SearchIndexEntry[] = ctx.products.map((p) => {
    const card = productCard(ctx, p, lang);
    const thumb = card.image?.candidates[0]?.url ?? null;
    const k = [...new Set(searchFields(ctx, p.id, lang).map((f) => folding.searchKey(f, lang)).filter((x) => x.length > 0))].join('|');
    return {
      id: p.id,
      n: card.name,
      b: card.brandLatin,
      c: ctx.categoryById.get(p.categoryId)!.name[lang],
      p: card.price.amountDzd,
      u: assertSameOriginPath(card.href, `search ${lang} ${p.id}`),
      t: thumb === null ? null : assertSameOriginPath(thumb, `search thumb ${lang} ${p.id}`),
      s: STOCK_CODE[card.stock.state],
      f: card.price.from,
      x: card.placeholder || card.translationPlaceholder,
      k,
      // CART-3: only in a cart-off build, so the cart-on index is byte-identical to before.
      ...(ctx.snapshot.settings.cartEnabled ? {} : { o: assertSameOriginPath(card.orderHref, `search order ${lang} ${p.id}`) }),
    };
  });
  return { v: 1, lang, entries };
}
