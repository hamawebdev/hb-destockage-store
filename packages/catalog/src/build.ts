/**
 * CAT-3 — page-props builders. Pure: snapshot + brand strings + image manifest → props for one
 * page. No I/O, no clock, deterministic (same inputs ⇒ byte-identical JSON).
 *
 *   const ctx = createBuildContext(snapshot, { siteUrl, strings, images });
 *   for (const page of buildAllPages(ctx)) …           // { entry: RouteEntry, props }
 *   buildPageProps(ctx, entry)                          // one page
 */
import { formatPrice } from '@hb/shared/format';
import { assertSameOriginPath, isAllowedExternalHref, isSameOriginPath, isSiteOrigin, isSiteUrl, UnsafeUrlError } from './url.ts';
import { categoryDescendantIds, publishedCategories, publishedContentPages, publishedProducts } from './publication.ts';
import {
  absoluteUrl,
  alternatesFor,
  communesUrlTemplate,
  createRouter,
  dirOf,
  otherLang,
  searchIndexPath,
  type Router,
} from './routes.ts';
import {
  ORDER_MAX_QTY,
  type Breadcrumb,
  type CatalogSnapshot,
  type CategoryLink,
  type CategoryProps,
  type ContactProps,
  type ContentProps,
  type FooterLink,
  type HomeProps,
  type Id,
  type ImageManifest,
  type ImageProps,
  type ImageSlot,
  type Lang,
  type LayoutProps,
  type Localized,
  type NavCategory,
  type NotFoundProps,
  type OgImage,
  type OptionProps,
  type OrderConfirmationProps,
  type OrderFormProps,
  type OrderStepProps,
  type PackItemProps,
  type PageRef,
  type PaginationProps,
  type PriceProps,
  type ProductCard,
  type ProductImageProps,
  type ProductProps,
  type RouteEntry,
  type SearchProps,
  type SnapshotCategory,
  type SnapshotContentPage,
  type SnapshotImage,
  type SnapshotProduct,
  type SnapshotVariant,
  type StockProps,
  type StringTable,
  type TemplateName,
  type VariantProps,
} from './types.ts';

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

/**
 * `sizes` per slot, matching pages' real layout (container max 1200 px, gutter ≈ 1rem on phones;
 * from 1024 px the gallery column is 7/12 of the container minus the column gap, approximated as
 * (100vw − 64 px) × 0.55 and capped at 664 px from 1240 px; cards 2/3/4 columns at
 * <768/768–1023/≥1024). Proven against rendered widths by bin/check-sizes.ts (±5 %).
 * Accurate sizes matter for the critical path: on Lighthouse's 412 px × 1.75 DPR device the
 * gallery resolves to 380 px × 1.75 = 665 px → the 720 w candidate, not 960 w (pages' measurement
 * on the real seed). Templates may override `sizes` for other uses (e.g. thumbnails).
 */
export const SLOT_SIZES: Readonly<Record<ImageSlot, string>> = {
  hero: '(min-width: 1240px) 664px, (min-width: 1024px) calc((100vw - 64px) * 0.55), calc(100vw - 2rem)',
  gallery: '(min-width: 1240px) 664px, (min-width: 1024px) calc((100vw - 64px) * 0.55), calc(100vw - 2rem)',
  card: '(min-width: 1240px) 282px, (min-width: 1024px) calc((100vw - 152px) / 4), (min-width: 768px) calc((100vw - 98px) / 3), calc((100vw - 44px) / 2)',
  thumb: '96px',
  /** ORDER-STEP summary photo, ≤ 120 CSS px (candidates trimmed to ≤ 480 w). */
  summary: '120px',
};

/** Brand string keys the builders read. A missing key fails the build. */
export const REQUIRED_STRING_KEYS = [
  'meta.titleTemplate',
  'meta.home.title',
  'meta.home.description',
  'meta.category.title',
  'meta.category.description',
  'meta.product.title',
  'meta.product.description',
  'meta.search.title',
  'meta.search.description',
  'meta.confirmation.title',
  'meta.confirmation.description',
  'meta.notFound.title',
  'meta.notFound.description',
  'meta.ogImageAlt',
  'catalog.home',
  'catalog.pagination.page',
  'chrome.langSwitch',
  'product.orderCta',
] as const;

export interface BuildInput {
  /** Absolute origin, e.g. `https://hbdestockage.dz`. */
  readonly siteUrl: string;
  /** Flat brand strings per language (`loadStrings` from `@hb/catalog/sources`). */
  readonly strings: Localized<StringTable>;
  /** CAT-4 manifest; `stubImageManifest(snapshot)` for fixtures. */
  readonly images: ImageManifest;
  readonly pageSize?: number;
  readonly lowStockThreshold?: number;
  readonly relatedCount?: number;
  readonly featuredCount?: number;
  /**
   * Production copy check, same rule as shell's `t()`: a UI string containing `[PLACEHOLDER]`
   * fails the build. Default: `HB_STRICT_COPY=1` in the environment.
   */
  readonly strictCopy?: boolean;
}

