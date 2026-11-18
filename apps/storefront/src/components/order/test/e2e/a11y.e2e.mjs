// ORDER-5: accessibility and edge cases of the order form, ar + fr, in a page that carries tokens' real CSS
// (tokens.css + base.css + forms.css) and the component's own CSS, the real public/js/order.js, and a mock of web's API.
// Not part of `npm test`. Run (heavy lock):
//   cd apps/storefront && ORDER_RENDER_OUT=<html> npx vitest run src/components/order/test/order-form.render.test.ts
//   /tmp/hb-locks/heavy.sh node src/components/order/test/e2e/a11y.e2e.mjs <html> <tokens-css-dir> <out-dir>
// <tokens-css-dir> holds tokens.css, base.css, forms.css from @hb/ui-tokens (TOKENS-4).
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [htmlDir, cssDir, out] = process.argv.slice(2);
const PORT = Number(process.env.ORDER_E2E_PORT ?? 4234);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const orderJs = readFileSync(here('../../../../../public/js/order.js'));
const src = readFileSync(here('../../OrderForm.astro'), 'utf8');
const componentCss = src.slice(src.indexOf('<style is:global>') + 17, src.indexOf('</style>'));
const css = ['tokens.css', 'base.css', 'forms.css'].map((f) => readFileSync(`${cssDir}/${f}`, 'utf8')).join('\n') + componentCss;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

let slow = 0;
const page = (lang, name, prefill) => {
  let form = readFileSync(`${htmlDir}/${lang}-${name}.html`, 'utf8');
  if (prefill) form = form.replace(`<option value="${prefill}">`, `<option value="${prefill}" selected>`); // restored/autofilled before JS
  return `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Pack 3 en 1</title><style>${css}</style></head>
<body><main id="main" class="container"><h1>Pack 3 en 1</h1>${form}</main>
<script type="module">import(document.getElementById('order-form').dataset.js)</script></body></html>`;
};
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const body = await new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)).on('end', () => ok(b)); });
  if (url.pathname.startsWith('/page/')) { const [, , lang, name] = url.pathname.split('/'); res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(lang, name, url.searchParams.get('prefill'))); }
  const cfgM = url.pathname.match(/^\/(ar|fr)\/order\/form\.json$/); // BUG-12
  if (cfgM) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(readFileSync(`${htmlDir}/${cfgM[1]}-form.json`)); }
  if (url.pathname.startsWith('/js/order.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(orderJs); }
  const m = url.pathname.match(/^\/geo\/communes\/(ar|fr)\/(\d+)\.json$/);
  if (m) { await wait(slow); return json(res, 200, m[2] === '16' ? [[1601, m[1] === 'ar' ? 'الجزائر الوسطى' : 'Alger Centre'], [1602, m[1] === 'ar' ? 'باب الواد' : 'Bab El Oued']] : [[501, 'Batna']]); }
  if (url.pathname === '/api/quote') {
    await wait(slow);
    const b = JSON.parse(body); const q = b.items[0].qty; const fee = b.wilayaCode === 16 ? 600 : null;
    return json(res, 200, { ok: true, available: fee != null, subtotalDzd: 14600 * q, feeDzd: fee, totalDzd: fee == null ? null : 14600 * q + fee, feeSource: 'table', lines: [{ variantId: 12, qty: q, unitPriceDzd: 14600, lineTotalDzd: 14600 * q, maxQty: 10 }] });
  }
  if (url.pathname === '/api/order') { await wait(slow); return json(res, 201, { ok: true, ref: 'HB-7K2Q9', confirmationUrl: '/done/' }); }
  if (url.pathname === '/done/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>ok</title><h1>ok</h1>'); }
  res.writeHead(404); res.end();
});

const results = [];
const axeReport = {};
const targets = {};
async function axe(p, key) {
  const r = await new AxeBuilder({ page: p }).withTags(AXE_TAGS).analyze();
  axeReport[key] = r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => ({ target: n.target.join(' '), why: n.failureSummary })) }));
  assert.equal(r.violations.length, 0, `axe ${key}: ${r.violations.map((v) => v.id).join(', ')}`);
}
const ready = (p) => p.waitForSelector('#order-form.of-js.of-cfg'); // order.js + its form.json
const totalShown = (p) => p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');

