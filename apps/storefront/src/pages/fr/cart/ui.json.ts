// /fr/cart/ui.json: the cart sheet's copy, built from the same table as the page (content hash on the header's data-ui).
import type { APIRoute } from 'astro';
import { cartUiJson } from '../../../lib/cart-data.ts';
import { pageProps } from '../../../lib/catalog.ts';

export const GET: APIRoute = () =>
  new Response(cartUiJson(pageProps('order-confirmed', 'fr').layout.strings).json, { headers: { 'content-type': 'application/json; charset=utf-8' } });
