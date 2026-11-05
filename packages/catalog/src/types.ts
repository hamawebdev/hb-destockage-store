/**
 * CAT-1 — catalogue snapshot and page-props contract.
 *
 * Two halves:
 *  1. `CatalogSnapshot` — what `seed` (from `data/`) and `db` (`exportCatalogSnapshot`, publish
 *     pipeline) produce. It mirrors DB-1 (`packages/db/src/schema.ts`) table by table, grouped by
 *     aggregate: a product carries its options, variants, pack items and images, exactly the rows
 *     that reference `products.id` in D1. Field names are camelCase; bilingual columns
 *     `x_fr` / `x_ar` become one `x: Localized<string>`.
 *  2. Page props — what each storefront template receives. Built at build time by
 *     `packages/catalog` (CAT-3). Templates render props; they never compute prices, URLs, stock
 *     or alternates themselves.
 *
 * Conventions (binding for every producer and consumer):
 *  - Money is integer DZD (`…Dzd`). Never minor units, never floats.
 *  - Ids are the D1 integer primary keys (positive integers, stable across builds). Seed assigns
 *    them explicitly so a seeded D1 and a seed snapshot agree.
 *  - Slugs are per language, ASCII kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`), unique per entity type
 *    and language. Arabic slugs are transliterated: no percent-encoded paths on the static host.
 *  - Every URL in props is a root-relative path ending in `/` (or `.json`/`.avif` for files), same
 *    origin. Only `canonicalUrl`, `Alternate.href` and sitemap entries are absolute (they need
 *    `BuildOptions.siteUrl`).
 *  - Props are plain JSON-serialisable data (no functions, no Dates, no Maps).
 *  - Placeholders (`placeholder: true` in data) are carried into props so templates and QA can
 *    mark them; they are never silently dropped.
 */

// ---------------------------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------------------------

/** Same as SHARED-1 `Lang`. Re-exported from `@hb/shared` once SHARED-1 is on main. */
export type Lang = 'ar' | 'fr';
export const LANGS: readonly Lang[] = ['ar', 'fr'];
/** `/ar/` is the primary language and the `x-default` target. */
export const DEFAULT_LANG: Lang = 'ar';
export type Dir = 'rtl' | 'ltr';

/** One value per language. Same shape as SHARED-1 `Localized<T>`. */
export type Localized<T> = { readonly ar: T; readonly fr: T };

export type Id = number;

// ---------------------------------------------------------------------------------------------
// 1. Catalogue snapshot (input). Mirrors DB-1.
// ---------------------------------------------------------------------------------------------

export const SNAPSHOT_VERSION = 1;

export interface CatalogSnapshot {
  readonly meta: SnapshotMeta;
  /** Flat list; the tree is `parentId`. Only `active` categories get pages. */
  readonly categories: readonly SnapshotCategory[];
  /** Includes every status; builders publish only `status === 'active'`. */
  readonly products: readonly SnapshotProduct[];
  readonly contentPages: readonly SnapshotContentPage[];
  readonly settings: SnapshotSettings;
  /** All 69 wilayas (code 1–69); `validateSnapshot` requires all 69 unless `requireAllWilayas: false`
   *  (fixtures, partial dev builds). Communes are not here: geo assets come from `data/geo` (CAT-5). */
  readonly wilayas: readonly SnapshotWilaya[];
}

export interface SnapshotMeta {
  readonly version: typeof SNAPSHOT_VERSION;
  /** `seed` = built from `data/`; `d1` = exported by the publish pipeline; `fixture` = the invented
   *  test catalogue (never a production build). */
  readonly source: 'seed' | 'd1' | 'fixture';
  /** Epoch ms. */
  readonly generatedAt: number;
  /** `publish_runs.id` when `source === 'd1'`, else null. */
  readonly publishRunId: Id | null;
}

