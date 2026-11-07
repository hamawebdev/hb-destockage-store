// ORDER-4 screenshots: the built /{ar,fr}/order/confirmation/ page at 360/768/1440, JS disabled, with and without a
// ref. The tiny server mimics web's Worker (WEB-0 §2.4 / WEB-3 review-slots.md): only a ?ref= matching ORDER_REF_RE
// fills <bdi data-hb="ref"> and un-hides [data-hb-when="has-ref"]; anything else serves the page untouched.
// Run (heavy lock):  /tmp/hb-locks/heavy.sh node src/components/order/test/e2e/confirmation.shots.mjs <dist> <out-dir>
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const [dist, out] = process.argv.slice(2);
const PORT = Number(process.env.ORDER_E2E_PORT ?? 4232);
const REF_RE = /^HB-[0-9A-HJKMNP-TV-Z]{5}$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.avif': 'image/avif' };

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let file = join(dist, decodeURIComponent(url.pathname));
  if (file.endsWith('/')) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); return res.end(); }
  let body = readFileSync(file);
  if (/\/order\/confirmation\/$/.test(url.pathname)) {
    const ref = url.searchParams.get('ref') ?? '';
    if (REF_RE.test(ref)) {
      body = body.toString('utf8')
        .replace(/(<bdi[^>]*data-hb="ref"[^>]*>)<\/bdi>/, `$1${ref}</bdi>`)
        .replace(/(data-hb-when="has-ref")\s+hidden/, '$1');
    }
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(body);
});

await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const lines = [];
try {
  for (const lang of ['ar', 'fr']) {
    for (const [state, q] of [['no-ref', ''], ['ref', '?ref=HB-7K2Q9'], ['bad-ref', '?ref=%3Cscript%3E']]) {
      for (const w of [360, 768, 1440]) {
        const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: w, height: 900 } });
        const p = await ctx.newPage();
        await p.goto(`http://127.0.0.1:${PORT}/${lang}/order/confirmation/${q}`);
        const refShown = await p.isVisible('[data-hb="ref"]');
        assert.equal(refShown, state === 'ref', `${lang} ${state} ${w}: ref visible = ${refShown}`);
        if (state === 'ref') assert.equal(await p.textContent('[data-hb="ref"]'), 'HB-7K2Q9');
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false, `${lang} ${state} ${w}: horizontal scroll`);
        if (state !== 'bad-ref') await p.screenshot({ path: `${out}/confirmation-${lang}-${state}-${w}.png`, fullPage: true });
        lines.push(`PASS ${lang} ${state} ${w}px (ref visible: ${refShown}, no horizontal scroll)`);
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(lines.join('\n'));
