/**
 * Build-time data for the cart (CART-0, D-008): the per-product JSON the sheet and the checkout read, and the sheet's
 * copy. Names, photos, prices and limits live here, per language, never in the visitor's browser storage.
 * Owner: shell.
 */
import { createHash } from 'node:crypto';
import type { OrderStepProps, StringTable } from '@hb/catalog';

/** Shape of /{lang}/cart/items/<product id>.json: consumed by public/js/cart-sheet.js and order.js. */
export interface CartItemJson {
  readonly id: number;
  readonly name: string;
  readonly href: string;
  readonly img: { readonly src: string; readonly srcset: string } | null;
  readonly options: readonly { readonly id: number; readonly name: string; readonly values: readonly { readonly id: number; readonly label: string }[] }[];
  readonly variants: readonly { readonly id: number; readonly label: string; readonly price: number; readonly max: number; readonly ok: boolean; readonly ovs: readonly number[] }[];
}

export function cartItem(p: OrderStepProps): CartItemJson {
  return {
    id: p.product.id,
    name: p.product.name,
    href: p.product.href,
    img: p.image ? { src: p.image.src, srcset: p.image.srcset } : null,
    options: p.options.map((o) => ({ id: o.id, name: o.name, values: o.values.map((v) => ({ id: v.id, label: v.label })) })),
    variants: p.variants.map((v) => ({ id: v.id, label: v.label, price: v.price.amountDzd, max: v.maxQty, ok: v.available, ovs: [...v.optionValueIds] })),
  };
}

/** Every string the sheet (cart-sheet.js) displays. Missing keys fail the build. */
const UI_KEYS = [
  'cart.title',
  'cart.add',
  'cart.added',
  'cart.count.zero',
  'cart.count.one',
  'cart.count.two',
  'cart.count.few',
  'cart.count.many',
  'cart.count.other',
  'cart.empty',
  'cart.total',
  'cart.deliveryNext',
  'cart.remove',
  'cart.qtyMax',
  'cart.linesMax',
  'cart.unavailable',
  'cart.unavailableNote',
  'cart.choose',
  'cart.loadFailed',
  'common.close',
  'confirmation.continue',
  'product.orderCta',
  'home.heroCta',
  'order.qty.decrease',
  'order.qty.increase',
] as const;

/** /{lang}/cart/ui.json and its content hash (`?v=` on the header's data-ui). */
export function cartUiJson(strings: StringTable): { json: string; version: string } {
  const out: Record<string, string> = {};
  for (const k of UI_KEYS) {
    const v = strings[k];
    if (v === undefined) throw new Error(`missing UI string "${k}"`);
    out[k] = v;
  }
  const json = JSON.stringify(out);
  return { json, version: createHash('sha256').update(json).digest('base64url').slice(0, 10) };
}
