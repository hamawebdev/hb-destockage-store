// ORDER-2 browser flows: rendered OrderForm + the real public/js/order.js against a mock of web's API
// (WEB-0 §2.1–2.2). Not part of `npm test` (launches Chrome). Run, under the machine's heavy-command lock:
//   cd apps/storefront && ORDER_RENDER_OUT=<dir> npx vitest run src/components/order/test/order-form.render.test.ts
//   /tmp/hb-locks/heavy.sh node src/components/order/test/e2e/order.e2e.mjs <dir-with-rendered-html> [artifacts-dir]
// Port: orderform block 4230–4239 (BRIEF §7). Uses system Chrome (playwright channel 'chrome').
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const htmlDir = process.argv[2];
const outDir = process.argv[3] ?? null;
const PORT = Number(process.env.ORDER_E2E_PORT ?? 4231);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const orderJs = readFileSync(fileURLToPath(new URL('../../../../../public/js/order.js', import.meta.url)));
const orderTsJs = readFileSync(fileURLToPath(new URL('../../../../../public/js/order-ts.js', import.meta.url)));
// Stand-in for Cloudflare's api.js (the real origin is never contacted by these tests).
const TS_STUB = `window.__tsN=0;window.turnstile={render(el,o){window.__tsOpts={...o};const f=()=>setTimeout(()=>o.callback('tok-'+(++window.__tsN)),50);window.__tsIssue=f;f();return 'w1'},reset(){window.__tsResets=(window.__tsResets||0)+1;window.__tsIssue()}};`;

