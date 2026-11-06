/**
 * CAT-6 — sitemap and robots data (pure). Every indexable page in both languages, each with the
 * reciprocal hreflang set (`ar`, `fr`, `x-default` → the Arabic page). Noindex pages (search,
 * order confirmation, 404) are never listed. Every URL goes through the `url.ts` allow-list.
 */
import type { BuildContext } from './build.ts';
import { absoluteUrl, alternatesFor } from './routes.ts';
import type { Alternate, Lang, TemplateName } from './types.ts';
import { isSiteUrl, UnsafeUrlError } from './url.ts';

export interface SitemapEntry {
  /** Absolute URL. */
  readonly loc: string;
  readonly lang: Lang;
  readonly template: TemplateName;
  /** `ar`, `fr`, `x-default`; absolute. */
  readonly alternates: readonly Alternate[];
  /** ISO date (YYYY-MM-DD) when the source has a real modification time (content pages), else null. */
  readonly lastmod: string | null;
}

export const SITEMAP_PATH = '/sitemap.xml';
export const ROBOTS_PATH = '/robots.txt';

export function buildSitemap(ctx: BuildContext): SitemapEntry[] {
  const contentUpdated = new Map(ctx.contents.map((c) => [c.id, c.updatedAt]));
  return ctx.router
    .entries()
    .filter((e) => e.indexable)
    .map((e) => {
      const loc = absoluteUrl(ctx.siteUrl, e.path);
      const alternates = alternatesFor(e.paths, ctx.siteUrl);
      for (const u of [loc, ...alternates.map((a) => a.href)]) {
        if (!isSiteUrl(u, ctx.siteUrl)) throw new UnsafeUrlError(`sitemap: ${JSON.stringify(u)}`);
      }
      const updated = e.template === 'content' && e.entityId !== null ? contentUpdated.get(e.entityId) : undefined;
      return {
        loc,
        lang: e.lang,
        template: e.template,
        alternates,
        lastmod: updated === undefined || updated === 0 ? null : new Date(updated).toISOString().slice(0, 10),
      };
    });
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** sitemaps.org 0.9 with xhtml:link hreflang alternates (Google's format). */
export function sitemapXml(entries: readonly SitemapEntry[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  ];
  for (const e of entries) {
    lines.push('<url>', `<loc>${xmlEscape(e.loc)}</loc>`);
    if (e.lastmod) lines.push(`<lastmod>${e.lastmod}</lastmod>`);
    for (const a of e.alternates) lines.push(`<xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${xmlEscape(a.href)}"/>`);
    lines.push('</url>');
  }
  lines.push('</urlset>', '');
  return lines.join('\n');
}

/**
 * robots.txt: everything crawlable (noindex pages must stay fetchable so crawlers see their
 * `noindex`), the Worker API excluded, sitemap advertised. Never varies by Accept-Language.
 */
export function robotsTxt(siteUrl: string): string {
  return ['User-agent: *', 'Allow: /', 'Disallow: /api/', `Sitemap: ${absoluteUrl(siteUrl, SITEMAP_PATH)}`, ''].join('\n');
}
