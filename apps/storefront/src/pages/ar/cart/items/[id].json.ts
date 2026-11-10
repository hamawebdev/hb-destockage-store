// /ar/cart/items/<product id>.json: one product's names, photo, variants, prices and limits for the cart (static, D-008).
import type { APIRoute, GetStaticPaths } from 'astro';
import { cartItem, type CartItemJson } from '../../../../lib/cart-data.ts';
import { cartEnabled, staticPaths } from '../../../../lib/catalog.ts';

// Cart off (CART-4): none (hb-postbuild also removes the folder and fails on any leftover).
export const getStaticPaths: GetStaticPaths = () =>
  (cartEnabled() ? staticPaths('order-step', 'ar') : []).map(({ props }) => ({ params: { id: String(props.product.id) }, props: { item: cartItem(props) } }));

export const GET: APIRoute = ({ props }) =>
  new Response(JSON.stringify((props as { item: CartItemJson }).item), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
