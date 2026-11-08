// /ar/cart/items/<product id>.json: one product's names, photo, variants, prices and limits for the cart (static, D-008).
import type { APIRoute, GetStaticPaths } from 'astro';
import { cartItem, type CartItemJson } from '../../../../lib/cart-data.ts';
import { staticPaths } from '../../../../lib/catalog.ts';

export const getStaticPaths: GetStaticPaths = () =>
  staticPaths('order-step', 'ar').map(({ props }) => ({ params: { id: String(props.product.id) }, props: { item: cartItem(props) } }));

export const GET: APIRoute = ({ props }) =>
  new Response(JSON.stringify((props as { item: CartItemJson }).item), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
