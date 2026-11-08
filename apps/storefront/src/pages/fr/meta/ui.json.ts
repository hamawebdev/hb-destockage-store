// /fr/meta/ui.json: the consent choice's copy. Removed from an unconfigured build by hb-postbuild.
import type { APIRoute } from 'astro';
import { metaUiJson } from '../../../lib/meta-data.ts';
import { pageProps } from '../../../lib/catalog.ts';

export const GET: APIRoute = () =>
  new Response(metaUiJson(pageProps('order-confirmed', 'fr').layout), { headers: { 'content-type': 'application/json; charset=utf-8' } });