/** DB-1 `categories`. */
export interface SnapshotCategory {
  readonly id: Id;
  readonly parentId: Id | null;
  readonly slug: Localized<string>;
  readonly name: Localized<string>;
  readonly description: Localized<string> | null;
  /** Ascending. Siblings are ordered by `sort`, then `id`. */
  readonly sort: number;
  readonly active: boolean;
  readonly placeholder: boolean;
  /** Languages whose text (name, description, slug) is our translation, not the client's. `[]` when none. */
  readonly translationPlaceholder: readonly Lang[];
  /** Category's own image (DB-1 `images.category_id`; no binding). Absent/null ⇒ builders use
   *  the first product image in the category's subtree. */
  readonly image?: SnapshotImage | null;
}

export type ProductKind = 'simple' | 'variable' | 'pack';
export type ProductStatus = 'draft' | 'active' | 'archived';

/**
 * DB-1 `products` plus its child rows.
 * Invariants (checked by `validateSnapshot`):
 *  - ≥ 1 variant, exactly one `isDefault` among active variants.
 *  - `simple`: exactly 1 variant, no options. `pack`: exactly 1 variant, no options, ≥ 1 pack item.
 *  - `variable`: ≥ 1 option; every variant has exactly one value of each option; no two variants
 *    share a combination.
 *  - Pack items reference variants of non-pack products.
 */
export interface SnapshotProduct {
  readonly id: Id;
  readonly kind: ProductKind;
  readonly categoryId: Id;
  readonly slug: Localized<string>;
  readonly name: Localized<string>;
  /** Latin brand name, rendered in `<bdi lang="fr">` on Arabic pages. Null when unbranded. */
  readonly brandLatin: string | null;
  /** One or two sentences, plain text. Used on cards and as meta description. */
  readonly summary: Localized<string>;
  /** Product page body. Plain text paragraphs separated by blank lines (no HTML, no Markdown). */
  readonly description: Localized<string>;
  readonly status: ProductStatus;
  /** Content, price or photo is invented (e.g. a pack component's price). */
  readonly placeholder: boolean;
  /** Languages whose text (name, summary, description, option names/values, alts) is our translation. `[]` when none. */
  readonly translationPlaceholder: readonly Lang[];
  /** Ascending order inside its category listing (then `id`). */
  readonly sort: number;
  readonly options: readonly SnapshotOption[];
  readonly variants: readonly SnapshotVariant[];
  /** Only for `kind === 'pack'`; empty otherwise. */
  readonly packItems: readonly SnapshotPackItem[];
  /** Ordered by `position`. The first product-level image is the main image. */
  readonly images: readonly SnapshotImage[];
}

export type OptionType = 'size' | 'colour' | 'other';

/** DB-1 `product_options` + `option_values`. */
export interface SnapshotOption {
  readonly id: Id;
  readonly type: OptionType;
  readonly name: Localized<string>;
  readonly position: number;
  readonly values: readonly SnapshotOptionValue[];
}

export interface SnapshotOptionValue {
  readonly id: Id;
  readonly value: Localized<string>;
  /** `#rrggbb`, colour options only. */
  readonly swatchHex: string | null;
  readonly position: number;
}

/** DB-1 `variants` + `variant_option_values`. */
export interface SnapshotVariant {
  readonly id: Id;
  readonly sku: string;
  readonly priceDzd: number;
  /** Strike-through price; must be > `priceDzd` when set. */
  readonly compareAtDzd: number | null;
  /** Null = untracked (always orderable). 0 = out of stock. */
  readonly stock: number | null;
  readonly weightG: number | null;
  readonly active: boolean;
  readonly isDefault: boolean;
  /** One value id per product option. Empty for simple products and packs. */
  readonly optionValueIds: readonly Id[];
}

/** DB-1 `pack_items`. */
export interface SnapshotPackItem {
  readonly variantId: Id;
  readonly qty: number;
}

