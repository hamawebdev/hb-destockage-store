/**
 * BUG-12 sizes check: proves SLOT_SIZES describe the real rendered width (lead's condition).
 * Serves a built storefront `dist`, opens a product page (gallery) and a category page (cards) in
 * both languages at 360/412/768/1024/1240/1440 px, and compares each <img>'s rendered width with
 * what our `sizes` string resolves to at that viewport (evaluated in the same browser: first
 * matching media condition, length measured via a probe element). Fails if any differs by > 5 %.
 *
 *   /tmp/hb-locks/heavy.sh node packages/catalog/src/bin/check-sizes.ts --dist apps/storefront/dist \
 *     --product-fr /fr/p/<slug>/ --product-ar /ar/p/<slug>/ --category-fr /fr/c/<slug>/ --category-ar /ar/c/<slug>/ \
 *     [--report artifacts/BUG-12/sizes.md] [--chrome /usr/bin/google-chrome] [--port 4181] [--source shipped|catalog]
 *
 * Needs playwright-core and a Chrome/Chromium binary; not part of the unit tests.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { SLOT_SIZES } from '../build.ts';

const { values: a } = parseArgs({
  options: {
    dist: { type: 'string' },
    'product-fr': { type: 'string' },
    'product-ar': { type: 'string' },
    'category-fr': { type: 'string' },
    'category-ar': { type: 'string' },
    report: { type: 'string' },
    chrome: { type: 'string', default: process.env['CHROME_PATH'] ?? '/usr/bin/google-chrome' },
    port: { type: 'string', default: '4181' },
    /** `shipped` (default): resolve each <img>'s own sizes attribute; `catalog`: resolve SLOT_SIZES
     *  (proof before a build containing them exists). */
    source: { type: 'string', default: 'shipped' },
  },
});
for (const k of ['dist', 'product-fr', 'product-ar', 'category-fr', 'category-ar'] as const) {
  if (!a[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

const VIEWPORTS = [360, 412, 768, 1024, 1240, 1440];
const TOLERANCE = 0.05;
const SLOTS = [
  { slot: 'gallery' as const, selector: 'img.cat-gal-img', pages: { fr: a['product-fr']!, ar: a['product-ar']! } },
  { slot: 'card' as const, selector: 'img.cat-card-img', pages: { fr: a['category-fr']!, ar: a['category-ar']! } },
];

const root = resolve(a.dist!);
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.avif': 'image/avif', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  let file = resolve(root, normalize('.' + url));
  if (!file.startsWith(root + sep) && file !== root) return void res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise<void>((ok) => server.listen(Number(a.port), '127.0.0.1', ok));
const origin = `http://127.0.0.1:${a.port}`;

const { chromium } = (await import('playwright-core')) as typeof import('playwright-core');
const browser = await chromium.launch({ executablePath: a.chrome!, args: ['--no-sandbox'] });

/**
 * Runs in the page (plain JS string: this package has no DOM typings). Resolves `sizes` like the
 * browser (first entry whose media condition matches, else the last) and measures that length with
 * a probe element; returns the first visible matching <img>'s rendered width.
 */
const IN_PAGE = `({ selector, sizes: catalogSizes, source }) => {
  const img = [...document.querySelectorAll(selector)].find((i) => i.getBoundingClientRect().width > 0);
  if (!img) return null;
  const shipped = img.getAttribute('sizes') || '';
  const sizes = source === 'shipped' ? shipped : catalogSizes;
  const entries = sizes.split(',').map((s) => s.trim());
  let length = entries[entries.length - 1];
  for (const e of entries) {
    const m = /^(\\([^()]*\\))\\s+(.+)$/.exec(e); // media condition: one (…) group, no nesting
    if (!m) { length = e; break; }
    if (matchMedia(m[1]).matches) { length = m[2]; break; }
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;inset-inline-start:0;width:' + length;
  document.body.appendChild(probe);
  const resolved = probe.getBoundingClientRect().width;
  probe.remove();
  return { rendered: img.getBoundingClientRect().width, resolved, shipped };
}`;

interface Row { slot: string; lang: string; viewport: number; rendered: number; resolved: number; diff: number; ok: boolean }
const rows: Row[] = [];
const shippedSizes = new Set<string>();
if (a.source !== 'shipped' && a.source !== 'catalog') {
  console.error('--source must be shipped or catalog');
  process.exit(2);
}
try {
  for (const { slot, selector, pages } of SLOTS) {
    for (const lang of ['ar', 'fr'] as const) {
      for (const vw of VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width: vw, height: 900 } });
        await page.goto(origin + pages[lang], { waitUntil: 'load' });
        const r = (await page.evaluate(`(${IN_PAGE})(${JSON.stringify({ selector, sizes: SLOT_SIZES[slot], source: a.source })})`)) as {
          rendered: number;
          resolved: number;
          shipped: string;
        } | null;
        await page.close();
        if (!r) throw new Error(`${selector} not found on ${pages[lang]} at ${vw}px`);
        const diff = (r.resolved - r.rendered) / r.rendered;
        rows.push({ slot, lang, viewport: vw, rendered: r.rendered, resolved: r.resolved, diff, ok: Math.abs(diff) <= TOLERANCE });
        shippedSizes.add(`${slot}: ${r.shipped}`);
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}

const lines = [
  '# BUG-12: `sizes` vs rendered width',
  '',
  `Rendered <img> width (getBoundingClientRect) vs the ${a.source === 'shipped' ? "page's own sizes attribute" : 'SLOT_SIZES strings'} resolved at the same viewport; tolerance ±${TOLERANCE * 100} %.`,
  '',
  `- source: ${a.source}`,
  `- SLOT_SIZES gallery: \`${SLOT_SIZES.gallery}\``,
  `- SLOT_SIZES card: \`${SLOT_SIZES.card}\``,
  ...[...shippedSizes].map((s) => `- shipped ${s.replace(/^(\w+): (.*)$/, '$1: `$2`')}`),
  `- build: ${root}`,
  '',
  '| slot | lang | viewport | rendered px | sizes px | diff | ok |',
  '|---|---|---:|---:|---:|---:|---|',
  ...rows.map((r) => `| ${r.slot} | ${r.lang} | ${r.viewport} | ${r.rendered.toFixed(1)} | ${r.resolved.toFixed(1)} | ${(r.diff * 100).toFixed(1)} % | ${r.ok ? 'yes' : '**NO**'} |`),
  '',
  `Result: ${rows.filter((r) => !r.ok).length} of ${rows.length} outside ±${TOLERANCE * 100} %.`,
  '',
];
if (a.report) {
  await mkdir(dirname(resolve(a.report)), { recursive: true });
  await writeFile(resolve(a.report), lines.join('\n'));
}
console.log(lines.slice(-2).join('\n'));
process.exit(rows.every((r) => r.ok) ? 0 : 1);
