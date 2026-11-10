/**
 * Generates the props fixtures (`packages/catalog/fixtures/props.<lang>.json`) from the fixture
 * snapshot, the copied brand strings and a stub image manifest. Every page of the fixture site,
 * keyed by path. Regenerate: `UPDATE_FIXTURES=1 npx vitest run test/fixtures.test.ts`.
 */
import { buildAllPages, createBuildContext, type BuildContext, type PageProps } from '../build.ts';
import { stubImageManifest } from '../image-stub.ts';
import type { Lang } from '../types.ts';
import { fixtureSnapshot } from './snapshot.ts';
import stringsAr from './strings.ar.json' with { type: 'json' };
import stringsFr from './strings.fr.json' with { type: 'json' };

export const FIXTURE_SITE_URL = 'https://comptoirdeluxe.example';
export const FIXTURE_PAGE_SIZE = 2;

export function fixtureContext(): BuildContext {
  return createBuildContext(fixtureSnapshot, {
    siteUrl: FIXTURE_SITE_URL,
    strings: { ar: stringsAr as Record<string, string>, fr: stringsFr as Record<string, string> },
    images: stubImageManifest(fixtureSnapshot),
    pageSize: FIXTURE_PAGE_SIZE,
  });
}

/** `{ "/ar/p/…/": { template, props }, … }` for one language. */
export function fixturePages(lang: Lang, ctx: BuildContext = fixtureContext()): Record<string, PageProps> {
  return Object.fromEntries(buildAllPages(ctx).filter((p) => p.entry.lang === lang).map((p) => [p.entry.path, p.page]));
}
