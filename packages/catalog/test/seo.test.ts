import { describe, expect, test } from 'vitest';
import { fixtureContext, FIXTURE_SITE_URL } from '../src/fixtures/props.ts';
import { buildSitemap, robotsTxt, sitemapXml } from '../src/seo.ts';

const ctx = fixtureContext();
const entries = buildSitemap(ctx);

describe('buildSitemap', () => {
  test('every indexable page in both languages, once; noindex pages never', () => {
    const indexable = ctx.router.entries().filter((e) => e.indexable);
    expect(entries.map((e) => e.loc)).toEqual(indexable.map((e) => FIXTURE_SITE_URL + e.path));
    expect(new Set(entries.map((e) => e.loc)).size).toBe(entries.length);
    for (const lang of ['ar', 'fr'] as const) {
      expect(entries.filter((e) => e.lang === lang).length).toBe(entries.length / 2);
    }
    const locs = entries.map((e) => e.loc).join('\n');
    expect(locs).not.toMatch(/search|order\/confirmation|404/);
    // home + 5 category pages (cuisine ×3, ustensiles, salle-de-bain) + 6 products + 2 content, ×2 languages
    expect(entries.length).toBe((1 + 5 + 6 + 2) * 2);
  });

  test('reciprocal alternates, x-default → the Arabic page', () => {
    const byLoc = new Map(entries.map((e) => [e.loc, e]));
    for (const e of entries) {
      expect(e.alternates.map((a) => a.hreflang)).toEqual(['ar', 'fr', 'x-default']);
      const ar = e.alternates[0]!.href;
      const fr = e.alternates[1]!.href;
      expect(e.alternates[2]!.href).toBe(ar);
      expect([ar, fr]).toContain(e.loc);
      // the twin lists the same set
      const twin = byLoc.get(e.loc === ar ? fr : ar)!;
      expect(twin.alternates).toEqual(e.alternates);
    }
  });

  test('lastmod only where the source has one (content pages)', () => {
    expect(entries.filter((e) => e.lastmod !== null).map((e) => e.template)).toEqual(['content', 'content', 'content', 'content']);
    expect(entries.find((e) => e.template === 'content')!.lastmod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('serialisers', () => {
  test('sitemap XML: urlset with xhtml alternates, escaped', () => {
    const xml = sitemapXml(entries);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">')).toBe(true);
    expect(xml.match(/<url>/g)!.length).toBe(entries.length);
    expect(xml.match(/<xhtml:link rel="alternate" hreflang="x-default" href="https:\/\/comptoirdeluxe\.example\/ar\/"\/>/g)!.length).toBe(2);
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
    const tricky = sitemapXml([{ loc: 'https://x.example/a?b=1&c=<2>', lang: 'fr', template: 'home', alternates: [], lastmod: null }]);
    expect(tricky).toContain('<loc>https://x.example/a?b=1&amp;c=&lt;2&gt;</loc>');
  });

  test('robots.txt', () => {
    expect(robotsTxt(FIXTURE_SITE_URL)).toBe('User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: https://comptoirdeluxe.example/sitemap.xml\n');
  });
});
