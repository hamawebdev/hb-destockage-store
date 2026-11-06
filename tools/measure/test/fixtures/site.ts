/**
 * A small built site that passes every budget rule ("good"), written into a temp dir, plus
 * helpers that mutate it so each rule can be shown to fail. Binary assets are synthetic but
 * structurally valid where the checker reads them (AVIF ftyp + ispe box, woff2 magic), and their
 * byte sizes are chosen so the good site sits inside every budget with a known margin:
 *
 *   ar product critical path = HTML (~2 KB br) + font 11,800 B + LCP AVIF 960w 20,000 B → 3 requests
 *   fr product critical path = HTML + LCP AVIF                                         → 2 requests
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const WIDTHS = [360, 480, 720, 960, 1200] as const;
export const AVIF_BYTES: Record<number, number> = { 360: 6000, 480: 9000, 720: 14000, 960: 20000, 1200: 30000 };
export const FONT = '/font/noto-sans-arabic-400.woff2';
export const FONT_BYTES = 11800;

/** Deterministic incompressible bytes. */
export function noise(n: number, seed = 1): Buffer {
  const b = Buffer.alloc(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    b[i] = x & 0xff;
  }
  return b;
}

/** Incompressible ASCII (base64 of noise), safe inside CSS comments and JS strings. */
export function noiseText(n: number, seed = 7): string {
  return noise(Math.ceil((n * 3) / 4), seed).toString('base64').slice(0, n);
}

/** A synthetic AVIF of exactly `bytes` bytes whose ispe box says `width` × `width`. */
export function fakeAvif(width: number, bytes: number, seed = width): Buffer {
  const ftyp = Buffer.alloc(28);
  ftyp.writeUInt32BE(28, 0); ftyp.write('ftypavif', 4, 'latin1'); ftyp.writeUInt32BE(0, 12);
  ftyp.write('avifmif1miaf', 16, 'latin1');
  const ispe = Buffer.alloc(20);
  ispe.writeUInt32BE(20, 0); ispe.write('ispe', 4, 'latin1'); ispe.writeUInt32BE(0, 8);
  ispe.writeUInt32BE(width, 12); ispe.writeUInt32BE(width, 16);
  const meta = Buffer.alloc(8);
  meta.writeUInt32BE(8 + ispe.length, 0); meta.write('meta', 4, 'latin1');
  const head = Buffer.concat([ftyp, meta, ispe]);
  const mdat = Buffer.alloc(8);
  mdat.writeUInt32BE(bytes - head.length, 0); mdat.write('mdat', 4, 'latin1');
  return Buffer.concat([head, mdat, noise(bytes - head.length - 8, seed)]);
}

export const srcset = (stem: string, widths: readonly number[] = WIDTHS): string =>
  widths.map((w) => `/img/${stem}-${w}.avif ${w}w`).join(', ');

const SIZES = '(min-width: 768px) 50vw, 100vw';

const css = (lang: 'ar' | 'fr'): string => [
  lang === 'ar'
    ? `@font-face{font-family:"Noto Sans Arabic";src:url(${FONT}) format("woff2");font-weight:400;font-display:optional;unicode-range:U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFF}`
    : '',
  ':root{--ink:#111;--bg:#fff;--accent:#0a58ca}*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  lang === 'ar' ? 'html[lang^=ar] body{font-family:"Noto Sans Arabic",system-ui,sans-serif;line-height:1.7}' : '',
  '.wrap{max-width:1180px;margin-inline:auto;padding-inline:16px}img{max-width:100%;height:auto;display:block}',
  'a,button{min-height:44px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px}',
].join('');

const T = {
  ar: { title: 'طقم مطبخ', card: 'عرض الطقم — 14 600 دج', home: 'الرئيسية', order: 'اطلب الآن', other: 'fr', otherLabel: 'Français', name: 'الاسم', phone: 'الهاتف' },
  fr: { title: 'Pack cuisine', card: 'Voir le pack — 14 600 DZD', home: 'Accueil', order: 'Commander', other: 'ar', otherLabel: 'العربية', name: 'Nom', phone: 'Téléphone' },
} as const;