/** DB-1 `images`. */
export interface SnapshotImage {
  readonly id: Id;
  /**
   * Binding. Both null = general (whole product). `variantId` = one variant. `optionValueId` = every
   * variant with that option value (e.g. colour = red on a size × colour product). At most one of
   * the two is set. `optionValueId` is optional in data (absent = null).
   */
  readonly variantId: Id | null;
  readonly optionValueId?: Id | null;
  /**
   * The original's key: its path relative to `data/photos/`. `db`'s seed uploads `data/photos/*`
   * to R2 under the same keys, so a `d1` snapshot's key is also the R2 object key.
   */
  readonly key: string;
  /** Intrinsic size of the original, px. */
  readonly width: number;
  readonly height: number;
  readonly alt: Localized<string>;
  readonly position: number;
  readonly placeholder: boolean;
}

/** DB-1 `content_pages`. */
export interface SnapshotContentPage {
  readonly id: Id;
  /** Stable role, used for links from templates (footer, order form). */
  readonly key: ContentPageKey;
  readonly slug: Localized<string>;
  readonly title: Localized<string>;
  /** Plain one-line summary for `<meta name="description">`. */
  readonly summary: Localized<string>;
  readonly body: Localized<readonly ContentBlock[]>;
  readonly sort: number;
  readonly active: boolean;
  readonly placeholder: boolean;
  /** Epoch ms. */
  readonly updatedAt: number;
}

export type ContentPageKey = 'about' | 'delivery' | 'returns' | 'contact' | 'legal' | 'privacy';

/**
 * Structured body, no HTML in data (no sanitiser, no Markdown parser, nothing to escape wrong).
 * Text is plain; templates escape it. Links are same-origin paths, `tel:`, or `https://wa.me/…`;
 * render the text of `tel:`/`wa.me` links in `<bdi dir="ltr">` (brand puts phone numbers in link
 * blocks, never inside running text).
 */
export type ContentBlock =
  | { readonly type: 'h2'; readonly text: string }
  | { readonly type: 'p'; readonly text: string }
  | { readonly type: 'ul'; readonly items: readonly string[] }
  | { readonly type: 'ol'; readonly items: readonly string[] }
  | { readonly type: 'link'; readonly text: string; readonly href: string };

/** DB-1 `settings` (key/value), the keys the storefront needs. */
export interface SnapshotSettings {
  readonly storeName: Localized<string>;
  /** National format, e.g. `0560417403`. */
  readonly contactPhone: string;
  /** E.164 without `+`, e.g. `213779942022` (used in `https://wa.me/<this>`). */
  readonly whatsapp: string;
  readonly contactEmail: string | null;
  /**
   * Product ids featured on the home page, in order. Ids must exist (validator); ids of products
   * that are not published (draft/archived, inactive category) are skipped by the builders, so
   * archiving a featured product never fails a publish. None published ⇒ first products by `sort`.
   */
  readonly homeFeaturedProductIds: readonly Id[];
  /**
   * Product whose main image is the home hero (LCP). Null or unpublished ⇒ no hero product and no
   * hero image: the home page uses a type-led hero (no fallback to a featured product, whose photo
   * may carry burned-in prices). Only set it for photography fit to be a hero.
   */
  readonly homeHeroProductId: Id | null;
  /** Public Turnstile site key; null ⇒ the form does not load Turnstile (orders are flagged). */
  readonly turnstileSiteKey: string | null;
}

/** DB-1 `wilayas`. */
export interface SnapshotWilaya {
  /** 1–69. */
  readonly code: number;
  readonly name: Localized<string>;
  /** Courier's own code (58-wilaya scheme); null until the courier integration fills it (D-001). */
  readonly courierCode: string | null;
}

// ---------------------------------------------------------------------------------------------
// 2. Routes
// ---------------------------------------------------------------------------------------------

export type TemplateName =
  | 'home'
  | 'category'
  | 'product'
  | 'search'
  | 'content'
  | 'order-confirmed'
  | 'not-found';