async function run(browser, lang) {
  const t = async (name, fn, { page: pg = 'single', js = true, width = 360, reducedMotion = 'no-preference', query = '' } = {}) => {
    slow = 0;
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion });
    if (!js) await ctx.route('**/js/order.js*', (r) => r.abort());
    const p = await ctx.newPage();
    try {
      await p.goto(`${ORIGIN}/page/${lang}/${pg}${query}`);
      if (js) await ready(p);
      await fn(p, ctx);
      results.push(`PASS ${lang} ${name}`);
    } catch (e) {
      results.push(`FAIL ${lang} ${name}: ${String(e.message).split('\n')[0]}`);
      await p.screenshot({ path: `${out}/fail-${lang}-${name.replace(/\W+/g, '-')}.png`, fullPage: true }).catch(() => {});
    }
    await ctx.close();
  };

  await t('keyboard only: tab order, visible focus, order placed without a pointer', async (p) => {
    const order = [];
    await p.focus('#of-name');
    for (let i = 0; i < 8; i++) {
      const info = await p.evaluate(() => {
        const e = document.activeElement; const s = getComputedStyle(e);
        return { id: e.id || e.className, outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 };
      });
      order.push(info.id);
      assert.ok(info.outline, `visible focus on ${info.id}`);
      await p.keyboard.press('Tab');
    }
    // Commune is disabled until a wilaya is chosen; honeypot is display:none (never reachable).
    assert.deepEqual(order.slice(0, 4), ['of-name', 'of-phone', 'of-wilaya', 'btn btn-secondary of-step']);
    assert.ok(!order.includes('of-hp'));
    await p.focus('#of-name'); await p.keyboard.type('Amine Benali');
    await p.keyboard.press('Tab'); await p.keyboard.type('0555123456');
    await p.keyboard.press('Tab'); await p.keyboard.type('16'); // typeahead on the closed <select>
    await p.waitForFunction(() => document.getElementById('of-wilaya').value === '16');
    await p.waitForFunction(() => !document.getElementById('of-commune').disabled);
    await p.keyboard.press('Tab'); // → commune (now enabled)
    assert.equal(await p.evaluate(() => document.activeElement.id), 'of-commune');
    await p.keyboard.press('ArrowDown');
    await p.waitForFunction(() => document.getElementById('of-commune').value === '1601');
    await p.keyboard.press('Tab'); // − button
    await p.keyboard.press('Tab'); // qty
    await p.keyboard.press('Tab'); // + button
    await p.keyboard.press('Space');
    assert.equal(await p.inputValue('#of-qty'), '2');
    await totalShown(p);
    await p.focus('#of-submit');
    await Promise.all([p.waitForURL('**/done/'), p.keyboard.press('Enter')]);
  });

  await t('errors: associated with fields, focus moves, alert announced from an in-tree live region', async (p) => {
    for (const id of ['of-alert', 'of-status']) {
      const s = await p.evaluate((i) => { const c = getComputedStyle(document.getElementById(i)); return c.display + '/' + c.visibility; }, id);
      assert.ok(!s.startsWith('none') && !s.endsWith('hidden'), `${id} stays in the accessibility tree while empty (${s})`);
    }
    await p.focus('#of-submit'); await p.keyboard.press('Enter');
    assert.equal(await p.evaluate(() => document.activeElement.id), 'of-name');
    for (const id of ['of-name', 'of-phone', 'of-wilaya']) {
      assert.equal(await p.getAttribute(`#${id}`, 'aria-invalid'), 'true', id);
      const err = await p.textContent(`#${id}-err`);
      assert.ok(err.length > 3, `${id} message`);
      assert.match(await p.getAttribute(`#${id}`, 'aria-describedby'), new RegExp(`${id}-err`));
    }
    assert.ok((await p.textContent('#of-alert')).length > 3);
    assert.equal(await p.getAttribute('#of-alert', 'role'), 'alert');
    await axe(p, `${lang} errors`);
    await p.screenshot({ path: `${out}/errors-${lang}-360.png`, fullPage: true });
  });

  await t('tap targets ≥ 44 px (tokens forms.css/base.css + component CSS)', async (p) => {
    await p.selectOption('#of-wilaya', '16');
    await totalShown(p);
    const sizes = await p.evaluate(() => [...document.querySelectorAll('#order input:not([type=hidden]), #order select, #order button, #order a')]
      .filter((e) => e.offsetParent !== null || e.getClientRects().length)
      .map((e) => { const r = e.getBoundingClientRect(); return { el: e.id || e.getAttribute('href') || e.className, w: Math.round(r.width), h: Math.round(r.height), inline: e.tagName === 'A' && e.closest('p.hint') !== null }; })
      .filter((x) => x.w > 0 && x.h > 0));
    targets[lang] = sizes;
    for (const s of sizes) if (!s.inline) assert.ok(s.h >= 44 && s.w >= 44, `${s.el} is ${s.w}×${s.h}`);
  });

  await t('phone stays LTR inside RTL; Eastern Arabic digits accepted', async (p) => {
    assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById('of-phone')).direction), 'ltr');
    await p.fill('#of-phone', '٠٥٥٥ ١٢ ٣٤ ٥٦');
    await p.fill('#of-name', 'Amine'); await p.focus('#of-submit'); await p.keyboard.press('Enter');
    assert.equal(await p.textContent('#of-phone-err'), '');
  });

  await t('autofill: programmatic change events load communes and re-quote', async (p) => {
    await p.evaluate(() => { const w = document.getElementById('of-wilaya'); w.value = '16'; w.dispatchEvent(new Event('input', { bubbles: true })); w.dispatchEvent(new Event('change', { bubbles: true })); });
    await p.waitForFunction(() => !document.getElementById('of-commune').disabled);
    await totalShown(p);
  });

  await t('autofill/restore before JS: a preselected wilaya loads its communes at init', async (p) => {
    await p.waitForFunction(() => !document.getElementById('of-commune').disabled && document.getElementById('of-commune').options.length === 3);
  }, { query: '?prefill=16' });

  await t('slow network: loading, calculating and submitting states are exposed', async (p, ctx) => {
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 });
    slow = 1500;
    await p.fill('#of-name', 'Amine Benali'); await p.fill('#of-phone', '0555123456');
    await p.selectOption('#of-wilaya', '16');
    assert.equal(await p.getAttribute('#of-commune', 'aria-busy'), 'true');
    await p.screenshot({ path: `${out}/slow-communes-${lang}-360.png` });
    await p.waitForFunction(() => !document.getElementById('of-commune').disabled);
    await p.selectOption('#of-commune', '1601');
    await p.waitForFunction(() => document.getElementById('of-sum').getAttribute('aria-busy') === 'true');
    assert.notEqual(await p.textContent('#of-s-fee'), '—');
    await p.screenshot({ path: `${out}/slow-quote-${lang}-360.png`, fullPage: true });
    await totalShown(p);
    await p.click('#of-submit');
    await p.waitForFunction(() => document.getElementById('of-submit').getAttribute('aria-disabled') === 'true');
    assert.ok((await p.textContent('#of-status')).length > 0);
    await p.screenshot({ path: `${out}/slow-submitting-${lang}-360.png`, fullPage: true });
    await p.waitForURL('**/done/', { timeout: 20000 });
  });

  await t('unserved wilaya: alert with its next step, no shop number, confirm disabled, no axe violation', async (p) => {
    await p.selectOption('#of-wilaya', '5');
    await p.waitForFunction(() => document.getElementById('of-alert').textContent.length > 0);
    assert.equal(await p.getAttribute('#of-submit', 'aria-disabled'), 'true');
    assert.equal(await p.locator('#order a[href^="tel:"], #order a[href*="wa.me"]').count(), 0); // no shop number before an order (D-029)
    await axe(p, `${lang} unserved-wilaya`);
  });

  await t('out of stock: disabled form, the way back to the shop still reachable, no axe violation', async (p) => {
    assert.equal(await p.evaluate(() => document.querySelector('.of-fields').disabled), true);
    await p.focus('#of-unavail a');
    assert.equal(await p.evaluate(() => document.activeElement.getAttribute('href')), `/${lang}/`);
    await axe(p, `${lang} out-of-stock`);
  }, { page: 'oos' });

  await t('prefers-reduced-motion: no transition on summary updates', async (p) => {
    // Our transition exists only under no-preference; tokens' base.css also forces 0.01ms on everything under reduce.
    const d = await p.evaluate(() => getComputedStyle(document.querySelector('.of-sum dd')).transitionDuration);
    assert.ok(d.split(',').every((x) => parseFloat(x) <= 0.00001), `transition-duration ${d}`);
  }, { reducedMotion: 'reduce' });

  // axe-core runs in the page, so it needs JS: the no-JS DOM is reproduced by blocking order.js (the only script).
  await t('no-JS DOM (order.js blocked): no axe violation', async (p) => {
    assert.equal(await p.evaluate(() => document.getElementById('order-form').classList.contains('of-js')), false);
    await axe(p, `${lang} no-js`);
  }, { js: false });

  for (const width of [360, 768, 1440]) {
    await t(`quote shown at ${width}px: axe clean, screenshot`, async (p) => {
      await p.fill('#of-name', 'Amine Benali'); await p.fill('#of-phone', '0555123456');
      await p.selectOption('#of-wilaya', '16');
      await p.waitForFunction(() => !document.getElementById('of-commune').disabled);
      await p.selectOption('#of-commune', '1601');
      await totalShown(p);
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'horizontal scroll');
      if (width === 360) await axe(p, `${lang} quote-shown`);
      await p.screenshot({ path: `${out}/quote-${lang}-${width}.png`, fullPage: true });
    }, { width });
  }
}

await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const lang of ['ar', 'fr']) await run(browser, lang);
} finally {
  await browser.close();
  server.close();
}
writeFileSync(`${out}/axe.json`, JSON.stringify(axeReport, null, 2));
writeFileSync(`${out}/tap-targets.json`, JSON.stringify(targets, null, 2));
const report = results.join('\n');
writeFileSync(`${out}/a11y.txt`, `${new Date().toISOString()}\n${report}\n`);
console.log(report);
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
