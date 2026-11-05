/**
 * Template registry: which URL represents each storefront template in each language.
 *
 * Derived from the BUILT site, so it measures what was actually built: every HTML page under
 * dist is classified by `<html data-tpl>` (SHELL-1 writes the CAT-1 `TemplateName` there), else
 * by the CAT-1 URL scheme (packages/catalog/src/routes.ts). A page that fits neither is an
 * error: a new template must never be silently left out of the Lighthouse/axe/screenshot runs.
 *
 * MEAS-5 refines this (product simple/variable/pack, sub-category) from the catalogue snapshot.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { walk } from './lib/paths.ts';

export const TEMPLATES = ['home', 'category', 'product', 'search', 'content', 'order-confirmed', 'not-found'] as const;
export type Template = (typeof TEMPLATES)[number];
export type Lang = 'ar' | 'fr';

export interface PageInfo {
  /** URL path as served, e.g. `/ar/p/musaffat/`, `/ar/404.html` */
  url: string;
  file: string;
  lang: Lang | null;
  template: Template | null;
  /** how the template was decided */
  source: 'data-tpl' | 'url' | 'none';
  /** HTML file size in bytes (the heaviest page of a template is the one measured) */
  bytes: number;
}

export interface TemplateTarget {
  /** stable id used in file names, e.g. `product-ar`, `content-ar-tawsil` */
  id: string;
  template: Template;
  lang: Lang;
  url: string;
  /** HTTP status the page is expected to return when requested by this URL */
  expectStatus: number;
}

export interface Registry {
  pages: PageInfo[];
  targets: TemplateTarget[];
  /** pages that are not measured, with the reason */
  skipped: Array<{ url: string; reason: string }>;
  /** problems that must fail the run */
  errors: string[];
}

const RESERVED = new Set(['c', 'p', 'search', 'order', '404', 'img', 'js', 'fonts', 'geo', 'api', '_astro']);

/** Classify one URL path by the CAT-1 scheme. */
export function templateFromUrl(url: string): Template | null {
  const m = /^\/(ar|fr)\/(.*)$/.exec(url);
  if (!m) return null;
  const rest = m[2] ?? '';
  if (rest === '') return 'home';
  if (rest === '404.html') return 'not-found';
  if (/^c\/[^/]+\/(\d+\/)?$/.test(rest)) return 'category';
  if (/^p\/[^/]+\/$/.test(rest)) return 'product';
  if (rest === 'search/') return 'search';
  if (rest === 'order/confirmation/') return 'order-confirmed';
  if (/^[^/]+\/$/.test(rest) && !RESERVED.has(rest.slice(0, -1))) return 'content';
  return null;
}

export function urlOfFile(rel: string): string {
  return `/${rel}`.replace(/(^|\/)index\.html$/, '$1');
}

/** Read every page of a built site and pick one target per template and language. */
export function discover(dist: string): Registry {
  const pages: PageInfo[] = [];
  const errors: string[] = [];
  const skipped: Registry['skipped'] = [];
  for (const rel of walk(dist).filter((f) => f.endsWith('.html'))) {
    const url = urlOfFile(rel);
    const head = readFileSync(path.join(dist, rel), 'utf8').slice(0, 4000);
    const htmlTag = /<html\b[^>]*>/i.exec(head)?.[0] ?? '';
    const tpl = /\bdata-tpl\s*=\s*["']?([\w-]+)/i.exec(htmlTag)?.[1] ?? null;
    const seg = /^\/(ar|fr)\//.exec(url)?.[1];
    const lang: Lang | null = seg === 'ar' || seg === 'fr' ? seg : null;
    let template: Template | null = null;
    let source: PageInfo['source'] = 'none';
    if (tpl) {
      if ((TEMPLATES as readonly string[]).includes(tpl)) { template = tpl as Template; source = 'data-tpl'; }
      else errors.push(`${url}: unknown <html data-tpl="${tpl}"> (known: ${TEMPLATES.join(', ')}); add it to tools/measure/src/templates.ts`);
    } else {
      template = templateFromUrl(url);
      if (template) source = 'url';
    }
    if (lang && !template && !tpl) errors.push(`${url}: cannot tell its template (no <html data-tpl>, URL outside the CAT-1 scheme)`);
    const urlTpl = templateFromUrl(url);
    if (tpl && urlTpl && template && urlTpl !== template) errors.push(`${url}: data-tpl="${tpl}" but the URL scheme says ${urlTpl}`);
    pages.push({ url, file: rel, lang, template, source, bytes: statSync(path.join(dist, rel)).size });
  }

  const targets: TemplateTarget[] = [];
  for (const lang of ['ar', 'fr'] as const) {
    const mine = pages.filter((p) => p.lang === lang);
    if (!mine.length) { errors.push(`no pages under /${lang}/`); continue; }
    for (const t of TEMPLATES) {
      // heaviest HTML first (worst case for the budget; rev-c MEAS-2 r1 nit 3), then the shortest
      // URL (page 1 before /c/x/2/), then path order: deterministic
      const of = mine.filter((p) => p.template === t).sort((x, y) => y.bytes - x.bytes || x.url.length - y.url.length || x.url.localeCompare(y.url));
      if (!of.length) { errors.push(`template ${t} has no page in /${lang}/`); continue; }
      // content: every content page is its own target (they differ in length and blocks);
      // other templates: the first page in path order (deterministic)
      const chosen = t === 'content' ? of : of.slice(0, 1);
      for (const p of chosen) {
        const slug = t === 'content' ? `-${p.url.split('/')[2]}` : '';
        targets.push({ id: `${t}-${lang}${slug}`, template: t, lang, url: p.url, expectStatus: 200 });
      }
      for (const p of of) if (!chosen.includes(p)) skipped.push({ url: p.url, reason: `same template as ${chosen[0]?.url}` });
    }
  }
  for (const p of pages) if (!p.lang) skipped.push({ url: p.url, reason: 'outside /ar/ and /fr/' });
  return { pages, targets, skipped, errors };
}

/** Targets from an explicit list (`--urls file` / `--url`): template from the URL scheme. */
export function targetsFromUrls(urls: string[]): TemplateTarget[] {
  return urls.map((u, i) => {
    const url = u.startsWith('/') ? u : new URL(u).pathname;
    const lang = (/^\/(ar|fr)\//.exec(url)?.[1] ?? 'ar') as Lang;
    const template = templateFromUrl(url) ?? 'content';
    return { id: `${String(i + 1).padStart(2, '0')}-${template}-${lang}`, template, lang, url, expectStatus: 200 };
  });
}