/**
 * URL scheme (implemented in `routes.ts`; never build URLs by hand in templates):
 *   home             /ar/                       /fr/
 *   category         /ar/c/<slug>/              page n ≥ 2: /ar/c/<slug>/<n>/
 *   product          /ar/p/<slug>/
 *   search           /ar/search/
 *   order confirmed  /ar/order/confirmation/    (the order ref arrives as `?ref=HB-XXXXX`)
 *   content          /ar/<slug>/                (slug must not be a reserved segment)
 *   not found        /ar/404.html               (served by the static host for unknown /ar/… paths)
 * Sub-categories are flat (`/ar/c/<child-slug>/`); hierarchy is shown by breadcrumbs.
 */
export const RESERVED_SEGMENTS: readonly string[] = ['c', 'p', 'search', 'order', '404', 'img', 'js', 'fonts', 'geo', 'api'];

/** Reference to a page, resolved to a path by the router (`createRouter(snapshot).url(lang, ref)`). */
export type PageRef =
  | { readonly template: 'home' | 'search' | 'order-confirmed' | 'not-found' }
  | { readonly template: 'category'; readonly id: Id; readonly page?: number }
  | { readonly template: 'product'; readonly id: Id }
  | { readonly template: 'content'; readonly id: Id };

/** One generated page. `CAT-3` returns all of them; `shell` maps them to `getStaticPaths`. */
export interface RouteEntry {
  readonly template: TemplateName;
  readonly lang: Lang;
  /** Root-relative path, e.g. `/ar/c/kitchen/2/`. */
  readonly path: string;
  /** Path after `/<lang>/` without slashes at the ends, e.g. `c/kitchen/2`; `''` for home. */
  readonly param: string;
  /** Entity the page is about (category/product/content id), null for singletons. */
  readonly entityId: Id | null;
  /** 1 for non-paginated pages. */
  readonly page: number;
  /** Path of the same page in each language. */
  readonly paths: Localized<string>;
  /** False for not-found, order-confirmed and search (noindex), true otherwise. */
  readonly indexable: boolean;
}

// ---------------------------------------------------------------------------------------------
// 3. Images
// ---------------------------------------------------------------------------------------------

/** One AVIF candidate. Widths generated: 360, 480, 720, 960, 1200 (capped at the original's). */
export interface SrcsetCandidate {
  /** Same-origin, content-hashed: `/img/<hash>-<w>.avif`. */
  readonly url: string;
  readonly width: number;
  readonly height: number;
  /** Encoded size. Every candidate with width ≤ 960 is ≤ 25,000 bytes (CAT-4 enforces). */
  readonly bytes: number;
}

export const IMAGE_WIDTHS: readonly number[] = [360, 480, 720, 960, 1200];

/**
 * CAT-4 output, CAT-3 input: the encoded files for each original, keyed by `SnapshotImage.key`.
 * JSON-serialisable; the CLI writes it where `--manifest` says (convention:
 * `apps/storefront/.catalog/image-manifest.json`). Builders combine an entry with the image's alt,
 * the slot's `sizes` and the LCP flag into `ImageProps`.
 */
export type ImageManifest = Readonly<Record<string, ImageManifestEntry>>;

export interface ImageManifestEntry {
  readonly key: string;
  /** Content hash of the original (hex), the file-name stem. */
  readonly hash: string;
  /** Intrinsic size of the original (after orientation). */
  readonly original: { readonly width: number; readonly height: number };
  /**
   * Ascending width, never upscaled: every `IMAGE_WIDTHS` step ≤ the original's width, plus one
   * candidate at the original width when it falls between steps or below 360 (lead's ruling on
   * CAT-4 r1 Nit 1).
   */
  readonly candidates: readonly SrcsetCandidate[];
  /** 1200×630 JPEG for `og:image`; null when not generated. */
  readonly og: { readonly url: string; readonly bytes: number } | null;
  /** True when the entry is a stand-in (no encoded files; fixtures/tests only). */
  readonly stub: boolean;
}

/** Where an image is shown; decides `sizes`. Templates may override `sizes` for other uses. */
export type ImageSlot = 'hero' | 'gallery' | 'card' | 'thumb';
export const IMAGE_MAX_BYTES_UP_TO_960 = 25_000;

