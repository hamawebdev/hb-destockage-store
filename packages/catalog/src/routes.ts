/**
 * CAT-1 route map: the only place storefront URLs are built (scheme approved in SHELL-0 §3,
 * documented on `TemplateName` in `types.ts`). Pure functions; no I/O.
 */
import { categoryProductIds, publishedCategories, publishedContentPages, publishedProducts } from './publication.ts';
import {
  DEFAULT_LANG,
  LANGS,
  type Alternate,
  type CatalogSnapshot,
  type Id,
  type Lang,
  type Localized,
  type PageRef,
  type RouteEntry,
  type TemplateName,
} from './types.ts';

export const DEFAULT_PAGE_SIZE = 24;

export const homePath = (lang: Lang): string => `/${lang}/`;
export const categoryPath = (lang: Lang, slug: string, page = 1): string =>
  page <= 1 ? `/${lang}/c/${slug}/` : `/${lang}/c/${slug}/${page}/`;
export const productPath = (lang: Lang, slug: string): string => `/${lang}/p/${slug}/`;
export const searchPath = (lang: Lang): string => `/${lang}/search/`;
export const orderConfirmationPath = (lang: Lang): string => `/${lang}/order/confirmation/`;
export const contentPath = (lang: Lang, slug: string): string => `/${lang}/${slug}/`;
/** File the static host serves for unknown `/<lang>/…` paths (Workers static assets `404-page`). */
export const notFoundPath = (lang: Lang): string => `/${lang}/404.html`;

/** Per-language search index (CAT-5). */
export const searchIndexPath = (lang: Lang): string => `/search/${lang}.json`;
/**
 * Per-wilaya, per-language commune JSON (CAT-5, written by geo's `buildGeoAssets`):
 * `/geo/communes/<lang>/<code>.json`, body `[[communeId, "name"], …]` sorted with `Intl.Collator(lang)`.
 * One language per file: about 210 B br median, 582 B max (artifacts/ORDER-0/geo-bytes.txt, artifacts/GEO-3/sizes.md).
 */
export const communesUrlTemplate = (lang: Lang): string => `/geo/communes/${lang}/{code}.json`;
export const communesPath = (lang: Lang, wilayaCode: number): string =>
  communesUrlTemplate(lang).replace('{code}', String(wilayaCode));

export const dirOf = (lang: Lang): 'rtl' | 'ltr' => (lang === 'ar' ? 'rtl' : 'ltr');
export const otherLang = (lang: Lang): Lang => (lang === 'ar' ? 'fr' : 'ar');

/** `siteUrl` without trailing slash + root-relative path. */
export function absoluteUrl(siteUrl: string, path: string): string {
  return siteUrl.replace(/\/+$/, '') + path;
}

/** Reciprocal hreflang set: `ar`, `fr`, and `x-default` → the Arabic version of the same page. */
export function alternatesFor(paths: Localized<string>, siteUrl: string): Alternate[] {
  return [
    ...LANGS.map((lang) => ({ hreflang: lang, href: absoluteUrl(siteUrl, paths[lang]) })),
    { hreflang: 'x-default' as const, href: absoluteUrl(siteUrl, paths[DEFAULT_LANG]) },
  ];
}

const both = (fn: (lang: Lang) => string): Localized<string> => ({ ar: fn('ar'), fr: fn('fr') });

export class RouteError extends Error {
  override name = 'RouteError';
}

export interface Router {
  /** Root-relative path of a page in one language. Throws `RouteError` for unknown/unpublished refs. */
  url(lang: Lang, ref: PageRef): string;
  /** The page's path in each language. */
  paths(ref: PageRef): Localized<string>;
  /** Every page, both languages, optionally filtered. Deterministic order. */
  entries(filter?: { readonly template?: TemplateName; readonly lang?: Lang }): RouteEntry[];
  readonly pageSize: number;
}

/**
 * Builds the route map once per snapshot. Throws `RouteError` at build time if two pages would
 * share a path (e.g. a content slug colliding with another content page in one language).
 * Reserved first segments are rejected earlier by `validateSnapshot`.
 */
export function createRouter(snapshot: CatalogSnapshot, pageSize = DEFAULT_PAGE_SIZE): Router {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RouteError(`invalid pageSize ${pageSize}`);
  const categories = publishedCategories(snapshot);
  const products = publishedProducts(snapshot, categories);
  const contents = publishedContentPages(snapshot);
  const catById = new Map(categories.map((c) => [c.id, c]));
  const productById = new Map(products.map((p) => [p.id, p]));
  const contentById = new Map(contents.map((c) => [c.id, c]));
  const pageCounts = new Map<Id, number>(
    categories.map((c) => [c.id, Math.max(1, Math.ceil(categoryProductIds(snapshot, c.id, products).length / pageSize))]),
  );

  const paths = (ref: PageRef): Localized<string> => {
    switch (ref.template) {
      case 'home':
        return both(homePath);
      case 'search':
        return both(searchPath);
      case 'order-confirmed':
        return both(orderConfirmationPath);
      case 'not-found':
        return both(notFoundPath);
      case 'category': {
        const c = catById.get(ref.id);
        if (!c) throw new RouteError(`category ${ref.id} is not published`);
        const page = ref.page ?? 1;
        const max = pageCounts.get(ref.id) ?? 1;
        if (!Number.isInteger(page) || page < 1 || page > max) throw new RouteError(`category ${ref.id} has no page ${page}`);
        return both((l) => categoryPath(l, c.slug[l], page));
      }
      case 'product': {
        const p = productById.get(ref.id);
        if (!p) throw new RouteError(`product ${ref.id} is not published`);
        return both((l) => productPath(l, p.slug[l]));
      }
      case 'content': {
        const c = contentById.get(ref.id);
        if (!c) throw new RouteError(`content page ${ref.id} is not published`);
        return both((l) => contentPath(l, c.slug[l]));
      }
    }
  };

  const all: RouteEntry[] = [];
  const add = (template: TemplateName, ref: PageRef, entityId: Id | null, page: number, indexable: boolean): void => {
    const p = paths(ref);
    for (const lang of LANGS) {
      all.push({ template, lang, path: p[lang], param: p[lang].slice(lang.length + 2).replace(/\/$/, ''), entityId, page, paths: p, indexable });
    }
  };
  add('home', { template: 'home' }, null, 1, true);
  for (const c of categories) {
    for (let page = 1; page <= (pageCounts.get(c.id) ?? 1); page++) add('category', { template: 'category', id: c.id, page }, c.id, page, true);
  }
  for (const p of products) add('product', { template: 'product', id: p.id }, p.id, 1, true);
  for (const c of contents) add('content', { template: 'content', id: c.id }, c.id, 1, true);
  add('search', { template: 'search' }, null, 1, false);
  add('order-confirmed', { template: 'order-confirmed' }, null, 1, false);
  add('not-found', { template: 'not-found' }, null, 1, false);

  const seen = new Map<string, RouteEntry>();
  for (const e of all) {
    const prev = seen.get(e.path);
    if (prev) throw new RouteError(`path collision ${e.path}: ${prev.template} ${prev.entityId ?? ''} vs ${e.template} ${e.entityId ?? ''}`);
    seen.set(e.path, e);
  }

  return {
    pageSize,
    url: (lang, ref) => paths(ref)[lang],
    paths,
    entries: (filter = {}) =>
      all.filter((e) => (filter.template === undefined || e.template === filter.template) && (filter.lang === undefined || e.lang === filter.lang)),
  };
}
