/**
 * Byte-budget checker for the built storefront (MEAS-1). A pure function of a directory:
 * `checkSite(dist, options)` → report. No network, no browser. The rules are documented in
 * tools/measure/README.md ("Budget rules"); each has a failing fixture in test/budget.test.ts.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseTags, has, attr, tokens, type Tag } from '../lib/html.ts';
import {
  brSize, parseSrcset, evalSizes, evalMedia, pickCandidate, isAvif, avifSize, cssUrls, fontFaces,
  FONT_EXT, JS_EXT, type Candidate,
} from '../lib/assets.ts';
import { walk } from '../lib/paths.ts';
import { BUDGETS, NON_FETCHING_RELS, JS_TYPES, type Budgets } from './config.ts';

export const RULES = {
  'site': 'The dist directory has HTML pages under /ar/ and /fr/',
  'html-size': 'HTML document incl. inline CSS within the brotli budget',
  'css-inline': 'Exactly one inline <style>; no external stylesheet, stylesheet preload or @import',
  'js-before-lcp': 'No script before the LCP element; no async, parser-blocking or preloaded JS anywhere',
  'js-inline-handler': 'No on* event-handler attributes and no javascript: URLs (hash-based CSP)',
  'speculation-rules': 'Speculation rules are inline and valid JSON',
  'js-after-lcp': 'All JS a page can load (incl. lazily injected first-party JS) within the brotli budget',
  'critical-path': 'HTML + preloads + LCP image + fonts + pre-LCP images + CSS url() within bytes and request count',
  'lcp-image': 'At most one fetchpriority=high image, not lazy; image preloads match an image on the page',
  'avif': 'AVIF srcsets list 360/480/720/960/1200 w, descriptors match the file, small widths within the byte budget',
  'third-party': 'No resource from another origin before LCP (navigation <a href> is allowed)',
  'fr-font': '/fr/ pages load no web font (system stack), never the Arabic font',
  'ar-font': '/ar/ pages: at most one font file, font-display: optional, preloaded as=font with crossorigin',
  'html-lang-dir': '<html lang dir> matches the page language (ar → rtl, fr → ltr)',
  'missing-asset': 'Every first-party resource a page references exists in dist',
} as const;

export type RuleId = keyof typeof RULES;
export interface Violation { rule: RuleId; message: string }
export interface Options { ownOrigins?: string[]; budgets?: Partial<Budgets> }

export interface CriticalRequest { kind: string; url: string; bytes: number }
export interface PageResult {
  page: string;
  url: string;
  lang: string;
  ok: boolean;
  metrics: {
    htmlBytes: number;
    htmlBr: Record<string, number>;
    htmlBrGate: number;
    htmlTarget: 'below' | 'within' | 'above';
    inlineCssBytes: number;
    lcpElement: string;
    js: { files: Array<{ path: string; br: number; via: string }>; inlineBr: number; totalBr: number; lazyThirdPartyOrigins: string[] };
    critical: { requests: CriticalRequest[]; bytes: number; count: number };
    avif: Array<{ url: string; declaredW?: number; width?: number; bytes: number }>;
  };
  violations: Violation[];
  warnings: string[];
}
export interface SiteReport {
  tool: 'hb-budget';
  generatedAt: string;
  dist: string;
  budgets: Budgets;
  ownOrigins: string[];
  ok: boolean;
  summary: { pages: number; failingPages: number; violations: number; byRule: Partial<Record<RuleId, number>> };
  siteViolations: Violation[];
  pages: PageResult[];
}

interface Ctx { dist: string; budgets: Budgets; ownOrigins: Set<string>; files: Map<string, Buffer | null> }

type Resolved =
  | { kind: 'skip' }
  | { kind: 'js-url'; url: string }
  | { kind: 'same'; path: string; url: string }
  | { kind: 'third'; origin: string; url: string };

const BASE = 'http://hb.invalid/';
const BASE_ORIGIN = new URL(BASE).origin;
const TEXT_EXT = /\.(m?js|css|svg|json|html?|txt|xml|webmanifest)$/i;
const SKIP_SCHEME = /^(data|blob|about|mailto|tel|sms|geo|whatsapp|intent):/i;
const IMG_TYPES = new Set(['image/avif', 'image/webp', 'image/jpeg', 'image/png', 'image/gif', 'image/svg+xml']);

export function checkSite(dist: string, opts: Options = {}): SiteReport {
  const budgets: Budgets = { ...BUDGETS, ...(opts.budgets ?? {}) };
  const ownOrigins = new Set((opts.ownOrigins ?? []).map((o) => new URL(o).origin));
  const ctx: Ctx = { dist: path.resolve(dist), budgets, ownOrigins, files: new Map() };
  const siteViolations: Violation[] = [];
  const pages = walk(ctx.dist).filter((f) => /\.html?$/i.test(f));
  if (!existsSync(ctx.dist)) siteViolations.push({ rule: 'site', message: `dist not found: ${ctx.dist}` });
  else if (!pages.length) siteViolations.push({ rule: 'site', message: 'no HTML pages in dist' });
  else {
    for (const lang of ['ar', 'fr']) {
      if (!pages.some((p) => p.startsWith(`${lang}/`))) siteViolations.push({ rule: 'site', message: `no pages under /${lang}/` });
    }
  }
  const results = pages.map((p) => checkPage(ctx, p));
  const all = [...siteViolations, ...results.flatMap((r) => r.violations)];
  const byRule: Partial<Record<RuleId, number>> = {};
  for (const v of all) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
  return {
    tool: 'hb-budget',
    generatedAt: new Date().toISOString(),
    dist: ctx.dist,
    budgets,
    ownOrigins: [...ownOrigins],
    ok: all.length === 0,
    summary: { pages: results.length, failingPages: results.filter((r) => !r.ok).length, violations: all.length, byRule },
    siteViolations,
    pages: results,
  };
}

function checkPage(ctx: Ctx, rel: string): PageResult {
  const { budgets } = ctx;
  const violations: Violation[] = [];
  const warnings: string[] = [];
  const v = (rule: RuleId, message: string): void => { violations.push({ rule, message }); };
  const html = readFileSync(path.join(ctx.dist, rel), 'utf8');
  const docUrl = new URL(rel, BASE);
  const pageUrl = docUrl.pathname.replace(/(^|\/)index\.html?$/i, '$1');
  const tags = parseTags(html);
  const live = tags.filter((t) => !t.inert);
  const scanned = tags.filter((t) => t.inertIn !== 'template'); // noscript content loads in no-JS browsers

  // ---------- helpers ----------
  const resolve = (ref: string | undefined, base: URL = docUrl): Resolved => {
    const r = (ref ?? '').trim();
    if (!r || r.startsWith('#')) return { kind: 'skip' };
    if (/^javascript:/i.test(r)) return { kind: 'js-url', url: r };
    if (SKIP_SCHEME.test(r)) return { kind: 'skip' };
    let u: URL;
    try { u = new URL(r, base); } catch { return { kind: 'skip' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'skip' };
    if (u.origin === BASE_ORIGIN || ctx.ownOrigins.has(u.origin)) {
      let p = u.pathname;
      try { p = decodeURIComponent(p); } catch { /* keep raw */ }
      return { kind: 'same', path: p, url: u.pathname + u.search };
    }
    return { kind: 'third', origin: u.origin, url: u.href };
  };
  const samePath = (ref: string | undefined, base?: URL): string | null => {
    const r = resolve(ref, base);
    return r.kind === 'same' ? r.path : null;
  };
  const read = (p: string): Buffer | null => {
    const rp = p.endsWith('/') ? `${p}index.html` : p;
    const abs = path.normalize(path.join(ctx.dist, rp));
    if (!abs.startsWith(ctx.dist + path.sep)) return null;
    const cached = ctx.files.get(abs);
    if (cached !== undefined) return cached;
    let buf: Buffer | null = null;
    if (existsSync(abs) && statSync(abs).isFile()) buf = readFileSync(abs);
    else if (!path.extname(rp) && existsSync(path.join(abs, 'index.html'))) buf = readFileSync(path.join(abs, 'index.html'));
    ctx.files.set(abs, buf);
    return buf;
  };
  const gateBr = (buf: Buffer | string): number => Math.max(...budgets.brotliQualities.map((q) => brSize(buf, q)));
  const wire = (p: string, buf: Buffer): number => (TEXT_EXT.test(p) ? gateBr(buf) : buf.length);
  const missingReported = new Set<string>();
  const missing = (p: string, what: string): void => {
    if (missingReported.has(p)) return;
    missingReported.add(p);
    v('missing-asset', `${what} ${p} not found in dist`);
  };

  // ---------- html-lang-dir ----------
  const htmlTag = tags.find((t) => t.name === 'html');
  const seg = rel.split('/')[0] ?? '';
  const htmlLang = attr(htmlTag ?? { attrs: {} } as Tag, 'lang').toLowerCase();
  const lang = seg === 'ar' || seg === 'fr' ? seg : htmlLang.slice(0, 2);
  if (!htmlTag) v('html-lang-dir', 'no <html> element');
  else if (lang !== 'ar' && lang !== 'fr') v('html-lang-dir', `cannot tell the page language: <html lang="${attr(htmlTag, 'lang')}">`);
  else {
    if (!new RegExp(`^${lang}(-|$)`).test(htmlLang)) v('html-lang-dir', `<html lang="${attr(htmlTag, 'lang')}"> on a /${lang}/ page (expected ${lang} or ${lang}-DZ)`);
    const want = lang === 'ar' ? 'rtl' : 'ltr';
    if (attr(htmlTag, 'dir').toLowerCase() !== want) v('html-lang-dir', `<html dir="${attr(htmlTag, 'dir')}"> (expected dir="${want}")`);
  }

  // ---------- html-size ----------
  const htmlBytes = Buffer.byteLength(html);
  const htmlBr: Record<string, number> = {};
  for (const q of budgets.brotliQualities) htmlBr[`q${q}`] = brSize(html, q);
  const htmlBrGate = Math.max(...Object.values(htmlBr));
  if (htmlBrGate > budgets.htmlBrMax) v('html-size', `HTML is ${htmlBrGate} B brotli (budget ${budgets.htmlBrMax} B)`);
  const [tMin, tMax] = budgets.htmlBrTarget;
  const htmlTarget = htmlBrGate < tMin ? 'below' : htmlBrGate > tMax ? 'above' : 'within';
  if (htmlTarget === 'above') warnings.push(`HTML ${htmlBrGate} B brotli is above the ${tMin}–${tMax} B target`);

  // ---------- css-inline ----------
  const styles = live.filter((t) => t.name === 'style');
  const inlineCss = styles.map((t) => t.text ?? '').join('\n');
  if (styles.length !== 1) v('css-inline', `${styles.length} inline <style> elements (expected exactly 1)`);
  for (const t of scanned) {
    if (t.name !== 'link') continue;
    if (tokens(t, 'rel').includes('stylesheet')) v('css-inline', `external stylesheet <link rel="stylesheet" href="${attr(t, 'href')}">`);
    if (tokens(t, 'rel').includes('preload') && attr(t, 'as').toLowerCase() === 'style') v('css-inline', `stylesheet preload ${attr(t, 'href')}`);
  }
  if (/@import\b/i.test(inlineCss)) v('css-inline', '@import in inline CSS loads an external stylesheet');

  // ---------- LCP element ----------
  const hiImgs = live.filter((t) => t.name === 'img' && attr(t, 'fetchpriority').toLowerCase() === 'high');
  if (hiImgs.length > 1) v('lcp-image', `${hiImgs.length} <img fetchpriority="high"> (expected at most one LCP image)`);
  const lcpImg = hiImgs[0] ?? null;
  const h1 = live.find((t) => t.name === 'h1') ?? null;
  const lcpTag = lcpImg ?? h1;
  const lcpIndex = lcpTag ? lcpTag.index : Infinity;
  const lcpDesc = lcpImg ? '<img fetchpriority="high">' : h1 ? '<h1> (no LCP image on this page)' : 'end of document (no LCP image, no <h1>)';
  if (lcpImg && attr(lcpImg, 'loading').toLowerCase() === 'lazy') v('lcp-image', 'the LCP image has loading="lazy"');

  /** What a modern browser selects from for an <img>, respecting <picture><source>. */
  const imageChoice = (img: Tag): { srcset: string; sizes: string | undefined; src: string | undefined } => {
    const sources: Tag[] = [];
    let k = img.index - 1;
    for (; k >= 0 && tags[k]?.name === 'source'; k--) sources.unshift(tags[k] as Tag);
    if (tags[k]?.name === 'picture') {
      for (const s of sources) {
        const type = attr(s, 'type').toLowerCase().split(';')[0]?.trim() ?? '';
        if (type && !IMG_TYPES.has(type)) continue;
        if (has(s, 'media') && evalMedia(attr(s, 'media'), budgets.lcpViewport.width) === false) continue;
        return { srcset: attr(s, 'srcset'), sizes: s.attrs['sizes'], src: undefined };
      }
    }
    return { srcset: attr(img, 'srcset'), sizes: img.attrs['sizes'], src: img.attrs['src'] };
  };
  const choose = (c: { srcset: string; sizes: string | undefined; src: string | undefined }): Candidate | null => {
    const cands = parseSrcset(c.srcset);
    if (c.src && !cands.some((x) => x.w !== undefined || (x.x ?? 1) === 1)) cands.push({ url: c.src, x: 1 });
    const slot = cands.some((x) => x.w) ? evalSizes(c.sizes, budgets.lcpViewport.width) : budgets.lcpViewport.width;
    return pickCandidate(cands, slot, budgets.lcpViewport.dpr);
  };

  // ---------- third-party ----------
  const thirdSeen = new Set<string>();
  const checkRef = (ref: string | undefined, where: string): void => {
    const r = resolve(ref);
    if (r.kind === 'js-url') v('js-inline-handler', `javascript: URL in ${where}`);
    if (r.kind !== 'third') return;
    const key = `${r.origin} ${where}`;
    if (thirdSeen.has(key)) return;
    thirdSeen.add(key);
    v('third-party', `${r.origin} referenced by ${where}`);
  };
  for (const t of scanned) {
    const tagDesc = `<${t.name}${has(t, 'rel') ? ` rel="${attr(t, 'rel')}"` : ''}>`;
    if (t.name === 'a' || t.name === 'area' || t.name === 'form') {
      // navigation / submission targets are not fetched before LCP; only javascript: is refused
      for (const a of ['href', 'action']) if (/^\s*javascript:/i.test(attr(t, a))) v('js-inline-handler', `javascript: URL in <${t.name} ${a}>`);
    } else {
      for (const a of ['src', 'poster', 'data', 'background']) if (has(t, a)) checkRef(t.attrs[a], `${tagDesc} ${a}`);
      for (const a of ['srcset', 'imagesrcset']) if (has(t, a)) for (const c of parseSrcset(attr(t, a))) checkRef(c.url, `${tagDesc} ${a}`);
      if (t.name === 'link') {
        const rels = tokens(t, 'rel');
        if (!rels.length || rels.some((r) => !NON_FETCHING_RELS.has(r))) checkRef(t.attrs['href'], `${tagDesc} href`);
      } else if (t.name === 'base') {
        checkRef(t.attrs['href'], '<base href>');
      } else if (['use', 'image', 'feimage', 'script', 'mpath', 'textpath'].includes(t.name)) {
        if (has(t, 'href') || has(t, 'xlink:href')) checkRef(t.attrs['href'] ?? t.attrs['xlink:href'], `<${t.name} href>`);
      }
    }
    for (const [a, val] of Object.entries(t.attrs)) {
      if (/^on[a-z]+$/.test(a)) v('js-inline-handler', `<${t.name} ${a}="…"> event-handler attribute`);
      if (a === 'style') for (const u of cssUrls(val)) checkRef(u, `<${t.name} style> url()`);
    }
    if (t.name === 'style') for (const u of cssUrls(t.text ?? '')) checkRef(u, '<style> url()');
    if (t.name === 'script' && !has(t, 'src')) {
      const type = attr(t, 'type').trim().toLowerCase();
      if (JS_TYPES.has(type) || type === 'speculationrules' || type === 'importmap') {
        for (const u of absUrlsIn(t.text ?? '')) checkRef(u, `inline <script${type ? ` type="${type}"` : ''}>`);
      }
    }
    if (t.name === 'meta' && attr(t, 'http-equiv').toLowerCase() === 'refresh') {
      const m = /url\s*=\s*['"]?([^'"]+)/i.exec(attr(t, 'content'));
      if (m) checkRef(m[1], '<meta http-equiv="refresh">');
    }
  }

  // ---------- scripts: js-before-lcp, speculation-rules, js-after-lcp ----------
  const jsFiles: Array<{ path: string; br: number; via: string }> = [];
  let inlineJsBr = 0;
  const queue: Array<{ ref: string; base: URL; via: string }> = [];
  for (const t of live) {
    if (t.name === 'link') {
      const rels = tokens(t, 'rel');
      const as = attr(t, 'as').toLowerCase();
      if (rels.includes('modulepreload') || (rels.includes('preload') && (as === 'script' || JS_EXT.test(attr(t, 'href'))))) {
        v('js-before-lcp', `<link rel="${attr(t, 'rel')}" href="${attr(t, 'href')}"> fetches JS at high priority`);
        if (has(t, 'href')) queue.push({ ref: attr(t, 'href'), base: docUrl, via: `<link rel="${attr(t, 'rel')}">` });
      }
      continue;
    }
    if (t.name !== 'script') continue;
    const type = attr(t, 'type').trim().toLowerCase();
    const src = t.attrs['src'];
    if (type === 'speculationrules') {
      if (src !== undefined) v('speculation-rules', 'speculation rules must be inline (no src)');
      else {
        try { JSON.parse(t.text ?? ''); } catch (e) { v('speculation-rules', `invalid speculationrules JSON: ${(e as Error).message}`); }
      }
      continue;
    }
    if (!JS_TYPES.has(type)) continue; // data blocks (JSON-LD…) and import maps do not execute
    const desc = `<script${type ? ` type="${type}"` : ''}${src !== undefined ? ` src="${src}"` : ' (inline)'}${has(t, 'async') ? ' async' : ''}${has(t, 'defer') ? ' defer' : ''}>`;
    if (t.index < lcpIndex) v('js-before-lcp', `${desc} appears before the LCP element (${lcpDesc})`);
    if (has(t, 'async')) v('js-before-lcp', `${desc}: async scripts may run before LCP; use defer or type="module"`);
    else if (src !== undefined && type !== 'module' && !has(t, 'defer')) v('js-before-lcp', `${desc} is parser-blocking; use defer or type="module"`);
    if (src !== undefined) queue.push({ ref: src, base: docUrl, via: desc });
    else {
      const text = t.text ?? '';
      if (text.trim()) inlineJsBr += gateBr(text);
      for (const ref of jsRefs(text)) queue.push({ ref, base: docUrl, via: 'inline script' });
    }
  }
  // closure over the first-party JS reachable from the page: static imports, import(), and string
  // literals naming a .js file (a lazily injected <script src>)
  const seenJs = new Set<string>();
  const lazyThird = new Set<string>();
  for (let item = queue.shift(); item; item = queue.shift()) {
    const { ref, base, via } = item;
    const r = resolve(ref, base);
    if (r.kind === 'third') { lazyThird.add(r.origin); continue; }
    if (r.kind !== 'same' || seenJs.has(r.path)) continue;
    seenJs.add(r.path);
    let buf = read(r.path);
    let found = r.path;
    if (!buf && base !== docUrl && !ref.startsWith('/')) {
      // a relative string literal used as script.src resolves against the document, not the module
      const p2 = samePath(ref, docUrl);
      if (p2) { buf = read(p2); found = p2; }
    }
    if (!buf) { missing(r.path, `script (via ${via})`); continue; }
    jsFiles.push({ path: found, br: gateBr(buf), via });
    const text = buf.toString('utf8');
    const fileUrl = new URL(found, BASE);
    for (const sub of jsRefs(text)) queue.push({ ref: sub, base: fileUrl, via: found });
    for (const u of absUrlsIn(text)) {
      const ru = resolve(u);
      if (ru.kind === 'third') lazyThird.add(ru.origin);
    }
  }
  const jsBr = inlineJsBr + jsFiles.reduce((n, f) => n + f.br, 0);
  if (jsBr > budgets.jsBrMax) {
    const parts = jsFiles.map((f) => `${f.path} ${f.br} B`).concat(inlineJsBr ? [`inline ${inlineJsBr} B`] : []);
    v('js-after-lcp', `page can load ${jsBr} B brotli of JS (budget ${budgets.jsBrMax} B): ${parts.join(', ')}`);
  }

  // ---------- fonts ----------
  const faces = fontFaces(inlineCss);
  const fontPreloads = live.filter((t) => t.name === 'link' && tokens(t, 'rel').includes('preload')
    && (attr(t, 'as').toLowerCase() === 'font' || FONT_EXT.test(attr(t, 'href'))));
  // the first src URL of each @font-face is the one a woff2-capable browser fetches
  const facePaths = [...new Set(faces.map((f) => samePath(f.urls[0])).filter((p): p is string => !!p))];
  const allFontRefs = [...new Set([
    ...faces.flatMap((f) => f.urls),
    ...fontPreloads.map((t) => attr(t, 'href')),
    ...cssUrls(inlineCss).filter((u) => FONT_EXT.test(u)),
    ...live.filter((t) => t.name === 'link' && FONT_EXT.test(attr(t, 'href'))).map((t) => attr(t, 'href')),
  ].filter(Boolean))];
  if (lang === 'fr' && (allFontRefs.length || faces.length)) {
    const arabic = [
      ...allFontRefs.filter((u) => /arab/i.test(u)),
      ...faces.filter((f) => /arab/i.test(f.family) || /U\+06/i.test(f.unicodeRange ?? '')).map((f) => `@font-face "${f.family}"`),
    ];
    v('fr-font', arabic.length
      ? `French page references the Arabic font: ${[...new Set(arabic)].join(', ')}`
      : `French page references a web font (French uses the system stack): ${allFontRefs.join(', ') || faces.map((f) => f.family).join(', ')}`);
  }
  if (lang === 'ar') {
    const preloadPaths = fontPreloads.map((t) => samePath(attr(t, 'href'))).filter((p): p is string => !!p);
    const distinct = new Set([...facePaths, ...preloadPaths]);
    if (distinct.size > 1) v('ar-font', `${distinct.size} font files (expected one static Noto Sans Arabic 400 subset): ${[...distinct].join(', ')}`);
    for (const f of faces) {
      if (f.urls.length && f.display !== 'optional') v('ar-font', `@font-face "${f.family}" has font-display: ${f.display ?? '(unset = auto)'} (expected optional)`);
    }
    for (const p of facePaths) {
      const pre = fontPreloads.find((t) => samePath(attr(t, 'href')) === p);
      if (!pre) v('ar-font', `font ${p} is not preloaded (<link rel="preload" as="font" type="font/woff2" crossorigin>)`);
      else {
        if (!has(pre, 'crossorigin')) v('ar-font', `font preload ${p} lacks crossorigin (the font would be fetched twice)`);
        if (attr(pre, 'as').toLowerCase() !== 'font') v('ar-font', `font preload ${p} lacks as="font"`);
      }
    }
    for (const p of preloadPaths) if (!facePaths.includes(p)) v('ar-font', `font preload ${p} is not used by any @font-face`);
  }

  // ---------- image preloads must match an image on the page ----------
  const imgPaths = new Set<string>();
  for (const t of live) {
    if (t.name !== 'img' && t.name !== 'source') continue;
    for (const c of parseSrcset(attr(t, 'srcset'))) { const p = samePath(c.url); if (p) imgPaths.add(p); }
    const p = samePath(t.attrs['src']);
    if (p) imgPaths.add(p);
  }
  for (const t of live) {
    if (t.name !== 'link' || !tokens(t, 'rel').includes('preload') || attr(t, 'as').toLowerCase() !== 'image') continue;
    const urls = [...parseSrcset(attr(t, 'imagesrcset')).map((c) => c.url), ...(has(t, 'href') ? [attr(t, 'href')] : [])]
      .map((u) => samePath(u)).filter((p): p is string => !!p);
    if (urls.length && !urls.some((u) => imgPaths.has(u))) v('lcp-image', `image preload (${urls[0]}…) matches no <img>/<source> on the page`);
  }

  // ---------- critical path ----------
  const critical: CriticalRequest[] = [{ kind: 'html', url: pageUrl, bytes: htmlBrGate }];
  const critSeen = new Set<string>([pageUrl]);
  const addCrit = (kind: string, ref: string | undefined): void => {
    const r = resolve(ref);
    if (r.kind !== 'same' && r.kind !== 'third') return;
    const key = r.kind === 'same' ? r.path : r.url;
    if (critSeen.has(key)) return;
    critSeen.add(key);
    if (r.kind === 'third') { critical.push({ kind, url: r.url, bytes: 0 }); return; }
    const buf = read(r.path);
    if (!buf) { missing(r.path, kind); critical.push({ kind, url: r.path, bytes: 0 }); return; }
    critical.push({ kind, url: r.path, bytes: wire(r.path, buf) });
  };
  for (const t of live) {
    if (t.name !== 'link') continue;
    const rels = tokens(t, 'rel');
    if (!rels.includes('preload') && !rels.includes('modulepreload') && !rels.includes('stylesheet')) continue;
    if (attr(t, 'as').toLowerCase() === 'image' && has(t, 'imagesrcset')) {
      addCrit('preload image', choose({ srcset: attr(t, 'imagesrcset'), sizes: t.attrs['imagesizes'], src: t.attrs['href'] })?.url);
    } else addCrit(`preload ${attr(t, 'as') || rels.join(' ')}`, t.attrs['href']);
  }
  if (lcpImg) addCrit('LCP image', choose(imageChoice(lcpImg))?.url);
  for (const f of faces) if (f.urls[0]) addCrit('font', f.urls[0]);
  const faceUrls = new Set(faces.flatMap((f) => f.urls));
  for (const u of cssUrls(inlineCss)) if (!u.startsWith('data:') && !faceUrls.has(u)) addCrit('CSS url()', u);
  for (const t of live) {
    if (t.index >= lcpIndex) break;
    if (t.name === 'img' && t !== lcpImg && attr(t, 'loading').toLowerCase() !== 'lazy') addCrit('image before LCP', choose(imageChoice(t))?.url);
    if (t.name === 'script' && has(t, 'src')) addCrit('script before LCP', t.attrs['src']);
  }
  const critBytes = critical.reduce((n, c) => n + c.bytes, 0);
  if (critBytes > budgets.criticalBytesMax || critical.length > budgets.criticalRequestsMax) {
    v('critical-path', `critical path ${critBytes} B in ${critical.length} requests (budget ${budgets.criticalBytesMax} B in ${budgets.criticalRequestsMax}): ${critical.map((c) => `${c.kind} ${c.url} ${c.bytes} B`).join('; ')}`);
  }

  // ---------- avif ----------
  const avifs: PageResult['metrics']['avif'] = [];
  const avifSeen = new Set<string>();
  /** @returns true when the file is an AVIF */
  const checkAvifFile = (p: string, declaredW: number | undefined, where: string): boolean => {
    const buf = read(p);
    if (!buf) { missing(p, `image (${where})`); return /\.avif$/i.test(p); }
    if (!/\.avif$/i.test(p) && !isAvif(buf)) return false;
    const key = `${p} ${declaredW}`;
    if (avifSeen.has(key)) return true;
    avifSeen.add(key);
    const dim = avifSize(buf);
    avifs.push({ url: p, ...(declaredW !== undefined ? { declaredW } : {}), ...(dim ? { width: dim.width } : {}), bytes: buf.length });
    if (!dim) { v('avif', `${p}: not a readable AVIF (no avif ftyp brand / ispe box)`); return true; }
    if (declaredW !== undefined && declaredW !== dim.width) v('avif', `${p}: srcset says ${declaredW}w but the image is ${dim.width} px wide`);
    const w = Math.min(declaredW ?? dim.width, dim.width);
    if (w <= budgets.avifCheckMaxWidth && buf.length > budgets.avifMaxBytes) {
      v('avif', `${p}: ${buf.length} B at ${dim.width} w (budget ${budgets.avifMaxBytes} B at ≤ ${budgets.avifCheckMaxWidth} w)`);
    }
    return true;
  };
  for (const t of scanned) {
    for (const a of ['srcset', 'imagesrcset']) {
      if (!has(t, a)) continue;
      const cands = parseSrcset(attr(t, a));
      let anyAvif = attr(t, 'type').toLowerCase() === 'image/avif';
      for (const c of cands) {
        const p = samePath(c.url);
        if (p && checkAvifFile(p, c.w, `<${t.name} ${a}>`)) anyAvif = true;
      }
      if (!anyAvif) continue;
      if (cands.some((c) => c.w === undefined)) v('avif', `<${t.name} ${a}> uses density (x) descriptors; use width (w) descriptors`);
      const widths = new Set(cands.map((c) => c.w));
      const lacking = budgets.avifWidths.filter((w) => !widths.has(w));
      if (lacking.length) v('avif', `<${t.name} ${a}="${attr(t, a).slice(0, 80)}…"> lacks ${lacking.map((w) => `${w}w`).join(', ')} (AVIF must exist at ${budgets.avifWidths.join('/')} w)`);
    }
    const single = t.name === 'img' ? t.attrs['src'] : t.name === 'link' && attr(t, 'as').toLowerCase() === 'image' ? t.attrs['href'] : undefined;
    const p = samePath(single);
    if (p) checkAvifFile(p, undefined, `<${t.name}>`);
  }

  return {
    page: rel,
    url: pageUrl,
    lang,
    ok: violations.length === 0,
    metrics: {
      htmlBytes,
      htmlBr,
      htmlBrGate,
      htmlTarget,
      inlineCssBytes: Buffer.byteLength(inlineCss),
      lcpElement: lcpDesc,
      js: { files: jsFiles, inlineBr: inlineJsBr, totalBr: jsBr, lazyThirdPartyOrigins: [...lazyThird].sort() },
      critical: { requests: critical, bytes: critBytes, count: critical.length },
      avif: avifs,
    },
    violations,
    warnings,
  };
}

/** Absolute (http/https or protocol-relative string) URLs in script text. */
export function absUrlsIn(text: string): string[] {
  const out: string[] = [];
  const re = /\bhttps?:\/\/[^\s"'`<>()\\,;]+|["'`](\/\/[a-z0-9.-]+\.[a-z]{2,}[^"'`\s]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ? `https:${m[1]}` : m[0]);
  return out;
}

/** References to JS files in JS text: import/export-from, import(), and '.js' string literals. */
export function jsRefs(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const imp = /\b(?:import|export)\s*(?:[\w*${}\s,]+?\s*from\s*)?["']([^"'\n]+)["']/g;
  while ((m = imp.exec(text))) if (m[1]) out.add(m[1]);
  const dyn = /\bimport\(\s*["'`]([^"'`\n]+)["'`]\s*\)/g;
  while ((m = dyn.exec(text))) if (m[1]) out.add(m[1]);
  const lit = /(["'`])((?:https?:)?(?:\/|\.\.?\/)[^"'`\s]*?\.m?js(?:\?[^"'`\s]*)?)\1/g;
  while ((m = lit.exec(text))) if (m[2]) out.add(m[2]);
  return [...out];
}