export interface ImageProps {
  /** Fallback `src`: the 720 w candidate (or the largest below it). */
  readonly src: string;
  /** Ready-made `srcset` attribute: `"/img/a-360.avif 360w, …"`. */
  readonly srcset: string;
  /** `sizes` for the slot the builder placed it in (card, gallery main…). Per slot, not fixed: a
   *  template reusing the image elsewhere (e.g. 64 px gallery thumbnails) overrides it. */
  readonly sizes: string;
  readonly candidates: readonly SrcsetCandidate[];
  /** Intrinsic size of `src` (sets `width`/`height` attributes → no layout shift). */
  readonly width: number;
  readonly height: number;
  readonly alt: string;
  readonly type: 'image/avif';
  /** True for the page's LCP image: render `loading="eager" fetchpriority="high"`; it is also `LayoutProps.lcpImage`. Otherwise `loading="lazy" decoding="async"`. */
  readonly lcp: boolean;
  readonly placeholder: boolean;
}

/** Social preview image (CAT-4): `/img/<hash>-og.jpg`, 1200×630, cover-cropped. */
export interface OgImage {
  readonly url: string;
  readonly width: 1200;
  readonly height: 630;
  readonly alt: string;
}

// ---------------------------------------------------------------------------------------------
// 4. Shared prop pieces
// ---------------------------------------------------------------------------------------------

/** Flat UI string table from `brand/copy/strings.<lang>.json` (dotted keys, e.g. `order.submit`). */
export type StringTable = Readonly<Record<string, string>>;

export interface Alternate {
  /** `ar`, `fr` or `x-default` (→ the `/ar/` page). */
  readonly hreflang: Lang | 'x-default';
  /** Absolute URL. */
  readonly href: string;
}

export interface LanguageSwitch {
  readonly lang: Lang;
  /** «العربية» or «Français». Render with `lang` attribute; «العربية» in the system font. */
  readonly label: string;
  /** Same page in the other language (root-relative). */
  readonly href: string;
}

export interface Breadcrumb {
  readonly label: string;
  /** Null for the current page (render as text with `aria-current="page"`). */
  readonly href: string | null;
}

export interface NavCategory {
  readonly id: Id;
  readonly name: string;
  readonly href: string;
  /** Active products in this category and all its descendants. */
  readonly count: number;
  readonly placeholder: boolean;
  readonly children: readonly NavCategory[];
}

export interface ContactProps {
  /** `0560417403`. Wrap in `<bdi dir="ltr">`. */
  readonly phoneDisplay: string;
  /** `tel:+213560417403`. */
  readonly phoneHref: string;
  /** `+213 779 942 022`. */
  readonly whatsappDisplay: string;
  /** `https://wa.me/213779942022` — a plain link, never a widget. */
  readonly whatsappHref: string;
  readonly email: string | null;
}

export interface FooterLink {
  readonly key: ContentPageKey;
  readonly label: string;
  readonly href: string;
}

export interface PriceProps {
  readonly amountDzd: number;
  /** `Intl` `ar-DZ` / `fr-DZ` currency string, e.g. `14.600 د.ج.` / `14 600 DA`. */
  readonly label: string;
  readonly compareAtDzd: number | null;
  readonly compareAtLabel: string | null;
  /** Whole percent saved, null without `compareAt`. */
  readonly discountPercent: number | null;
  /** Cards: true when the sellable variants (available ones; all active ones if none is available)
   *  have different prices and `amountDzd` is the lowest ("from …").
   *  Product page / variants: always false (exact price of that variant). */
  readonly from: boolean;
}

export type StockState = 'in_stock' | 'low_stock' | 'out_of_stock';

export interface StockProps {
  readonly state: StockState;
  /** Units at snapshot time. Stale by design: the order POST re-checks. Null = untracked: always
   *  orderable (state is `in_stock`). */
  readonly qty: number | null;
}