export interface BuildContext {
  readonly snapshot: CatalogSnapshot;
  readonly router: Router;
  readonly siteUrl: string;
  readonly strings: Localized<StringTable>;
  readonly images: ImageManifest;
  readonly lowStockThreshold: number;
  readonly relatedCount: number;
  readonly featuredCount: number;
  readonly strictCopy: boolean;
  readonly products: readonly SnapshotProduct[];
  readonly categories: readonly SnapshotCategory[];
  readonly contents: readonly SnapshotContentPage[];
  readonly productById: ReadonlyMap<Id, SnapshotProduct>;
  readonly publishedProductIds: ReadonlySet<Id>;
  readonly categoryById: ReadonlyMap<Id, SnapshotCategory>;
  readonly publishedCategoryIds: ReadonlySet<Id>;
  readonly variantOwner: ReadonlyMap<Id, { readonly product: SnapshotProduct; readonly variant: SnapshotVariant }>;
  /** Published products per category subtree, listing order. */
  readonly subtreeProducts: ReadonlyMap<Id, readonly SnapshotProduct[]>;
}

export class BuildError extends Error {
  override name = 'BuildError';
}

export function createBuildContext(snapshot: CatalogSnapshot, input: BuildInput): BuildContext {
  for (const lang of ['ar', 'fr'] as const) {
    const missing = REQUIRED_STRING_KEYS.filter((k) => typeof input.strings[lang][k] !== 'string');
    if (missing.length) throw new BuildError(`strings.${lang}: missing ${missing.join(', ')}`);
  }
  if (!isSiteOrigin(input.siteUrl.replace(/\/+$/, ''))) throw new BuildError(`siteUrl must be a site origin (https://host.tld, or a local dev origin): ${input.siteUrl}`);
  const router = createRouter(snapshot, input.pageSize);
  const categories = publishedCategories(snapshot);
  const products = publishedProducts(snapshot, categories);
  const subtreeProducts = new Map<Id, SnapshotProduct[]>();
  for (const c of categories) {
    const ids = categoryDescendantIds(snapshot, c.id);
    subtreeProducts.set(c.id, products.filter((p) => ids.has(p.categoryId)));
  }
  const variantOwner = new Map<Id, { product: SnapshotProduct; variant: SnapshotVariant }>();
  for (const p of snapshot.products) for (const v of p.variants) variantOwner.set(v.id, { product: p, variant: v });

  const ctx: BuildContext = {
    snapshot,
    router,
    siteUrl: input.siteUrl.replace(/\/+$/, ''),
    strings: input.strings,
    images: input.images,
    lowStockThreshold: input.lowStockThreshold ?? 3,
    relatedCount: input.relatedCount ?? 4,
    featuredCount: input.featuredCount ?? 8,
    strictCopy: input.strictCopy ?? (typeof process !== 'undefined' && process.env['HB_STRICT_COPY'] === '1'),
    products,
    categories,
    contents: publishedContentPages(snapshot),
    productById: new Map(snapshot.products.map((p) => [p.id, p])),
    publishedProductIds: new Set(products.map((p) => p.id)),
    categoryById: new Map(snapshot.categories.map((c) => [c.id, c])),
    publishedCategoryIds: new Set(categories.map((c) => c.id)),
    variantOwner,
    subtreeProducts,
  };
  // Fail early on a published image the manifest lacks (CAT-4 must have encoded every one).
  for (const p of products) for (const img of p.images) imageEntry(ctx, img);
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** A brand string; missing ⇒ BuildError; `[PLACEHOLDER]` ⇒ BuildError when `strictCopy`. */
function copy(ctx: BuildContext, lang: Lang, key: string): string {
  const raw = ctx.strings[lang][key];
  if (raw === undefined) throw new BuildError(`strings.${lang}: missing ${key}`);
  if (ctx.strictCopy && raw.includes('[PLACEHOLDER]')) throw new BuildError(`strings.${lang}: "${key}" is a placeholder (HB_STRICT_COPY=1)`);
  return raw;
}

const t = (ctx: BuildContext, lang: Lang, key: string, vars: Readonly<Record<string, string | number>> = {}): string => {
  const raw = copy(ctx, lang, key);
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
};

const titled = (ctx: BuildContext, lang: Lang, title: string): string => t(ctx, lang, 'meta.titleTemplate', { title });

/** Plain-text paragraphs from a description (blank-line separated). */
export const paragraphs = (text: string): string[] =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

function imageEntry(ctx: BuildContext, img: SnapshotImage) {
  const e = ctx.images[img.key];
  if (!e || e.candidates.length === 0) throw new BuildError(`image manifest has no entry for "${img.key}" (image ${img.id})`);
  // The manifest is loaded from disk: its URLs go through the same allow-list as everything else.
  for (const c of e.candidates) assertSameOriginPath(c.url, `image ${img.key}`);
  if (e.og) assertSameOriginPath(e.og.url, `og image ${img.key}`);
  return e;
}

export function toImageProps(ctx: BuildContext, img: SnapshotImage, lang: Lang, slot: ImageSlot, lcp = false): ImageProps {
  const e = imageEntry(ctx, img);
  const fallback = [...e.candidates].reverse().find((c) => c.width <= 720) ?? e.candidates[0]!;
  return {
    src: fallback.url,
    srcset: e.candidates.map((c) => `${c.url} ${c.width}w`).join(', '),
    sizes: SLOT_SIZES[slot],
    candidates: e.candidates,
    width: fallback.width,
    height: fallback.height,
    alt: img.alt[lang],
    type: 'image/avif',
    lcp,
    placeholder: img.placeholder,
  };
}

const optionValueOf = (i: SnapshotImage): Id | null => i.optionValueId ?? null;
const isGeneral = (i: SnapshotImage): boolean => i.variantId === null && optionValueOf(i) === null;

/**
 * Gallery order: general images, then option-value images (option position, value position),
 * then variant images; each group by image position. `[0]` is the main/LCP image.
 */
function orderedImages(p: SnapshotProduct): SnapshotImage[] {
  const byPos = (a: SnapshotImage, b: SnapshotImage): number => a.position - b.position || a.id - b.id;
  const valueRank = new Map<Id, number>();
  [...p.options]
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .forEach((o, oi) => [...o.values].sort((a, b) => a.position - b.position || a.id - b.id).forEach((x, xi) => valueRank.set(x.id, oi * 10_000 + xi)));
  const byValue = (a: SnapshotImage, b: SnapshotImage): number =>
    (valueRank.get(optionValueOf(a)!) ?? 0) - (valueRank.get(optionValueOf(b)!) ?? 0) || byPos(a, b);
  return [
    ...p.images.filter(isGeneral).sort(byPos),
    ...p.images.filter((i) => optionValueOf(i) !== null).sort(byValue),
    ...p.images.filter((i) => i.variantId !== null).sort(byPos),
  ];
}

const mainImage = (p: SnapshotProduct): SnapshotImage | undefined => orderedImages(p)[0];

function ogImageFor(ctx: BuildContext, img: SnapshotImage | undefined, lang: Lang): OgImage | null {
  if (!img) return null;
  const og = imageEntry(ctx, img).og;
  return og ? { url: og.url, width: 1200, height: 630, alt: img.alt[lang] } : null;
}

const activeVariants = (p: SnapshotProduct): SnapshotVariant[] => p.variants.filter((v) => v.active);

function price(lang: Lang, amount: number, compareAt: number | null, from: boolean): PriceProps {
  return {
    amountDzd: amount,
    label: formatPrice(amount, lang),
    compareAtDzd: compareAt,
    compareAtLabel: compareAt === null ? null : formatPrice(compareAt, lang),
    discountPercent: compareAt === null ? null : Math.round(((compareAt - amount) / compareAt) * 100),
    from,
  };
}

function variantStock(ctx: BuildContext, v: SnapshotVariant): StockProps {
  if (v.stock === null) return { state: 'in_stock', qty: null };
  if (v.stock === 0) return { state: 'out_of_stock', qty: 0 };
  return { state: v.stock <= ctx.lowStockThreshold ? 'low_stock' : 'in_stock', qty: v.stock };
}

/** Best state among active variants (in > low > out); qty = sum, null when any is untracked. */
function productStock(ctx: BuildContext, p: SnapshotProduct): StockProps {
  const states = activeVariants(p).map((v) => variantStock(ctx, v));
  const qty = states.some((s) => s.qty === null) ? null : states.reduce((n, s) => n + (s.qty ?? 0), 0);
  const state = states.some((s) => s.state === 'in_stock') ? 'in_stock' : states.some((s) => s.state === 'low_stock') ? 'low_stock' : 'out_of_stock';
  return { state, qty };
}

/**
 * The variants a customer can actually buy: active and not out of stock. Falls back to all active
 * variants only when none is available (the product then shows as out of stock anyway).
 * Every displayed choice (preselected variant, page price/stock, card from-price and discount,
 * swatches) is derived from this set (CAT-3 r1 F1/F2), so the storefront never advertises a
 * price or option the customer cannot order.
 */
function sellableVariants(ctx: BuildContext, p: SnapshotProduct): SnapshotVariant[] {
  const active = activeVariants(p);
  const available = active.filter((v) => variantStock(ctx, v).state !== 'out_of_stock');
  return available.length ? available : active;
}

/**
 * The variant preselected on the page and in the no-JS form: the admin's default when it is
 * available, else the first available active variant, else the default.
 */
export function effectiveDefaultVariant(ctx: BuildContext, p: SnapshotProduct): SnapshotVariant {
  const active = activeVariants(p);
  const flagged = active.find((x) => x.isDefault) ?? active[0];
  if (!flagged) throw new BuildError(`product ${p.id} has no active variant`);
  if (variantStock(ctx, flagged).state !== 'out_of_stock') return flagged;
  return active.find((v) => variantStock(ctx, v).state !== 'out_of_stock') ?? flagged;
}

function optionValueLabels(p: SnapshotProduct, lang: Lang): Map<Id, string> {
  return new Map(p.options.flatMap((o) => o.values.map((x) => [x.id, x.value[lang]] as const)));
}

function variantLabel(p: SnapshotProduct, v: SnapshotVariant, lang: Lang): string {
  const labels = optionValueLabels(p, lang);
  const order = new Map(p.options.flatMap((o) => o.values.map((x) => [x.id, o.position] as const)));
  return [...v.optionValueIds]
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    .map((id) => labels.get(id) ?? '')
    .join(' / ');
}

const isTranslationPlaceholder = (x: { readonly translationPlaceholder: readonly Lang[] }, lang: Lang): boolean =>
  x.translationPlaceholder.includes(lang);

const ref = (template: TemplateName, id?: Id, page?: number): PageRef =>
  (id === undefined ? { template } : page === undefined ? { template, id } : { template, id, page }) as PageRef;

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

export function productCard(ctx: BuildContext, p: SnapshotProduct, lang: Lang, lcp = false): ProductCard {
  const vs = sellableVariants(ctx, p);
  const cheapest = [...vs].sort((a, b) => a.priceDzd - b.priceDzd || a.id - b.id)[0]!;
  const from = new Set(vs.map((v) => v.priceDzd)).size > 1;
  const img = mainImage(p);
  const colourValues = new Set(vs.flatMap((v) => v.optionValueIds));
  const swatches = p.options
    .filter((o) => o.type === 'colour')
    .flatMap((o) => [...o.values].sort((a, b) => a.position - b.position || a.id - b.id))
    .filter((x) => colourValues.has(x.id) && x.swatchHex !== null)
    .slice(0, 6)
    .map((x) => ({ label: x.value[lang], hex: x.swatchHex! }));
  return {
    id: p.id,
    kind: p.kind,
    href: ctx.router.url(lang, ref('product', p.id)),
    name: p.name[lang],
    brandLatin: p.brandLatin,
    summary: p.summary[lang],
    image: img ? toImageProps(ctx, img, lang, 'card', lcp) : null,
    price: price(lang, cheapest.priceDzd, cheapest.compareAtDzd, from),
    stock: productStock(ctx, p),
    swatches,
    placeholder: p.placeholder,
    translationPlaceholder: isTranslationPlaceholder(p, lang),
  };
}

function categoryLink(ctx: BuildContext, c: SnapshotCategory, lang: Lang): CategoryLink {
  const products = ctx.subtreeProducts.get(c.id) ?? [];
  const fallback = products.map(mainImage).find((i) => i !== undefined);
  const img = c.image ?? fallback;
  return {
    id: c.id,
    name: c.name[lang],
    href: ctx.router.url(lang, ref('category', c.id)),
    count: products.length,
    image: img ? toImageProps(ctx, img, lang, 'card') : null,
    placeholder: c.placeholder,
  };
}

const topCategories = (ctx: BuildContext): SnapshotCategory[] => ctx.categories.filter((c) => c.parentId === null);
const childCategories = (ctx: BuildContext, id: Id): SnapshotCategory[] => ctx.categories.filter((c) => c.parentId === id);

function navTree(ctx: BuildContext, lang: Lang, parent: Id | null): NavCategory[] {
  return ctx.categories
    .filter((c) => c.parentId === parent)
    .map((c) => ({
      id: c.id,
      name: c.name[lang],
      href: ctx.router.url(lang, ref('category', c.id)),
      count: ctx.subtreeProducts.get(c.id)?.length ?? 0,
      placeholder: c.placeholder,
      children: navTree(ctx, lang, c.id),
    }));
}

/** Ancestors from the root down to `id` (inclusive). */
function categoryChain(ctx: BuildContext, id: Id): SnapshotCategory[] {
  const chain: SnapshotCategory[] = [];
  let cur = ctx.categoryById.get(id);
  while (cur && chain.length <= ctx.categoryById.size) {
    chain.unshift(cur);
    cur = cur.parentId === null ? undefined : ctx.categoryById.get(cur.parentId);
  }
  return chain;
}

function breadcrumbs(ctx: BuildContext, lang: Lang, chain: readonly SnapshotCategory[], current: string | null): Breadcrumb[] {
  const crumbs: Breadcrumb[] = [{ label: t(ctx, lang, 'catalog.home'), href: ctx.router.url(lang, ref('home')) }];
  chain.forEach((c, i) => {
    const isCurrent = current === null && i === chain.length - 1;
    crumbs.push({ label: c.name[lang], href: isCurrent ? null : ctx.router.url(lang, ref('category', c.id)) });
  });
  if (current !== null) crumbs.push({ label: current, href: null });
  return crumbs;
}

/** `0560417403` → `0560 41 74 03`; `213779942022` → `+213 779 942 022`. */
export function contactProps(ctx: BuildContext): ContactProps {
  const { contactPhone: phone, whatsapp: wa, contactEmail } = ctx.snapshot.settings;
  return {
    phoneDisplay: `${phone.slice(0, 4)} ${phone.slice(4, 6)} ${phone.slice(6, 8)} ${phone.slice(8)}`,
    phoneHref: `tel:+213${phone.slice(1)}`,
    whatsappDisplay: `+${wa.slice(0, 3)} ${wa.slice(3, 6)} ${wa.slice(6, 9)} ${wa.slice(9)}`,
    whatsappHref: `https://wa.me/${wa}`,
    email: contactEmail,
  };
}

function footerLinks(ctx: BuildContext, lang: Lang): FooterLink[] {
  return ctx.contents.map((c) => ({
    key: c.key,
    label: ctx.strings[lang][`links.${c.key}`] === undefined ? c.title[lang] : copy(ctx, lang, `links.${c.key}`),
    href: ctx.router.url(lang, ref('content', c.id)),
  }));
}

function stringsFor(ctx: BuildContext, lang: Lang): StringTable {
  return Object.fromEntries(Object.entries(ctx.strings[lang]).filter(([k]) => !k.startsWith('_meta.')));
}

interface LayoutExtras {
  readonly title: string;
  readonly description: string;
  readonly lcpImage: ImageProps | null;
  readonly ogImage: OgImage | null;
  readonly hasPlaceholders: boolean;
}

function layout(ctx: BuildContext, entry: RouteEntry, x: LayoutExtras): LayoutProps {
  const lang = entry.lang;
  const other = otherLang(lang);
  return {
    template: entry.template,
    lang,
    dir: dirOf(lang),
    title: x.title,
    description: x.description,
    path: entry.path,
    canonicalUrl: absoluteUrl(ctx.siteUrl, entry.path),
    alternates: entry.indexable ? alternatesFor(entry.paths, ctx.siteUrl) : [],
    languageSwitch: { lang: other, label: t(ctx, lang, 'chrome.langSwitch'), href: entry.paths[other] },
    noindex: !entry.indexable,
    storeName: ctx.snapshot.settings.storeName[lang],
    homeHref: ctx.router.url(lang, ref('home')),
    searchHref: ctx.router.url(lang, ref('search')),
    nav: navTree(ctx, lang, null),
    footerLinks: footerLinks(ctx, lang),
    contact: contactProps(ctx),
    strings: stringsFor(ctx, lang),
    lcpImage: x.lcpImage,
    ogImage: x.ogImage,
    preloadArabicFont: lang === 'ar',
    hasPlaceholders: x.hasPlaceholders,
  };
}

/** Cards/links with placeholder content, translation or photo (CAT-3 r1 F3: photos count too). */
const anyPlaceholder = (
  cards: readonly { placeholder: boolean; translationPlaceholder?: boolean; image?: { placeholder: boolean } | null }[],
): boolean => cards.some((c) => c.placeholder || c.translationPlaceholder === true || c.image?.placeholder === true);

const entryFor = (ctx: BuildContext, lang: Lang, r: PageRef): RouteEntry => {
  const path = ctx.router.url(lang, r);
  const e = ctx.router.entries({ template: r.template, lang }).find((x) => x.path === path);
  if (!e) throw new BuildError(`no route for ${JSON.stringify(r)} in ${lang}`);
  return e;
};

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------

export function buildHomeProps(ctx: BuildContext, lang: Lang): HomeProps {
  const entry = entryFor(ctx, lang, ref('home'));
  const { homeFeaturedProductIds, homeHeroProductId } = ctx.snapshot.settings;
  const named = homeFeaturedProductIds.filter((id) => ctx.publishedProductIds.has(id)).map((id) => ctx.productById.get(id)!);
  const featuredProducts = named.length ? named : ctx.products.slice(0, ctx.featuredCount);
  // Only an explicitly chosen, published hero product: no fallback (lead: a photo with burned-in
  // prices must never become the hero by accident; null ⇒ type-led hero without image).
  const heroProduct =
    homeHeroProductId !== null && ctx.publishedProductIds.has(homeHeroProductId) ? ctx.productById.get(homeHeroProductId) : undefined;
  const heroImg = heroProduct ? mainImage(heroProduct) : undefined;
  const heroImage = heroImg ? toImageProps(ctx, heroImg, lang, 'hero', true) : null;
  const featured = featuredProducts.map((p) => productCard(ctx, p, lang));
  const packs = ctx.products.filter((p) => p.kind === 'pack').slice(0, ctx.featuredCount).map((p) => productCard(ctx, p, lang));
  const categories = topCategories(ctx).map((c) => categoryLink(ctx, c, lang));
  const hero = { image: heroImage, product: heroProduct ? productCard(ctx, heroProduct, lang) : null };
  return {
    layout: layout(ctx, entry, {
      title: t(ctx, lang, 'meta.home.title'),
      description: t(ctx, lang, 'meta.home.description'),
      lcpImage: heroImage,
      ogImage: ogImageFor(ctx, heroImg, lang),
      hasPlaceholders: anyPlaceholder([...featured, ...packs, ...categories, ...(hero.product ? [hero.product] : [])]) || (heroImage?.placeholder ?? false),
    }),
    hero,
    categories,
    featured,
    packs,
  };
}

export function pagination(ctx: BuildContext, lang: Lang, categoryId: Id, page: number, pageCount: number): PaginationProps {
  const href = (n: number): string => ctx.router.url(lang, ref('category', categoryId, n));
  return {
    page,
    pageCount,
    prevHref: page > 1 ? href(page - 1) : null,
    nextHref: page < pageCount ? href(page + 1) : null,
    pages: Array.from({ length: pageCount }, (_, i) => ({ n: i + 1, href: href(i + 1), current: i + 1 === page })),
  };
}

export function buildCategoryProps(ctx: BuildContext, lang: Lang, categoryId: Id, page = 1): CategoryProps {
  const entry = entryFor(ctx, lang, ref('category', categoryId, page));
  const c = ctx.categoryById.get(categoryId)!;
  const all = ctx.subtreeProducts.get(categoryId) ?? [];
  const size = ctx.router.pageSize;
  const pageCount = Math.max(1, Math.ceil(all.length / size));
  const slice = all.slice((page - 1) * size, page * size);
  const products = slice.map((p, i) => productCard(ctx, p, lang, i === 0));
  const subCategories = childCategories(ctx, categoryId).map((x) => categoryLink(ctx, x, lang));
  const name = c.name[lang];
  const pageTitle = page > 1 ? `${name} · ${t(ctx, lang, 'catalog.pagination.page', { n: page })}` : name;
  return {
    layout: layout(ctx, entry, {
      title: titled(ctx, lang, t(ctx, lang, 'meta.category.title', { category: pageTitle })),
      description: c.description?.[lang] || t(ctx, lang, 'meta.category.description', { category: name }),
      lcpImage: products[0]?.image ?? null,
      ogImage: null,
      hasPlaceholders: c.placeholder || isTranslationPlaceholder(c, lang) || anyPlaceholder([...products, ...subCategories]),
    }),
    category: { id: c.id, name, description: c.description?.[lang] || null, href: ctx.router.url(lang, ref('category', c.id)), placeholder: c.placeholder },
    breadcrumbs: breadcrumbs(ctx, lang, categoryChain(ctx, categoryId), null),
    subCategories,
    products,
    totalCount: all.length,
    pagination: pagination(ctx, lang, categoryId, page, pageCount),
  };
}

/** Same category first, then the rest of the parent's subtree, then anything; listing order. */
function relatedProducts(ctx: BuildContext, p: SnapshotProduct): SnapshotProduct[] {
  const out: SnapshotProduct[] = [];
  const push = (xs: readonly SnapshotProduct[]): void => {
    for (const x of xs) if (x.id !== p.id && !out.includes(x) && out.length < ctx.relatedCount) out.push(x);
  };
  push(ctx.products.filter((x) => x.categoryId === p.categoryId));
  const parent = ctx.categoryById.get(p.categoryId)?.parentId ?? null;
  if (parent !== null) push(ctx.subtreeProducts.get(parent) ?? []);
  push(ctx.products);
  return out;
}

export function buildProductProps(ctx: BuildContext, lang: Lang, productId: Id): ProductProps {
  const entry = entryFor(ctx, lang, ref('product', productId));
  const p = ctx.productById.get(productId)!;
  const imgs = orderedImages(p);
  const images: ProductImageProps[] = imgs.map((img, i) => ({
    ...toImageProps(ctx, img, lang, 'gallery', i === 0),
    variantId: img.variantId,
    optionValueId: optionValueOf(img),
  }));
  const indexesWhere = (pred: (img: SnapshotImage) => boolean): number[] => imgs.flatMap((img, i) => (pred(img) ? [i] : []));
  const generalIdx = indexesWhere(isGeneral);
  const optionPos = new Map(p.options.flatMap((o) => o.values.map((x) => [x.id, o.position * 10_000 + o.id] as const)));
  const vs = activeVariants(p);
  const def = effectiveDefaultVariant(ctx, p);

  const variants: VariantProps[] = vs.map((v) => {
    const stock = variantStock(ctx, v);
    const own = indexesWhere((img) => img.variantId === v.id);
    const byValue = [...v.optionValueIds]
      .sort((a, b) => (optionPos.get(a) ?? 0) - (optionPos.get(b) ?? 0))
      .flatMap((vid) => indexesWhere((img) => optionValueOf(img) === vid));
    const specific = [...own, ...byValue];
    return {
      id: v.id,
      sku: v.sku,
      optionValueIds: v.optionValueIds,
      key: [...v.optionValueIds].sort((a, b) => a - b).join('-'),
      label: variantLabel(p, v, lang),
      price: price(lang, v.priceDzd, v.compareAtDzd, false),
      stock,
      imageIndex: specific[0] ?? null,
      imageIndexes: [...specific, ...generalIdx],
      isDefault: v.id === def.id,
      available: stock.state !== 'out_of_stock',
      maxQty: stock.state === 'out_of_stock' ? 0 : Math.min(stock.qty ?? ORDER_MAX_QTY, ORDER_MAX_QTY),
    };
  });
  const availableValues = new Set(variants.filter((v) => v.available).flatMap((v) => v.optionValueIds));
  const options: OptionProps[] = [...p.options]
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map((o) => ({
      id: o.id,
      type: o.type,
      name: o.name[lang],
      values: [...o.values]
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .map((x) => ({
          id: x.id,
          label: x.value[lang],
          imageIndexes: indexesWhere((img) => optionValueOf(img) === x.id),
          swatchHex: x.swatchHex,
          available: availableValues.has(x.id),
        })),
    }));

  const packItems: PackItemProps[] = p.packItems.map((it) => {
    const owner = ctx.variantOwner.get(it.variantId);
    if (!owner) throw new BuildError(`pack ${p.id}: unknown variant ${it.variantId}`);
    const img = mainImage(owner.product);
    return {
      variantId: it.variantId,
      productId: owner.product.id,
      name: owner.product.name[lang],
      brandLatin: owner.product.brandLatin,
      variantLabel: variantLabel(owner.product, owner.variant, lang),
      qty: it.qty,
      href: ctx.publishedProductIds.has(owner.product.id) ? ctx.router.url(lang, ref('product', owner.product.id)) : null,
      image: img ? toImageProps(ctx, img, lang, 'thumb') : null,
      placeholder: owner.product.placeholder,
    };
  });

  const related = relatedProducts(ctx, p).map((x) => productCard(ctx, x, lang));
  const cat = ctx.categoryById.get(p.categoryId)!;
  const defProps = variants.find((v) => v.id === def.id)!;

  const orderForm: OrderFormProps = {
    productId: p.id,
    kind: p.kind,
    singleVariant: variants.length === 1 && p.options.length === 0,
    defaultVariantId: def.id,
    variants,
    options,
    wilayas: [...ctx.snapshot.wilayas].sort((a, b) => a.code - b.code).map((w) => ({ code: w.code, label: `${w.code} - ${w.name[lang]}` })),
    communesUrlTemplate: communesUrlTemplate(lang),
    quoteEndpoint: '/api/quote',
    orderEndpoint: '/api/order',
    confirmationHref: ctx.router.url(lang, ref('order-confirmed')),
    turnstileSiteKey: ctx.snapshot.settings.turnstileSiteKey,
    qty: { min: 1, max: Math.max(1, ...variants.map((v) => v.maxQty)) },
    orderable: variants.some((v) => v.available),
  };

  const name = p.name[lang];
  return {
    layout: layout(ctx, entry, {
      title: titled(ctx, lang, t(ctx, lang, 'meta.product.title', { product: name })),
      description: t(ctx, lang, 'meta.product.description', { product: name, price: defProps.price.label }),
      lcpImage: images[0] ?? null,
      ogImage: ogImageFor(ctx, imgs[0], lang),
      hasPlaceholders:
        p.placeholder || isTranslationPlaceholder(p, lang) || imgs.some((i) => i.placeholder) || packItems.some((i) => i.placeholder) || anyPlaceholder(related),
    }),
    product: {
      id: p.id,
      kind: p.kind,
      name,
      brandLatin: p.brandLatin,
      summary: p.summary[lang],
      description: paragraphs(p.description[lang]),
      href: entry.path,
      placeholder: p.placeholder,
      translationPlaceholder: isTranslationPlaceholder(p, lang),
    },
    category: { id: cat.id, name: cat.name[lang], href: ctx.router.url(lang, ref('category', cat.id)) },
    orderStepHref: ctx.router.url(lang, ref('order-step', p.id)),
    breadcrumbs: breadcrumbs(ctx, lang, categoryChain(ctx, p.categoryId), name),
    images,
    price: defProps.price,
    stock: defProps.stock,
    options,
    variants,
    packItems,
    related,
    orderForm,
  };
}

export function buildSearchProps(ctx: BuildContext, lang: Lang): SearchProps {
  const entry = entryFor(ctx, lang, ref('search'));
  const categories = topCategories(ctx).map((c) => categoryLink(ctx, c, lang));
  const named = ctx.snapshot.settings.homeFeaturedProductIds.filter((id) => ctx.publishedProductIds.has(id)).map((id) => ctx.productById.get(id)!);
  const suggested = (named.length ? named : ctx.products.slice(0, ctx.featuredCount)).map((p) => productCard(ctx, p, lang));
  return {
    layout: layout(ctx, entry, {
      title: titled(ctx, lang, t(ctx, lang, 'meta.search.title')),
      description: t(ctx, lang, 'meta.search.description'),
      lcpImage: null,
      ogImage: null,
      hasPlaceholders: anyPlaceholder([...categories, ...suggested]),
    }),
    indexUrl: searchIndexPath(lang),
    queryParam: 'q',
    minQueryLength: 2,
    categories,
    suggested,
  };
}

export function buildContentProps(ctx: BuildContext, lang: Lang, contentId: Id): ContentProps {
  const entry = entryFor(ctx, lang, ref('content', contentId));
  const c = ctx.contents.find((x) => x.id === contentId)!;
  const title = c.title[lang];
  return {
    layout: layout(ctx, entry, {
      title: titled(ctx, lang, title),
      description: c.summary[lang],
      lcpImage: null,
      ogImage: null,
      hasPlaceholders: c.placeholder,
    }),
    page: { id: c.id, key: c.key, title, blocks: c.body[lang], placeholder: c.placeholder, updatedAt: c.updatedAt },
    breadcrumbs: breadcrumbs(ctx, lang, [], title),
  };
}

/** Summary photo for the order step: the main image with candidates ≤ 480 w only (plan §1/§4). */
function summaryImage(ctx: BuildContext, img: SnapshotImage, lang: Lang): ImageProps {
  const full = toImageProps(ctx, img, lang, 'summary', false);
  const kept = full.candidates.filter((c) => c.width <= 480);
  const candidates = kept.length ? kept : full.candidates.slice(0, 1);
  const top = candidates[candidates.length - 1]!;
  return {
    ...full,
    src: top.url,
    srcset: candidates.map((c) => `${c.url} ${c.width}w`).join(', '),
    candidates,
    width: top.width,
    height: top.height,
  };
}

/** ORDER-STEP: the prerendered order page of one published product (sold-out included). */
export function buildOrderStepProps(ctx: BuildContext, lang: Lang, productId: Id): OrderStepProps {
  const entry = entryFor(ctx, lang, ref('order-step', productId));
  const pp = buildProductProps(ctx, lang, productId);
  const p = ctx.productById.get(productId)!;
  const main = mainImage(p);
  const image = main ? summaryImage(ctx, main, lang) : null;
  const cta = t(ctx, lang, 'product.orderCta');
  const crumbs = pp.breadcrumbs.map((b, i) => (i === pp.breadcrumbs.length - 1 ? { label: b.label, href: pp.product.href } : b));
  return {
    layout: layout(ctx, entry, {
      title: titled(ctx, lang, `${cta} · ${pp.product.name}`),
      description: t(ctx, lang, 'meta.product.description', { product: pp.product.name, price: pp.price.label }),
      lcpImage: null,
      ogImage: null,
      hasPlaceholders: pp.product.placeholder || pp.product.translationPlaceholder || (image?.placeholder ?? false),
    }),
    product: {
      id: pp.product.id,
      kind: pp.product.kind,
      name: pp.product.name,
      brandLatin: pp.product.brandLatin,
      href: pp.product.href,
      placeholder: pp.product.placeholder,
      translationPlaceholder: pp.product.translationPlaceholder,
    },
    category: pp.category,
    image,
    price: pp.price,
    options: pp.options,
    variants: pp.variants,
    breadcrumbs: [...crumbs, { label: cta, href: null }],
    orderForm: pp.orderForm,
  };
}

export function buildOrderConfirmationProps(ctx: BuildContext, lang: Lang): OrderConfirmationProps {
  const entry = entryFor(ctx, lang, ref('order-confirmed'));
  const delivery = ctx.contents.find((c) => c.key === 'delivery');
  return {
    layout: layout(ctx, entry, {
      title: titled(ctx, lang, t(ctx, lang, 'meta.confirmation.title')),
      description: t(ctx, lang, 'meta.confirmation.description'),
      lcpImage: null,
      ogImage: null,
      hasPlaceholders: false,
    }),
    refParam: 'ref',
    deliveryHref: delivery ? ctx.router.url(lang, ref('content', delivery.id)) : null,
    continueHref: ctx.router.url(lang, ref('home')),
  };
}

export function buildNotFoundProps(ctx: BuildContext, lang: Lang): NotFoundProps {
  const entry = entryFor(ctx, lang, ref('not-found'));
  const categories = topCategories(ctx).map((c) => categoryLink(ctx, c, lang));
  return {
    layout: layout(ctx, entry, {
      title: titled(ctx, lang, t(ctx, lang, 'meta.notFound.title')),
      description: t(ctx, lang, 'meta.notFound.description'),
      lcpImage: null,
      ogImage: null,
      hasPlaceholders: anyPlaceholder(categories),
    }),
    categories,
  };
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

export type PageProps =
  | { readonly template: 'home'; readonly props: HomeProps }
  | { readonly template: 'category'; readonly props: CategoryProps }
  | { readonly template: 'product'; readonly props: ProductProps }
  | { readonly template: 'search'; readonly props: SearchProps }
  | { readonly template: 'content'; readonly props: ContentProps }
  | { readonly template: 'order-confirmed'; readonly props: OrderConfirmationProps }
  | { readonly template: 'order-step'; readonly props: OrderStepProps }
  | { readonly template: 'not-found'; readonly props: NotFoundProps };

/** Prop keys that carry a URL (checked on every built page). */
const URL_KEY = /(?:^|[a-z])(?:href|Href|url|Url|src)$|^canonicalUrl$/;

/**
 * Walks built props and checks every URL against the allow-list (`url.ts`): same-origin path,
 * `tel:`/`wa.me` (content links, contact), or an absolute URL on `siteUrl` (canonical,
 * alternates). `srcset` entries are checked one by one. Throws `UnsafeUrlError`.
 */
export function assertPropsUrls(value: unknown, siteUrl: string, path = 'props'): void {
  if (Array.isArray(value)) return value.forEach((v, i) => assertPropsUrls(v, siteUrl, `${path}[${i}]`));
  if (typeof value !== 'object' || value === null) return;
  for (const [k, v] of Object.entries(value)) {
    const at = `${path}.${k}`;
    if (typeof v === 'string' && URL_KEY.test(k)) {
      if (!(isSameOriginPath(v) || isAllowedExternalHref(v) || isSiteUrl(v, siteUrl))) throw new UnsafeUrlError(`${at}: ${JSON.stringify(v)}`);
    } else if (typeof v === 'string' && k === 'srcset') {
      for (const part of v.split(', ')) {
        const m = /^(\S+) \d+w$/.exec(part);
        if (!m || !isSameOriginPath(m[1]!)) throw new UnsafeUrlError(`${at}: ${JSON.stringify(part)}`);
      }
    } else if (k !== 'strings') {
      assertPropsUrls(v, siteUrl, at);
    }
  }
}

export function buildPageProps(ctx: BuildContext, entry: RouteEntry): PageProps {
  const page = buildPagePropsUnchecked(ctx, entry);
  assertPropsUrls(page.props, ctx.siteUrl, entry.path);
  return page;
}

function buildPagePropsUnchecked(ctx: BuildContext, entry: RouteEntry): PageProps {
  const { lang, entityId: id } = entry;
  switch (entry.template) {
    case 'home':
      return { template: 'home', props: buildHomeProps(ctx, lang) };
    case 'category':
      return { template: 'category', props: buildCategoryProps(ctx, lang, id!, entry.page) };
    case 'product':
      return { template: 'product', props: buildProductProps(ctx, lang, id!) };
    case 'search':
      return { template: 'search', props: buildSearchProps(ctx, lang) };
    case 'content':
      return { template: 'content', props: buildContentProps(ctx, lang, id!) };
    case 'order-confirmed':
      return { template: 'order-confirmed', props: buildOrderConfirmationProps(ctx, lang) };
    case 'order-step':
      return { template: 'order-step', props: buildOrderStepProps(ctx, lang, id!) };
    case 'not-found':
      return { template: 'not-found', props: buildNotFoundProps(ctx, lang) };
  }
}

/** Every page of the site, both languages, route-map order. */
export function buildAllPages(ctx: BuildContext): { readonly entry: RouteEntry; readonly page: PageProps }[] {
  return ctx.router.entries().map((entry) => ({ entry, page: buildPageProps(ctx, entry) }));
}
