import { describe, expect, test } from 'vitest';
import { buildAllPages } from '../src/build.ts';
import { fixtureContext } from '../src/fixtures/props.ts';
import { buildSitemap, robotsTxt } from '../src/seo.ts';
import { FIXTURE_ORIGIN, siteOriginFromEnv } from '../src/sources.ts';

describe('siteOriginFromEnv (lead ruling on CAT-6 r1: one origin source)', () => {
  test('HB_SITE_ORIGIN is required except with the fixture', () => {
    expect(() => siteOriginFromEnv({ HB_SNAPSHOT: 'seed' })).toThrow(/HB_SITE_ORIGIN is not set/);
    expect(() => siteOriginFromEnv({ HB_SNAPSHOT: '/x/export.json' })).toThrow(/not set/);
    expect(() => siteOriginFromEnv({})).toThrow(/not set/);
    expect(siteOriginFromEnv({ HB_SNAPSHOT: 'fixture' })).toBe(FIXTURE_ORIGIN);
  });
  test('validated and normalised', () => {
    expect(siteOriginFromEnv({ HB_SITE_ORIGIN: 'https://hbdestockagedz.com/' })).toBe('https://hbdestockagedz.com');
    expect(() => siteOriginFromEnv({ HB_SITE_ORIGIN: 'https://hb.dz/shop' })).toThrow(/not an origin/);
    expect(() => siteOriginFromEnv({ HB_SITE_ORIGIN: 'hbdestockagedz.com' })).toThrow(/not an origin/);
  });
});

test('a built site uses one origin everywhere: canonical (= og:url), hreflang, sitemap, robots', () => {
  const ctx = fixtureContext();
  const origin = ctx.siteUrl;
  const urls: string[] = [];
  for (const { page } of buildAllPages(ctx)) {
    const l = page.props.layout;
    urls.push(l.canonicalUrl, ...l.alternates.map((a) => a.href));
  }
  for (const e of buildSitemap(ctx)) urls.push(e.loc, ...e.alternates.map((a) => a.href));
  const sitemapLine = robotsTxt(origin).split('\n').find((x) => x.startsWith('Sitemap: '))!;
  urls.push(sitemapLine.slice('Sitemap: '.length));
  expect(urls.length).toBeGreaterThan(50);
  const origins = new Set(urls.map((u) => new URL(u).origin));
  expect([...origins]).toEqual([origin]);
});