export interface ProductCard {
  readonly id: Id;
  readonly kind: ProductKind;
  readonly href: string;
  readonly name: string;
  readonly brandLatin: string | null;
  readonly summary: string;
  readonly image: ImageProps | null;
  readonly price: PriceProps;
  /** Product-level: best state among active variants (in > low > out); qty = sum, null if any untracked. */
  readonly stock: StockProps;
  /** Distinct colour values of sellable variants (available; all active if none), option-value
   *  order, max 6; `[]` when none. */
  readonly swatches: readonly { readonly label: string; readonly hex: string }[];
  readonly placeholder: boolean;
  /** This language's text is our translation. */
  readonly translationPlaceholder: boolean;
}

export interface CategoryLink {
  readonly id: Id;
  readonly name: string;
  readonly href: string;
  readonly count: number;
  readonly image: ImageProps | null;
  readonly placeholder: boolean;
}

// ---------------------------------------------------------------------------------------------
// 5. Template props
// ---------------------------------------------------------------------------------------------

/** What the base layout (`shell`) needs on every page. */
export interface LayoutProps {
  readonly template: TemplateName;
  readonly lang: Lang;
  readonly dir: Dir;
  /** `<title>`, already composed (`<page> — <store>`). */
  readonly title: string;
  readonly description: string;
  /** Root-relative path of this page. */
  readonly path: string;
  /** Absolute. */
  readonly canonicalUrl: string;
  /** Both languages + `x-default`, reciprocal. Empty when `noindex`. */
  readonly alternates: readonly Alternate[];
  readonly languageSwitch: LanguageSwitch;
  readonly noindex: boolean;
  readonly storeName: string;
  readonly homeHref: string;
  readonly searchHref: string;
  readonly nav: readonly NavCategory[];
  readonly footerLinks: readonly FooterLink[];
  readonly contact: ContactProps;
  readonly strings: StringTable;
  /** Preload with `<link rel="preload" as="image" type="image/avif" imagesrcset imagesizes fetchpriority="high">`. */
  readonly lcpImage: ImageProps | null;
  /** `og:image` (JPEG 1200×630 — link previews don't read AVIF). Null ⇒ the store default. */
  readonly ogImage: OgImage | null;
  /** True on `/ar/` pages only: preload the Arabic font. */
  readonly preloadArabicFont: boolean;
  /** Any placeholder content on this page (QA banner in dev builds). */
  readonly hasPlaceholders: boolean;
}

export interface HomeProps {
  readonly layout: LayoutProps;
  /** LCP. Null ⇒ text-only hero. */
  readonly hero: { readonly image: ImageProps | null; readonly product: ProductCard | null };
  /** Top-level categories. */
  readonly categories: readonly CategoryLink[];
  readonly featured: readonly ProductCard[];
  readonly packs: readonly ProductCard[];
}

export interface PaginationProps {
  readonly page: number;
  readonly pageCount: number;
  readonly prevHref: string | null;
  readonly nextHref: string | null;
  readonly pages: readonly { readonly n: number; readonly href: string; readonly current: boolean }[];
}

export interface CategoryProps {
  readonly layout: LayoutProps;
  readonly category: {
    readonly id: Id;
    readonly name: string;
    readonly description: string | null;
    readonly href: string;
    readonly placeholder: boolean;
  };
  readonly breadcrumbs: readonly Breadcrumb[];
  readonly subCategories: readonly CategoryLink[];
  /** This page's products (own + descendants'), ordered by sort. */
  readonly products: readonly ProductCard[];
  /** Products in the category and its descendants, all pages. */
  readonly totalCount: number;
  readonly pagination: PaginationProps;
}

export interface OptionValueProps {
  readonly id: Id;
  readonly label: string;
  /** Indexes into `ProductProps.images` bound to this value (e.g. the red photos), position order. */
  readonly imageIndexes: readonly number[];
  readonly swatchHex: string | null;
  /** At least one `available` variant has this value. */
  readonly available: boolean;
}