export function page(lang: 'ar' | 'fr', kind: 'home' | 'product'): string {
  const t = T[lang];
  const p = kind === 'home' ? '' : 'p/pack-cuisine/';
  const otherLabel = lang === 'fr' ? `<span lang="ar" style="font-family:system-ui">${t.otherLabel}</span>` : t.otherLabel;
  const head = [
    '<!doctype html>',
    `<html lang="${lang}-DZ" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${t.title} | HB Destockage</title>`,
    `<link rel="canonical" href="https://hbdestockage.dz/${lang}/${p}">`,
    `<link rel="alternate" hreflang="ar-DZ" href="https://hbdestockage.dz/ar/${p}">`,
    `<link rel="alternate" hreflang="fr-DZ" href="https://hbdestockage.dz/fr/${p}">`,
    `<link rel="alternate" hreflang="x-default" href="https://hbdestockage.dz/ar/${p}">`,
    lang === 'ar' ? `<link rel="preload" href="${FONT}" as="font" type="font/woff2" crossorigin>` : '',
    kind === 'product' ? `<link rel="preload" as="image" type="image/avif" imagesrcset="${srcset('p1')}" imagesizes="${SIZES}" fetchpriority="high">` : '',
    `<style>${css(lang)}</style>`,
    '<script type="speculationrules">{"prefetch":[{"where":{"href_matches":"/*"},"eagerness":"moderate"}]}</script>',
    kind === 'product' ? '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Pack cuisine","image":"https://hbdestockage.dz/img/p1-960.avif"}</script>' : '',
    '</head>',
  ];
  const body = [
    '<body><div class="wrap">',
    `<header><a href="/${lang}/">HB Destockage</a> <a href="/${t.other}/${p}" hreflang="${t.other}">${otherLabel}</a>`,
    ' <a href="https://wa.me/213779942022" rel="noopener">WhatsApp</a></header>',
    '<main id="main">',
    kind === 'product'
      ? `<picture><source type="image/avif" srcset="${srcset('p1')}" sizes="${SIZES}"><img src="/img/p1-720.avif" width="1200" height="1200" alt="${t.title}" fetchpriority="high"></picture>`
      : '',
    `<h1>${t.title}</h1>`,
    kind === 'product'
      ? `<form method="post" action="/api/order"><label>${t.name}<input name="name" autocomplete="name" required></label>`
        + `<label>${t.phone}<input name="phone" type="tel" inputmode="tel" dir="ltr" required></label>`
        + `<button type="submit">${t.order}</button></form>`
      : '',
    `<ul class="cards"><li><a href="/${lang}/p/pack-cuisine/"><img src="/img/c1-360.avif" srcset="${srcset('c1')}" sizes="(min-width: 768px) 25vw, 50vw" width="360" height="360" loading="lazy" alt="${t.title}">${t.card}</a></li></ul>`, // link text ≠ alt (axe best-practice image-redundant-alt)
    '</main><footer><a href="tel:0560417403" dir="ltr">0560417403</a></footer></div>',
    kind === 'product' ? '<script type="module" src="/js/order.js"></script>' : '',
    '</body></html>',
  ];
  return [...head, ...body].filter(Boolean).join('\n');
}

export const ORDER_JS = `// order-form enhancement (fixture)
const form = document.querySelector('form');
let ts = false;
const loadTurnstile = () => {
  if (ts) return; ts = true;
  const s = document.createElement('script');
  s.src = '/js/turnstile.js';
  document.head.append(s);
};
form?.addEventListener('focusin', loadTurnstile, { once: true });
form?.addEventListener('pointerdown', loadTurnstile, { once: true });
`;

export const TURNSTILE_JS = `// injected on first interaction (fixture)
const s = document.createElement('script');
s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
s.async = true;
document.head.append(s);
`;

/** A CAT-4-shaped image manifest: stem → original width (square originals). */
export function manifestJson(originals: Record<string, number | null>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(originals).map(([hash, width]) => [
    `k-${hash}`, { key: `k-${hash}`, hash, candidates: [], og: null, stub: false, ...(width === null ? {} : { original: { width, height: width } }) },
  ])), null, 1);
}

/** Write the good site into `dir`. */
export function writeGoodSite(dir: string): void {
  const w = (rel: string, data: string | Buffer): void => {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, data);
  };
  for (const lang of ['ar', 'fr'] as const) {
    w(`${lang}/index.html`, page(lang, 'home'));
    w(`${lang}/p/pack-cuisine/index.html`, page(lang, 'product'));
  }
  for (const wd of WIDTHS) {
    w(`img/p1-${wd}.avif`, fakeAvif(wd, AVIF_BYTES[wd] ?? 0));
    w(`img/c1-${wd}.avif`, fakeAvif(wd, Math.round((AVIF_BYTES[wd] ?? 0) / 2), wd + 1));
  }
  w(FONT.slice(1), Buffer.concat([Buffer.from('wOF2'), noise(FONT_BYTES - 4, 3)]));
  // CAT-4 manifest: original dimensions decide the required widths (never upscaled)
  w('image-manifest.json', manifestJson({ p1: 1600, c1: 1600 }));
  w('js/order.js', ORDER_JS);
  w('js/turnstile.js', TURNSTILE_JS);
}

let good: string | null = null;
const temps: string[] = [];

/** A fresh copy of the good site in a temp dir. */
export function freshSite(): string {
  if (!good) {
    good = mkdtempSync(path.join(tmpdir(), 'hb-budget-good-'));
    temps.push(good);
    writeGoodSite(good);
  }
  const d = mkdtempSync(path.join(tmpdir(), 'hb-budget-case-'));
  temps.push(d);
  cpSync(good, d, { recursive: true });
  return d;
}

export function cleanup(): void {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  good = null;
}

/** Edit a text file in a site. Throws if the replacement did not change anything. */
export function edit(dir: string, rel: string, fn: (s: string) => string): void {
  const p = path.join(dir, rel);
  const before = readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`fixture edit did not change ${rel}`);
  writeFileSync(p, after);
}

export function put(dir: string, rel: string, data: string | Buffer): void {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, data);
}
