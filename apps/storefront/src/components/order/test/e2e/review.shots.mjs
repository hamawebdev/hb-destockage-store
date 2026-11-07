// ORDER-6 screenshots + axe: the built /{ar,fr}/order/review/ template filled the way web's Worker fills it
// (artifacts/WEB-3/review-slots.md: values, appended options/inputs, replaced lines, un-hidden blocks), JS disabled.
// Two states: `ok` (can-confirm) and `errors` (phone_not_mobile + delivery_unavailable). Also axe on the confirmation page.
// Run (heavy lock): /tmp/hb-locks/heavy.sh node src/components/order/test/e2e/review.shots.mjs <dist> <out-dir>
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const [dist, out] = process.argv.slice(2);
const PORT = Number(process.env.ORDER_E2E_PORT ?? 4233);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const money = (n, lang) => new Intl.NumberFormat(lang === 'ar' ? 'ar-DZ' : 'fr-DZ', { style: 'currency', currency: 'DZD', maximumFractionDigits: 0 }).format(n);
const unhide = (h, attr) => h.replace(new RegExp(`(${attr})((?:\\s+[\\w-]+(?:="[^"]*")?)*?)\\s+hidden`, 'g'), '$1$2');

function fill(html, lang, state) {
  const communes = lang === 'ar' ? [[1601, 'الجزائر الوسطى'], [1602, 'باب الواد']] : [[1601, 'Alger Centre'], [1602, 'Bab El Oued']];
  let h = html
    .replace(/(<ul[^>]*data-hb="lines"[^>]*>)<\/ul>/, `$1<li class="of-line"><span class="of-line-name">Pack 3 en 1</span><span class="of-line-qty"><bdi>${money(14600, lang)}</bdi> × <bdi>2</bdi></span><bdi class="of-line-total">${money(29200, lang)}</bdi></li></ul>`)
    .replace(/(<input[^>]*data-hb="name"[^>]*)>/, `$1 value="${lang === 'ar' ? 'أمين بن علي' : 'Amine Benali'}">`)
    .replace(/(<input[^>]*data-hb="phone"[^>]*)>/, `$1 value="${state === 'errors' ? '0501234567' : '0555 12 34 56'}">`)
    .replace(/(<select[^>]*data-hb="commune-select"[^>]*>[\s\S]*?<\/option>)/, `$1${communes.map(([id, n]) => `<option value="${id}">${n}</option>`).join('')}`)
    .replace(/(<a[^>]*data-hb="back"[^>]*href=")[^"]*"/, `$1/${lang}/p/pack-3-en-1/"`)
    .replace(/(<form[^>]*data-hb="form"[^>]*>)/, '$1<input type="hidden" name="step" value="confirm"><input type="hidden" name="idempotencyKey" value="6f1c0000-0000-4000-8000-000000000000">');
  if (state === 'ok') {
    h = h.replace(/(data-hb="subtotal"[^>]*>)</, `$1${money(29200, lang)}<`).replace(/(data-hb="fee"[^>]*>)</, `$1${money(600, lang)}<`).replace(/(data-hb="total"[^>]*>)</, `$1${money(29800, lang)}<`);
    h = unhide(h, 'data-hb-when="can-confirm"');
  } else {
    h = unhide(h, 'data-hb-when="has-errors"');
    for (const c of ['phone_not_mobile', 'delivery_unavailable']) h = unhide(h, `data-hb-error="${c}"`);
    h = h.replace(/(<input[^>]*data-hb-field="phone")/, '$1 aria-invalid="true"');
  }
  return h;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let file = join(dist, decodeURIComponent(url.pathname));
  if (file.endsWith('/')) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); return res.end(); }
  let body = readFileSync(file);
  const m = url.pathname.match(/^\/(ar|fr)\/order\/review\/$/);
  if (m && url.searchParams.get('state')) body = fill(body.toString('utf8'), m[1], url.searchParams.get('state'));
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(body);
});

await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const lines = [];
const axeAll = {};
try {
  for (const lang of ['ar', 'fr']) {
    for (const [name, path] of [['review-ok', `/${lang}/order/review/?state=ok`], ['review-errors', `/${lang}/order/review/?state=errors`], ['confirmation-ref', `/${lang}/order/confirmation/`]]) {
      for (const w of [360, 768, 1440]) {
        const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: w, height: 900 } });
        const p = await ctx.newPage();
        await p.goto(`http://127.0.0.1:${PORT}${path}`);
        assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${lang} ${name} ${w}: horizontal scroll`);
        if (name === 'review-ok') {
          assert.ok(await p.isVisible('button[type=submit]')); assert.ok(await p.isVisible('[data-hb="total"]'));
          assert.equal(await p.isVisible('[data-hb-when="has-errors"]'), false);
        }
        if (name === 'review-errors') {
          assert.equal(await p.isVisible('button[type=submit]'), false);
          assert.ok(await p.isVisible('#or-phone-err [data-hb-error="phone_not_mobile"]'));
          assert.equal(await p.locator('[data-hb-error]:visible').count(), 3); // summary ×2 + under phone
        }
        if (name.startsWith('review')) await p.screenshot({ path: `${out}/${name}-${lang}-${w}.png`, fullPage: true });
        if (w === 360) {
          // axe-core runs in the page, so it needs JS: a separate JS-enabled context on the same (script-free) page.
          const actx = await browser.newContext({ viewport: { width: w, height: 900 } });
          const ap = await actx.newPage();
          await ap.goto(`http://127.0.0.1:${PORT}${path}`);
          const r = await new AxeBuilder({ page: ap }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
          await actx.close();
          axeAll[`${lang} ${name}`] = r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => ({ target: n.target.join(' '), html: n.html, why: n.failureSummary })) }));
          lines.push(`axe ${lang} ${name}: ${r.violations.length} violation(s)${r.violations.length ? ' — ' + r.violations.map((v) => v.id).join(', ') : ''}`);
        }
        lines.push(`PASS ${lang} ${name} ${w}px`);
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
writeFileSync(`${out}/axe.json`, JSON.stringify(axeAll, null, 2));
console.log(lines.join('\n'));