export interface OptionProps {
  readonly id: Id;
  readonly type: OptionType;
  readonly name: string;
  readonly values: readonly OptionValueProps[];
}

export interface VariantProps {
  readonly id: Id;
  readonly sku: string;
  /** Value ids in option order. */
  readonly optionValueIds: readonly Id[];
  /** `optionValueIds` sorted ascending, joined with `-`: lookup key for a chosen combination. `''` for single-variant products. */
  readonly key: string;
  /** e.g. `L / Rouge`; empty for single-variant products. */
  readonly label: string;
  readonly price: PriceProps;
  readonly stock: StockProps;
  /** Index into `ProductProps.images` to show when selected; null ⇒ keep current. */
  readonly imageIndex: number | null;
  /** Gallery for this variant, as indexes into `ProductProps.images`: images bound to the variant,
   *  then images bound to any of its option values (option order), then the general images. */
  readonly imageIndexes: readonly number[];
  /** The effective default: the admin's default variant when it is available, else the first
   *  available variant, else the admin's default. Preselected on the page and in the no-JS form. */
  readonly isDefault: boolean;
  /** `active && stock.state !== 'out_of_stock'`. Inactive variants are not in `variants` at all,
   *  so a combination with no entry in `variants` is unavailable too. */
  readonly available: boolean;
  /** Max orderable quantity: min(stock, ORDER_MAX_QTY); 0 when out of stock. */
  readonly maxQty: number;
}

export interface PackItemProps {
  readonly variantId: Id;
  readonly productId: Id;
  readonly name: string;
  readonly brandLatin: string | null;
  readonly variantLabel: string;
  readonly qty: number;
  /** Null when the contained product has no active page of its own. */
  readonly href: string | null;
  readonly image: ImageProps | null;
  readonly placeholder: boolean;
}

export const ORDER_MAX_QTY = 10;

export interface WilayaOption {
  readonly code: number;
  /** `<code> - <name>` in this language, e.g. `16 - الجزائر`. */
  readonly label: string;
}

/** Everything the order form (orderform) needs. Prices here are display-only: the server recomputes. */
export interface OrderFormProps {
  readonly productId: Id;
  readonly kind: ProductKind;
  /** True ⇒ hide the variant picker and post `defaultVariantId`. */
  readonly singleVariant: boolean;
  /** The effective default (see `VariantProps.isDefault`): never an out-of-stock variant while
   *  another one is available. */
  readonly defaultVariantId: Id;
  /** Same objects as `ProductProps.variants`. */
  readonly variants: readonly VariantProps[];
  readonly options: readonly OptionProps[];
  readonly wilayas: readonly WilayaOption[];
  /** This page's language already filled in; replace `{code}` with the wilaya code:
   *  `/geo/communes/ar/{code}.json`. Body: `[[communeId, "name"], …]`, collated for that language. */
  readonly communesUrlTemplate: string;
  readonly quoteEndpoint: '/api/quote';
  /** Form `action` (POST, works without JS: the Worker renders the review step). */
  readonly orderEndpoint: '/api/order';
  readonly confirmationHref: string;
  readonly turnstileSiteKey: string | null;
  readonly qty: { readonly min: 1; readonly max: number };
  /** False when every variant is out of stock: render the form disabled + WhatsApp link. */
  readonly orderable: boolean;
}

/** A gallery image with its binding (see `SnapshotImage`). */
export interface ProductImageProps extends ImageProps {
  readonly variantId: Id | null;
  readonly optionValueId: Id | null;
}

