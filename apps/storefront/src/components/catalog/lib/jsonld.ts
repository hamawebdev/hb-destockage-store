import type { ProductProps, StockState } from '@hb/catalog';
import { defaultVariant } from './variants.ts';

const AVAIL: Record<StockState, string> = {
  in_stock: 'https://schema.org/InStock',
  low_stock: 'https://schema.org/LimitedAvailability',
  out_of_stock: 'https://schema.org/OutOfStock',
};

/**
 * schema.org `Product` with one `Offer` per active variant (price in integer DZD). Absolute URLs are derived from `layout.canonicalUrl`'s origin.
 */
export function productJsonLd(p: ProductProps): Record<string, unknown> {
  const origin = new URL(p.layout.canonicalUrl).origin;
  const abs = (path: string): string => new URL(path, origin).href;
  const largest = (i: ProductProps['images'][number]): string =>
    abs(i.candidates.reduce((a, b) => (b.width > a.width ? b : a), i.candidates[0] ?? { url: i.src, width: 0 }).url);
  const offers = p.variants.map((v) => ({
    '@type': 'Offer',
    sku: v.sku,
    ...(v.label ? { name: v.label } : {}),
    price: v.price.amountDzd,
    priceCurrency: 'DZD',
    availability: AVAIL[v.stock.state],
    url: p.layout.canonicalUrl,
  }));
  const def = defaultVariant(p.variants);
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.product.name,
    description: p.product.summary || p.product.description[0] || p.product.name,
    url: p.layout.canonicalUrl,
    ...(p.images.length ? { image: p.images.map(largest) } : {}),
    ...(def ? { sku: def.sku } : {}),
    ...(p.product.brandLatin ? { brand: { '@type': 'Brand', name: p.product.brandLatin } } : {}),
    category: p.category.name,
    offers: offers.length === 1 ? offers[0] : offers,
  };
}

/** JSON for an inline `<script type="application/ld+json">`: `<` escaped so text can never close the element. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
