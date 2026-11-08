/**
 * The storefront's only door to the catalogue: CAT-1 route map + CAT-3 page props. Route files call
 * `staticPaths(template, lang)` in getStaticPaths, or `pageProps(template, lang)` for singletons.
 * URLs and props come only from @hb/catalog; templates render, never compute.
 * Owner: shell. Plan: artifacts/SHELL-0/plan.md §3.
 *
 * Inputs (env):
 *  - HB_SNAPSHOT (required; unset fails the build): `seed` | <export.json> | `fixture` (dev/tests
 *    only) — see @hb/catalog/sources loadSnapshot.
 *  - HB_SITE_ORIGIN: absolute origin (src/lib/site.mjs).
 *  - HB_IMAGE_MANIFEST: CAT-4 manifest, default apps/storefront/.catalog/image-manifest.json, written
 *    by `node packages/catalog/src/bin/images.ts --out apps/storefront/public --manifest …` before the
 *    build. Required for `seed`/export snapshots; `fixture` uses the stub manifest (no files) unless
 *    HB_IMAGE_MANIFEST is set.
 *  - HB_STRICT_COPY=1 (production): brand/copy/strings.{ar,fr}.json must exist; otherwise the
 *    catalogue's fixture copies of them are used.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CategoryProps,
  ContentProps,
  HomeProps,
  Lang,
  ImageManifest,
  Localized,
  NotFoundProps,
  OrderConfirmationProps,
  ProductProps,
  OrderStepProps,
  RouteEntry,
  SearchProps,
  StringTable,
  TemplateName,
} from '@hb/catalog';
import { buildPageProps, createBuildContext } from '@hb/catalog/build';
import { stubImageManifest } from '@hb/catalog/image-stub';
import { findRepoRoot, loadSnapshot, loadStrings } from '@hb/catalog/sources';
import { SITE_ORIGIN } from './site.mjs';
import { requireSnapshot } from './build-env.mjs';

export interface PropsByTemplate {
  home: HomeProps;
  category: CategoryProps;
  product: ProductProps;
  'order-step': OrderStepProps;
  search: SearchProps;
  content: ContentProps;
  'order-confirmed': OrderConfirmationProps;
  'not-found': NotFoundProps;
}

const repoRoot = findRepoRoot(process.cwd());

async function strings(): Promise<Localized<StringTable>> {
  if (existsSync(join(repoRoot, 'brand/copy/strings.ar.json')) || process.env['HB_STRICT_COPY'] === '1') return loadStrings(repoRoot);
  const fixture = (lang: Lang): StringTable =>
    JSON.parse(readFileSync(join(repoRoot, `packages/catalog/src/fixtures/strings.${lang}.json`), 'utf8')) as StringTable;
  return { ar: fixture('ar'), fr: fixture('fr') };
}

requireSnapshot(process.env);
const snapshot = await loadSnapshot({ repoRoot });
// TODO(CAT-4): replace the stub with the image manifest (AVIF variants written to public/img/).
function images(): ImageManifest {
  const explicit = process.env['HB_IMAGE_MANIFEST'];
  // The fixture snapshot has no originals: stub entries, unless a manifest is named explicitly
  // (a seed manifest left in .catalog/ must not be applied to the fixture).
  if (process.env['HB_SNAPSHOT'] === 'fixture' && explicit === undefined) return stubImageManifest(snapshot);
  const file = explicit ?? join(repoRoot, 'apps/storefront/.catalog/image-manifest.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as ImageManifest;
  throw new Error(`image manifest not found at ${file}: run CAT-4 first (node packages/catalog/src/bin/images.ts --out apps/storefront/public --manifest ${file})`);
}

// createBuildContext fails if a published image is missing from the manifest (no broken images ship).
const ctx = createBuildContext(snapshot, { siteUrl: SITE_ORIGIN, strings: await strings(), images: images() });

/** Route-file parameter names, by template (file names under src/pages/<lang>/). */
type ParamsByTemplate = {
  category: { path: string }; // c/[...path].astro → "cuisine" | "cuisine/2"
  product: { slug: string }; //  p/[slug].astro     → "tablier-de-cuisine"
  'order-step': { slug: string }; // order/[slug].astro → "tablier-de-cuisine"
  content: { slug: string }; //  [slug].astro       → "livraison"
};
type Multi = keyof ParamsByTemplate;
type Single = Exclude<TemplateName, Multi>;

function paramsOf<T extends Multi>(template: T, e: RouteEntry): ParamsByTemplate[T] {
  switch (template) {
    case 'category':
      return { path: e.param.replace(/^c\//, '') } as ParamsByTemplate[T];
    case 'product':
      return { slug: e.param.replace(/^p\//, '') } as ParamsByTemplate[T];
    case 'order-step':
      return { slug: e.param.replace(/^order\//, '') } as ParamsByTemplate[T];
    default:
      return { slug: e.param } as ParamsByTemplate[T];
  }
}

function propsOf<T extends TemplateName>(template: T, e: RouteEntry): PropsByTemplate[T] {
  const page = buildPageProps(ctx, e);
  if (page.template !== template) throw new Error(`route ${e.path}: expected ${template}, built ${page.template}`);
  return page.props as PropsByTemplate[T];
}

/** For getStaticPaths of a multi-page template in one language. */
export function staticPaths<T extends Multi>(template: T, lang: Lang): { params: ParamsByTemplate[T]; props: PropsByTemplate[T] }[] {
  return ctx.router.entries({ template, lang }).map((e) => ({ params: paramsOf(template, e), props: propsOf(template, e) }));
}

/** Props of a single-page template (home, search, order-confirmed, not-found) in one language. */
export function pageProps<T extends Single>(template: T, lang: Lang): PropsByTemplate[T] {
  const [e] = ctx.router.entries({ template, lang });
  if (!e) throw new Error(`route map has no ${template} page for ${lang}`);
  return propsOf(template, e);
}

/** Every route-map page (both languages); hb-postbuild checks each was built. */
export function allRoutes(): { path: string; template: TemplateName }[] {
  return ctx.router.entries().map((e) => ({ path: e.path, template: e.template }));
}
