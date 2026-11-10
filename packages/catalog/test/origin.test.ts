import { describe, expect, test } from 'vitest';
import { buildAllPages } from '../src/build.ts';
import { fixtureContext } from '../src/fixtures/props.ts';
import { buildSitemap, robotsTxt } from '../src/seo.ts';
import { FIXTURE_ORIGIN, isPublishBuild, siteOriginFromEnv } from '../src/sources.ts';

describe('siteOriginFromEnv (lead ruling on CAT-6 r1: one origin source)', () => {
  test('HB_SITE_ORIGIN is required except with the fixture', () => {
    expect(() => siteOriginFromEnv({ HB_SNAPSHOT: 'seed' })).toThrow(/HB_SITE_ORIGIN is not set/);
    expect(() => siteOriginFromEnv({ HB_SNAPSHOT: '/x/export.json' })).toThrow(/not set/);
    expect(() => siteOriginFromEnv({})).toThrow(/not set/);
    expect(siteOriginFromEnv({ HB_SNAPSHOT: 'fixture' })).toBe(FIXTURE_ORIGIN);
  });
  test('validated and normalised', () => {
    expect(siteOriginFromEnv({ HB_SNAPSHOT: 'seed', HB_SITE_ORIGIN: 'https://comptoirdeluxe.com/' })).toBe('https://comptoirdeluxe.com');
    expect(() => siteOriginFromEnv({ HB_SNAPSHOT: 'seed', HB_SITE_ORIGIN: 'https://hb.dz/shop' })).toThrow(/rejected/);
    expect(() => siteOriginFromEnv({ HB_SNAPSHOT: 'seed', HB_SITE_ORIGIN: 'comptoirdeluxe.com' })).toThrow(/not https/);
  });
  test('local dev origin only outside publish builds (clean-checkout build uses http://localhost:8787)', () => {
    expect(siteOriginFromEnv({ HB_SNAPSHOT: 'seed', HB_SITE_ORIGIN: 'http://localhost:8787' })).toBe('http://localhost:8787');
    expect(siteOriginFromEnv({ HB_SNAPSHOT: 'fixture', HB_SITE_ORIGIN: 'http://localhost:8787' })).toBe('http://localhost:8787');
    expect(() => siteOriginFromEnv({ HB_SNAPSHOT: 'seed', HB_PUBLISH: '1', HB_SITE_ORIGIN: 'http://localhost:8787' })).toThrow(/publish build/);
    expect(() => siteOriginFromEnv({ HB_SNAPSHOT: '/x/export.json', HB_SITE_ORIGIN: 'http://localhost:8787' })).toThrow(/publish build/);
    expect(() => siteOriginFromEnv({ HB_SNAPSHOT: 'seed', HB_SITE_ORIGIN: 'https://127.0.0.1' })).toThrow(/IP literal/);
    expect(siteOriginFromEnv({ HB_SNAPSHOT: '/x/export.json', HB_SITE_ORIGIN: 'https://comptoirdeluxe.com' })).toBe('https://comptoirdeluxe.com');
  });
  test('CAT-6 r3: a publish build never falls back to the fixture origin or catalogue', async () => {
    expect(() => siteOriginFromEnv({ HB_SNAPSHOT: 'fixture', HB_PUBLISH: '1' })).toThrow(/publish build needs the real public origin/);
    expect(() => siteOriginFromEnv({ HB_SNAPSHOT: '/x/export.json' })).toThrow(/publish build needs/);
    expect(siteOriginFromEnv({ HB_SNAPSHOT: 'fixture' })).toBe(FIXTURE_ORIGIN);
    const { loadSnapshot } = await import('../src/sources.ts');
    await expect(loadSnapshot({ env: { HB_SNAPSHOT: 'fixture', HB_PUBLISH: '1' } })).rejects.toThrow(/cannot be published/);
    expect((await loadSnapshot({ env: { HB_SNAPSHOT: 'fixture' } })).meta.source).toBe('fixture');
  });
  test('isPublishBuild', () => {
    expect(isPublishBuild({ HB_SNAPSHOT: 'seed' })).toBe(false);
    expect(isPublishBuild({ HB_SNAPSHOT: 'fixture' })).toBe(false);
    expect(isPublishBuild({ HB_SNAPSHOT: 'seed', HB_PUBLISH: '1' })).toBe(true);
    expect(isPublishBuild({ HB_SNAPSHOT: 'out/snapshot.json' })).toBe(true);
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
