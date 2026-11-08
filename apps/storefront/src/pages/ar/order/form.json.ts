// /ar/order/form.json: the order form's error copy, phone pattern and confirmation fallback (BUG-12). Built at build
// time from the same function whose content hash OrderForm.astro puts in data-cfg (?v=), so they cannot disagree.
// Fetched by /js/order.js after LCP; never blocks an order. Same origin. Owner: orderform.
import type { APIRoute } from 'astro';
import { orderFormConfigJson } from '../../../components/order/form-model.ts';
import { pageProps } from '../../../lib/catalog.ts';

export const GET: APIRoute = () => {
  const { layout } = pageProps('order-confirmed', 'ar');
  return new Response(orderFormConfigJson('ar', layout.strings, layout.contact).json, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
