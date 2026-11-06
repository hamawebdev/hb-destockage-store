#!/usr/bin/env node
// Which element is the LCP? Serves dist/, loads each path at 360, 412 (Lighthouse mobile),
// 768 and 1440 px in Chrome, and records the last `largest-contentful-paint` entry's element
// (tag, id, class, text/src). Fails when the LCP element is a lazy image (it must be eager +
// fetchpriority=high). Lazy non-LCP images inside the first viewport are listed for information
// only: by the lead's BUG-17 ruling every non-LCP image stays loading="lazy", even above the fold.
// Usage: node apps/storefront/scripts/lcp-element.mjs [--dist dir] [--port 4153] [--out dir] [--expect "#hm-title"] path…
// --expect <selector>: fail unless the LCP element matches it at every width.
// Exit 0 ok, 1 violation, 2 setup error. Run under /tmp/hb-locks/heavy.sh. Owner: shell.
import { serveDist } from './serve-dist.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flags = new Map();
const paths = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) flags.set(a, argv[++i]);
  else paths.push(a);
}
const here = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(flags.get('--dist') ?? join(here, '..', 'dist'));
const port = Number(flags.get('--port') ?? '4153');
const expect = flags.get('--expect') ?? null;
const out = flags.get('--out') ?? null;
if (!paths.length) paths.push('/ar/', '/fr/');

const server = serveDist(dist, port);

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('lcp-element: playwright is not installed');
  process.exit(2);
}
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const widths = [
  { w: 360, h: 800 },
  { w: 412, h: 823 },
  { w: 768, h: 1024 },
  { w: 1440, h: 900 },
];
const rows = [];
let fails = 0;
try {
  for (const { w, h } of widths) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      // @ts-ignore — collected in the page
      window.__lcp = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          // @ts-ignore
          window.__lcp.push(e);
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    for (const p of paths) {
      await page.goto(`http://127.0.0.1:${port}${p}`, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      const r = await page.evaluate((sel) => {
        // @ts-ignore
        const list = window.__lcp;
        const last = list[list.length - 1];
        const el = last?.element ?? null;
        const describe = (e) =>
          e ? { tag: e.tagName.toLowerCase(), id: e.id || null, cls: e.getAttribute('class'), text: (e.textContent ?? '').trim().slice(0, 60), src: e.currentSrc || null } : null;
        const lazyAbove = [...document.querySelectorAll('img[loading="lazy"]')]
          .filter((i) => {
            const b = i.getBoundingClientRect();
            return b.width > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
          })
          .map((i) => ({ src: i.getAttribute('src'), top: Math.round(i.getBoundingClientRect().top) }));
        const lcpLazy = !!el && el.tagName === 'IMG' && el.getAttribute('loading') === 'lazy';
        return { lcp: describe(el), size: last?.size ?? 0, renderTime: Math.round(last?.renderTime || last?.loadTime || 0), matches: sel && el ? el.matches(sel) : null, lazyAbove, lcpLazy };
      }, expect);
      rows.push({ width: w, path: p, ...r });
      const bad = r.lcpLazy || (expect && !r.matches);
      if (bad) fails++;
      console.log(`${bad ? 'FAIL' : 'ok  '} ${String(w).padStart(4)}px ${p}  LCP=<${r.lcp?.tag}${r.lcp?.id ? '#' + r.lcp.id : ''}${r.lcp?.cls ? '.' + r.lcp.cls.split(' ').join('.') : ''}> "${r.lcp?.text ?? ''}" size=${r.size}${r.lcpLazy ? '  LCP IS LAZY' : ''}${r.lazyAbove.length ? `  (info: ${r.lazyAbove.length} lazy non-LCP image(s) in viewport)` : ''}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (out) {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'lcp-element.json'), JSON.stringify({ expect, rows }, null, 2));
}
process.exit(fails ? 1 : 0);