export interface ProductProps {
  readonly layout: LayoutProps;
  readonly product: {
    readonly id: Id;
    readonly kind: ProductKind;
    readonly name: string;
    readonly brandLatin: string | null;
    readonly summary: string;
    /** Plain-text paragraphs. */
    readonly description: readonly string[];
    readonly href: string;
    readonly placeholder: boolean;
    readonly translationPlaceholder: boolean;
  };
  /** The product's own category (for "more in …" and JSON-LD `category`). */
  readonly category: { readonly id: Id; readonly name: string; readonly href: string };
  readonly breadcrumbs: readonly Breadcrumb[];
  /** All images in order; `images[0]` is the LCP image (`lcp: true`). */
  readonly images: readonly ProductImageProps[];
  /** The effective default variant's price (`from` false). The picker swaps in `variants[i].price`. */
  readonly price: PriceProps;
  /** The effective default variant's stock. Whole-product availability: `orderForm.orderable`. */
  readonly stock: StockProps;
  /** Option order = `position`; values in `position` order. Empty for simple/pack. */
  readonly options: readonly OptionProps[];
  /** Active variants only, in snapshot order. Exactly one for simple/pack. */
  readonly variants: readonly VariantProps[];
  /** Non-empty only for packs. */
  readonly packItems: readonly PackItemProps[];
  readonly related: readonly ProductCard[];
  readonly orderForm: OrderFormProps;
}

export interface SearchProps {
  readonly layout: LayoutProps;
  /** Per-language index (`SearchIndex`), fetched by `public/js/search*.js`: `/search/ar.json`. */
  readonly indexUrl: string;
  /** GET form field name (the form also works without JS: it lands on this page with `?q=`). */
  readonly queryParam: 'q';
  readonly minQueryLength: 2;
  /** Shown before typing and without JS. */
  readonly categories: readonly CategoryLink[];
  readonly suggested: readonly ProductCard[];
}

/**
 * Per-language search index (CAT-5), short keys to save bytes.
 * `k` is the searchable text normalised with geo's `normalizeForSearch` (the JS applies the same
 * normalisation to the query).
 */
export interface SearchIndex {
  readonly v: 1;
  readonly lang: Lang;
  readonly entries: readonly SearchIndexEntry[];
}

export interface SearchIndexEntry {
  /** Product id. */
  readonly id: Id;
  /** Name. */
  readonly n: string;
  /** Latin brand or null. */
  readonly b: string | null;
  /** Category name. */
  readonly c: string;
  /** Price DZD (lowest). */
  readonly p: number;
  /** Product page path. */
  readonly u: string;
  /** 360 w thumbnail URL or null. */
  readonly t: string | null;
  /** Stock: 0 in stock, 1 low, 2 out. */
  readonly s: 0 | 1 | 2;
  /** Price is "from" (variants differ). */
  readonly f: boolean;
  /** Placeholder product. */
  readonly x: boolean;
  /** Normalised search key: name + brandLatin + category name + option value labels (this language). */
  readonly k: string;
}

export interface ContentProps {
  readonly layout: LayoutProps;
  readonly page: {
    readonly id: Id;
    readonly key: ContentPageKey;
    readonly title: string;
    readonly blocks: readonly ContentBlock[];
    readonly placeholder: boolean;
    readonly updatedAt: number;
  };
  readonly breadcrumbs: readonly Breadcrumb[];
}

export interface OrderConfirmationProps {
  readonly layout: LayoutProps;
  /** Query parameter carrying the order ref (`HB-XXXXX`); render it in `<bdi dir="ltr">`. */
  readonly refParam: 'ref';
  readonly deliveryHref: string | null;
  readonly continueHref: string;
}

export interface NotFoundProps {
  readonly layout: LayoutProps;
  readonly categories: readonly CategoryLink[];
}

// ---------------------------------------------------------------------------------------------
// 6. Build options (CAT-3)
// ---------------------------------------------------------------------------------------------

export interface BuildOptions {
  /** Absolute origin without trailing slash, e.g. `https://hbdestockage.dz`. */
  readonly siteUrl: string;
  /** Products per category page. Default 24. */
  readonly pageSize?: number;
  /** Stock at or below this (and > 0) ⇒ `low_stock`. Default 3. */
  readonly lowStockThreshold?: number;
  /** Related products per product page. Default 4. */
  readonly relatedCount?: number;
  /** Featured products on the home page when settings name none. Default 8. */
  readonly featuredCount?: number;
}