// ---- mock Worker --------------------------------------------------------------------------------------
const FEES = { 16: 600, 1: 900 }; // wilaya 5 is "not served"
const COMMUNES = { 16: [[1601, 'Alger Centre'], [1602, 'Bab El Oued']], 1: [[101, 'Adrar']], 5: [[501, 'Batna']] };
let mode = {}; // per-test switches
let orders = new Map(); // idempotencyKey → body
let log = [];
const quote = (b) => {
  const line = b.items[0];
  const unit = mode.unitPrice ?? 14600;
  const fee = FEES[b.wilayaCode];
  const sub = unit * line.qty;
  return { ok: true, available: fee != null, subtotalDzd: sub, feeDzd: fee ?? null, totalDzd: fee == null ? null : sub + fee, feeSource: 'table',
    lines: [{ variantId: line.variantId, qty: line.qty, unitPriceDzd: unit, lineTotalDzd: sub, maxQty: 10 }] };
};
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const page = (lang, name) => `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>t</title></head><body>
${readFileSync(`${htmlDir}/${lang}-${name}.html`, 'utf8')}
<script type="module">import(document.getElementById('order-form').dataset.js)</script></body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const body = await new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)).on('end', () => ok(b)); });
  log.push({ method: req.method, path: url.pathname, type: req.headers['content-type'] ?? '', body });
  if (url.pathname.startsWith('/page/')) { const [, , lang, name] = url.pathname.split('/'); res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(lang, name)); }
  if (url.pathname.startsWith('/js/order-ts.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(orderTsJs); }
  if (url.pathname.startsWith('/js/order.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(orderJs); }
  const m = url.pathname.match(/^\/geo\/communes\/(ar|fr)\/(\d+)\.json$/);
  if (m) { if (mode.communesDown) { res.writeHead(503); return res.end(); } return json(res, 200, COMMUNES[m[2]] ?? []); }
  if (url.pathname === '/api/quote') {
    if (mode.quoteDown) { res.writeHead(503); return res.end('{}'); }
    if (mode.quoteDelay) await new Promise((ok) => setTimeout(ok, mode.quoteDelay));
    return json(res, 200, quote(JSON.parse(body)));
  }
  if (url.pathname === '/api/order') {
    if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<p id="review">review step</p>'); }
    const b = JSON.parse(body);
    if (mode.dropFirstOrder) { mode.dropFirstOrder = false; orders.set(b.idempotencyKey, b); return req.socket.destroy(); } // created, answer lost
    if (mode.orderDelay) await new Promise((ok) => setTimeout(ok, mode.orderDelay));
    const q = quote(b);
    if (mode.totalChangedOnce) { mode.totalChangedOnce = false; mode.unitPrice = 15000; return json(res, 409, { ok: false, code: 'total_changed', quote: quote(b) }); }
    if (q.totalDzd !== b.expectedTotalDzd) return json(res, 409, { ok: false, code: 'total_changed', quote: q });
    const replay = orders.has(b.idempotencyKey);
    orders.set(b.idempotencyKey, b);
    return json(res, replay ? 200 : 201, { ok: true, ref: 'HB-7K2Q9', status: 'new', duplicate: replay, subtotalDzd: q.subtotalDzd, feeDzd: q.feeDzd, totalDzd: q.totalDzd, confirmationUrl: `/${b.lang}/order/confirmation/?ref=HB-7K2Q9` });
  }
  if (url.pathname.includes('/order/confirmation/')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<p id="thanks">ok</p>'); }
  res.writeHead(404); res.end();
});

// ---- tests ---------------------------------------------------------------------------------------------
const results = [];
const orderPosts = () => log.filter((r) => r.path === '/api/order');
async function fill(p, { phone = '0555123456', wilaya = '16' } = {}) {
  await p.fill('#of-name', 'Amine Benali');
  await p.fill('#of-phone', phone);
  await p.selectOption('#of-wilaya', wilaya);
  await p.waitForFunction(() => !document.getElementById('of-commune').disabled && document.getElementById('of-commune').options.length > 1);
  await p.selectOption('#of-commune', { index: 1 });
}
const total = (p) => p.textContent('#of-s-total');

async function run(browser, lang) {
  const t = async (name, fn, { js = true, page: pageName = 'single', ts = null } = {}) => {
    mode = {}; orders = new Map(); log = [];
    const ctx = await browser.newContext({ javaScriptEnabled: js, locale: lang === 'ar' ? 'ar-DZ' : 'fr-FR' });
    const tsReqs = [];
    if (ts) await ctx.route('https://challenges.cloudflare.com/**', (route) => {
      tsReqs.push(route.request().url());
      if (ts === 'stub') return route.fulfill({ status: 200, contentType: 'text/javascript', body: TS_STUB });
      if (ts === 'abort') return route.abort('blockedbyclient');
      // 'hang': never answer
    });
    const p = await ctx.newPage();
    const external = [];
    p.on('request', (r) => { if (!r.url().startsWith(ORIGIN) && !r.url().startsWith('https://challenges.cloudflare.com/')) external.push(r.url()); });
    try {
      await p.goto(`${ORIGIN}/page/${lang}/${pageName}`);
      if (js) await p.waitForSelector('#order-form.of-js');
      await fn(p, tsReqs);
      assert.deepEqual(external, [], 'no third-party request');
      if (!ts) assert.deepEqual(tsReqs, []);
      results.push(`PASS ${lang} ${name}`);
    } catch (e) {
      results.push(`FAIL ${lang} ${name}: ${e.message.split('\n')[0]}`);
      if (outDir) await p.screenshot({ path: `${outDir}/fail-${lang}-${name.replace(/\W+/g, '-')}.png`, fullPage: true });
    }
    await ctx.close();
  };

  await t('no-JS: native POST to the server review step, empty key, no commune', async (p) => {
    await p.fill('#of-name', 'Amine Benali'); await p.fill('#of-phone', '0555123456'); await p.selectOption('#of-wilaya', '16');
    await Promise.all([p.waitForURL('**/api/order'), p.click('#of-submit')]);
    const post = orderPosts()[0];
    assert.match(post.type, /x-www-form-urlencoded/);
    const f = new URLSearchParams(post.body);
    assert.equal(f.get('step'), 'review'); assert.equal(f.get('idempotencyKey'), ''); assert.equal(f.get('communeId'), null);
    assert.equal(f.get('wilayaCode'), '16'); assert.equal(f.get('variantId'), '12'); assert.equal(f.get('website'), '');
  }, { js: false });

  await t('JS: quote shown, one press confirms, JSON order with key/fillMs/expectedTotal, navigates', async (p) => {
    await fill(p);
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    assert.match(await total(p), lang === 'ar' ? /15\.200/ : /15\s200/);
    assert.match(await p.textContent('#of-status'), lang === 'ar' ? /15\.200/ : /15\s200/);
    await Promise.all([p.waitForURL('**/order/confirmation/?ref=HB-7K2Q9'), p.click('#of-submit')]);
    const b = JSON.parse(orderPosts()[0].body);
    assert.match(b.idempotencyKey, /^[0-9a-f-]{36}$/); assert.equal(b.expectedTotalDzd, 15200); assert.ok(b.fillMs > 0);
    assert.deepEqual(b.items, [{ variantId: 12, qty: 1 }]); assert.equal(b.communeId, 1601); assert.equal(b.website, ''); assert.equal(b.lang, lang);
    assert.equal(b.turnstileToken, undefined);
  });

  await t('confirm gate: stale summary → first press re-quotes and shows, second press orders', async (p) => {
    mode.quoteDelay = 400;
    await fill(p);
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    await p.click('.of-step[data-d="1"]'); // qty 2, quote now stale
    await p.click('#of-submit');
    await p.waitForFunction(() => /29[.\s\u202f]?800/.test(document.getElementById('of-s-total').textContent));
    assert.equal(orderPosts().length, 0, 'no order before the new total is shown');
    assert.equal(await p.evaluate(() => document.activeElement.id), 'of-sum-h');
    await Promise.all([p.waitForURL('**/confirmation/**'), p.click('#of-submit')]);
    assert.equal(JSON.parse(orderPosts()[0].body).expectedTotalDzd, 29800);
  });

  await t('double click sends one order', async (p) => {
    mode.orderDelay = 800;
    await fill(p);
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    await p.click('#of-submit'); await p.click('#of-submit', { force: true }); await p.click('#of-submit', { force: true });
    await p.waitForURL('**/confirmation/**');
    assert.equal(orderPosts().length, 1);
  });

  await t('lost answer → automatic retry with the same key → same order', async (p) => {
    mode.dropFirstOrder = true;
    await fill(p);
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    await Promise.all([p.waitForURL('**/confirmation/**', { timeout: 15000 }), p.click('#of-submit')]);
    const keys = orderPosts().map((r) => JSON.parse(r.body).idempotencyKey);
    assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]); assert.equal(orders.size, 1);
  });

  await t('quote failure: confirm stays disabled with retry + call/WhatsApp; retry recovers', async (p) => {
    mode.quoteDown = true;
    await fill(p);
    await p.waitForFunction(() => !document.getElementById('of-help').hidden);
    assert.equal(await p.getAttribute('#of-submit', 'aria-disabled'), 'true');
    assert.ok((await p.textContent('#of-alert')).length > 10);
    await p.click('#of-submit', { force: true }); // aria-disabled: still pressable by a user
    assert.equal(orderPosts().length, 0);
    assert.ok(await p.isVisible('#of-help a[href^="tel:"]')); assert.ok(await p.isVisible('#of-help a[href="https://wa.me/213779942022"]'));
    mode.quoteDown = false;
    await p.click('#of-retry');
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    assert.equal(await p.getAttribute('#of-submit', 'aria-disabled'), null);
  });

  await t('wilaya not served: delivery_unavailable, no order', async (p) => {
    await fill(p, { wilaya: '5' });
    await p.waitForFunction(() => document.getElementById('of-alert').textContent.length > 0);
    assert.equal(await p.getAttribute('#of-submit', 'aria-disabled'), 'true');
    await p.click('#of-submit', { force: true });
    assert.equal(orderPosts().length, 0);
    assert.equal(await total(p), '—');
  });

  await t('client hints: empty fields and 050… phone → errors tied to fields, focus first, no POST', async (p) => {
    await p.click('#of-submit');
    assert.equal(await p.evaluate(() => document.activeElement.id), 'of-name');
    assert.equal(await p.getAttribute('#of-name', 'aria-invalid'), 'true');
    assert.ok((await p.textContent('#of-alert')).length > 0);
    await p.fill('#of-name', 'Amine'); await p.fill('#of-phone', '0501234567');
    await p.click('#of-submit');
    assert.equal(await p.evaluate(() => document.activeElement.id), 'of-phone');
    assert.ok((await p.textContent('#of-phone-err')).length > 10);
    assert.equal(orderPosts().length, 0);
  });

  await t('long accepted spelling is typed in full, not truncated (ORDER-1 review r1 F1)', async (p) => {
    const spelling = '00213 (0) 555 12 34 56';
    await p.click('#of-phone');
    await p.keyboard.type(spelling);
    assert.equal(await p.inputValue('#of-phone'), spelling);
    await p.fill('#of-name', 'Amine Benali');
    await p.selectOption('#of-wilaya', '16');
    await p.waitForFunction(() => !document.getElementById('of-commune').disabled && document.getElementById('of-commune').options.length > 1);
    await p.selectOption('#of-commune', { index: 1 });
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    await Promise.all([p.waitForURL('**/confirmation/**'), p.click('#of-submit')]);
    assert.equal(JSON.parse(orderPosts()[0].body).phone, spelling);
  });

  await t('Eastern Arabic digits accepted as typed (server normalises)', async (p) => {
    await fill(p, { phone: '٠٥٥٥ ١٢ ٣٤ ٥٦' });
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    await Promise.all([p.waitForURL('**/confirmation/**'), p.click('#of-submit')]);
    assert.equal(JSON.parse(orderPosts()[0].body).phone, '٠٥٥٥ ١٢ ٣٤ ٥٦');
  });

  await t('409 total_changed: new total shown, next press re-confirms with the same key', async (p) => {
    mode.totalChangedOnce = true;
    await fill(p);
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    await p.click('#of-submit');
    await p.waitForFunction(() => /15[.\s ]?600/.test(document.getElementById('of-s-total').textContent));
    assert.ok((await p.textContent('#of-alert')).length > 0);
    await Promise.all([p.waitForURL('**/confirmation/**'), p.click('#of-submit')]);
    const [a, b] = orderPosts().map((r) => JSON.parse(r.body));
    assert.equal(a.idempotencyKey, b.idempotencyKey); assert.equal(b.expectedTotalDzd, 15600);
  });

  await t('409 answer while the customer edits qty: stale quote never confirmable, alert kept (ORDER-2 r1 F1, r2 F1)', async (p) => {
    mode.orderDelay = 1200; mode.totalChangedOnce = true; // the 409 also moves the server price to 15 000
    const changedMsg = await p.evaluate(() => document.querySelector('#of-msgs').content.querySelector('[data-k="total_changed"]').textContent);
    await fill(p);
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    await p.click('#of-submit');
    await p.waitForTimeout(300);
    await p.click('.of-step[data-d="1"]'); // qty 2 while the order request is pending
    // State, not timing: the re-quote for qty 2 has landed (2 × 15 000 + 600 = 30 600, never 15 600)…
    await p.waitForFunction(() => /30[.\s\u202f]?600/.test(document.getElementById('of-s-total').textContent));
    // …and the "total changed" alert is still there: a quote arriving on its own does not clear it.
    assert.equal(await p.textContent('#of-alert'), changedMsg);
    assert.doesNotMatch(await total(p), /15[.\s\u202f]?600/);
    // The customer's next edit clears it once its quote lands (3 × 15 000 + 600 = 45 600).
    await p.click('.of-step[data-d="1"]');
    await p.waitForFunction(() => /45[.\s\u202f]?600/.test(document.getElementById('of-s-total').textContent));
    assert.equal(await p.textContent('#of-alert'), '');
    await Promise.all([p.waitForURL('**/confirmation/**'), p.click('#of-submit')]);
    const posts = orderPosts().map((r) => JSON.parse(r.body));
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].items, [{ variantId: 12, qty: 3 }]);
    assert.equal(posts[1].expectedTotalDzd, 45600);
    assert.equal(posts[0].idempotencyKey, posts[1].idempotencyKey);
  });

  await t('409 total_changed with no edit: alert kept until the confirm press', async (p) => {
    mode.totalChangedOnce = true;
    const changedMsg = await p.evaluate(() => document.querySelector('#of-msgs').content.querySelector('[data-k="total_changed"]').textContent);
    await fill(p);
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    await p.click('#of-submit');
    await p.waitForFunction(() => /15[.\s\u202f]?600/.test(document.getElementById('of-s-total').textContent));
    assert.equal(await p.textContent('#of-alert'), changedMsg);
    await Promise.all([p.waitForURL('**/confirmation/**'), p.click('#of-submit')]);
  });

  await t('bfcache return (pageshow persisted) rotates the key', async (p) => {
    await fill(p);
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    mode.orderDelay = 0;
    await p.evaluate(() => { window.__nav = location.assign; });
    // Observe the key the next submit would use before and after a persisted pageshow.
    const k1 = await p.evaluate(async () => { const r = await new Promise((ok) => { const o = window.fetch; window.fetch = (u, i) => { if (String(u).includes('/api/order')) { ok(JSON.parse(i.body).idempotencyKey); return new Promise(() => {}); } return o(u, i); }; document.getElementById('of-submit').click(); }); return r; });
    await p.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    const k2 = await p.evaluate(async () => new Promise((ok) => { window.fetch = (u, i) => { ok(JSON.parse(i.body).idempotencyKey); return new Promise(() => {}); }; document.getElementById('of-submit').click(); }));
    assert.notEqual(k1, k2);
  });

  await t('commune list down → native submit to the server review step', async (p) => {
    mode.communesDown = true;
    await p.fill('#of-name', 'Amine Benali'); await p.fill('#of-phone', '0555123456'); await p.selectOption('#of-wilaya', '16');
    await p.waitForTimeout(400);
    await Promise.all([p.waitForURL('**/api/order'), p.click('#of-submit')]);
    const post = orderPosts().at(-1);
    assert.match(post.type, /x-www-form-urlencoded/);
    assert.equal(new URLSearchParams(post.body).get('idempotencyKey'), '');
  });

  // ---- ORDER-3: lazy Turnstile -----------------------------------------------------------------------
  const tsJsReqs = () => log.filter((r) => r.path.startsWith('/js/order-ts.js'));
  await t('Turnstile: nothing from challenges.cloudflare.com (nor the loader) before interaction', async (p, tsReqs) => {
    await p.waitForTimeout(2500); // load + idle, no interaction
    assert.deepEqual(tsReqs, []); assert.equal(tsJsReqs().length, 0);
    assert.equal(await p.evaluate(() => typeof window.turnstile), 'undefined');
  }, { page: 'ts', ts: 'stub' });

  await t('Turnstile: first focusin loads api.js once; token sent with the order; options invisible/interaction-only', async (p, tsReqs) => {
    await p.focus('#of-name'); await p.focus('#of-phone'); await p.click('#of-name');
    await p.waitForFunction(() => window.__tsOpts);
    assert.deepEqual(tsReqs, ['https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit']);
    assert.equal(tsJsReqs().length, 1);
    const o = await p.evaluate(() => window.__tsOpts);
    assert.equal(o.sitekey, '1x00000000000000000000AA'); assert.equal(o.action, 'order'); assert.equal(o.appearance, 'interaction-only');
    assert.equal(o.language, lang); assert.equal(o['response-field'], false);
    await fill(p);
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    await Promise.all([p.waitForURL('**/confirmation/**'), p.click('#of-submit')]);
    assert.equal(JSON.parse(orderPosts()[0].body).turnstileToken, 'tok-1');
    assert.equal(tsReqs.length, 1);
  }, { page: 'ts', ts: 'stub' });

  await t('Turnstile: pointerdown (no focus) also triggers the one load', async (p, tsReqs) => {
    await p.dispatchEvent('#of-sum', 'pointerdown');
    await p.waitForFunction(() => window.__tsOpts);
    assert.equal(tsReqs.length, 1);
  }, { page: 'ts', ts: 'stub' });

  await t('Turnstile: spent token is reset after a server answer (total_changed → fresh token)', async (p) => {
    mode.totalChangedOnce = true;
    await fill(p);
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    await p.click('#of-submit');
    await p.waitForFunction(() => document.getElementById('of-alert').textContent.length > 0);
    await p.waitForFunction(() => window.__tsResets === 1 && window.__tsN === 2);
    await Promise.all([p.waitForURL('**/confirmation/**'), p.click('#of-submit')]);
    const [a, b] = orderPosts().map((r) => JSON.parse(r.body));
    assert.equal(a.turnstileToken, 'tok-1'); assert.equal(b.turnstileToken, 'tok-2'); assert.equal(a.idempotencyKey, b.idempotencyKey);
  }, { page: 'ts', ts: 'stub' });

  await t('Turnstile: a bfcache return also resets the spent token (ORDER-3 review r1 nit)', async (p) => {
    await p.focus('#of-name');
    await p.waitForFunction(() => window.__tsN === 1);
    await p.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await p.waitForFunction(() => window.__tsResets === 1 && window.__tsN === 2);
  }, { page: 'ts', ts: 'stub' });

  await t('Turnstile blocked: the order goes through without a token', async (p, tsReqs) => {
    await fill(p);
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    const t0 = Date.now();
    await Promise.all([p.waitForURL('**/confirmation/**'), p.click('#of-submit')]);
    assert.ok(Date.now() - t0 < 4000, 'not held back');
    assert.equal(tsReqs.length, 1);
    assert.equal(JSON.parse(orderPosts()[0].body).turnstileToken, undefined);
  }, { page: 'ts', ts: 'abort' });

  await t('Turnstile hanging: the order waits at most ~3 s for a token, then goes without one', async (p) => {
    await fill(p);
    await p.waitForFunction(() => document.getElementById('of-s-total').textContent !== '—');
    const t0 = Date.now();
    await Promise.all([p.waitForURL('**/confirmation/**', { timeout: 10000 }), p.click('#of-submit')]);
    const dt = Date.now() - t0;
    assert.ok(dt >= 2500 && dt < 6000, `waited ${dt} ms`);
    assert.equal(JSON.parse(orderPosts()[0].body).turnstileToken, undefined);
  }, { page: 'ts', ts: 'hang' });
}

await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const lang of ['ar', 'fr']) await run(browser, lang);
} finally {
  await browser.close();
  server.close();
}
const report = results.join('\n');
console.log(report);
if (outDir) writeFileSync(`${outDir}/e2e.txt`, `${new Date().toISOString()}\n${report}\n`);
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
