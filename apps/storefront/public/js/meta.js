// Meta Pixel, consent choice and funnel events (D-009, artifacts/META-0/contract.md §5, §6). Loaded after LCP by
// Base's [data-js] loader, only when META_PIXEL_ID was set at build time; an unconfigured build does not ship this file.
// Nothing loads from or is sent to Meta before the visitor accepts. The choice is stored without a cookie.
// Pure helpers are exported for the tests, as order.js does.

export const CHOICE_KEY = 'hb.meta.consent.v1';
export const PENDING_KEY = 'hb.meta.purchase';
/** Same pattern as @hb/shared META_ID_RE (parity test). Checked before anything goes in the order body. */
export const META_ID_RE = /^fb\.\d\.\d{10,16}\.[\w.-]{1,480}$/;
/** Same shape as @hb/shared ORDER_REF_RE. */
export const REF_RE = /^HB-[0-9A-HJKMNP-TV-Z]{5}$/;
/** Pages where the choice is never shown: nothing may compete with the confirm button. */
export const NO_CHOICE_TEMPLATES = ['order-step', 'checkout'];
const CLICK_WINDOW_MS = 5000;
const FBEVENTS = 'https://connect.facebook.net/en_US/fbevents.js';

let memoryChoice = null;

/** @returns {'granted'|'denied'|null} */
export function readChoice(storage = () => localStorage) {
  if (memoryChoice) return memoryChoice;
  try {
    const v = storage().getItem(CHOICE_KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null;
  }
}

export function saveChoice(value, storage = () => localStorage) {
  try {
    storage().setItem(CHOICE_KEY, value);
  } catch {
    memoryChoice = value; // holds for this page view
  }
}

export function clearChoice(storage = () => localStorage) {
  memoryChoice = null;
  try {
    storage().removeItem(CHOICE_KEY);
  } catch {}
}

export function readCookie(all, name) {
  for (const part of all.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** What goes in the order body: consent, plus _fbp/_fbc only if they have the expected shape. */
export function signals(cookies) {
  const out = { consent: true };
  for (const k of ['fbp', 'fbc']) {
    const v = readCookie(cookies, `_${k}`);
    if (v !== null && META_ID_RE.test(v)) out[k] = v;
  }
  return out;
}

/** Every `document.cookie` assignment that expires `name`: host-only and on each parent domain. */
export function cookieExpiries(name, hostname) {
  const base = `${name}=; Max-Age=0; path=/`;
  const out = [base];
  const labels = hostname.split('.');
  for (let i = 0; i + 1 < labels.length; i++) out.push(`${base}; domain=.${labels.slice(i).join('.')}`);
  return out;
}

/** Lines whose quantity rose between two cart snapshots, with the added delta. */
export function addedLines(before, after) {
  const had = new Map(before.map((l) => [l.v, l.q]));
  return after.filter((l) => l.q > (had.get(l.v) ?? 0)).map((l) => ({ p: l.p, v: l.v, q: l.q - (had.get(l.v) ?? 0) }));
}

export function savePending(p, storage = () => sessionStorage) {
  try {
    storage().setItem(PENDING_KEY, JSON.stringify(p));
  } catch {}
}

export function clearPending(storage = () => sessionStorage) {
  try {
    storage().removeItem(PENDING_KEY);
  } catch {}
}

/** Reads and removes the pending Purchase: it can be used once, whatever happens next. */
export function takePending(storage = () => sessionStorage) {
  try {
    const raw = storage().getItem(PENDING_KEY);
    storage().removeItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** The Purchase to fire on the confirmation page, or null. */
export function purchaseFor(ref, pending) {
  return pending && typeof ref === 'string' && REF_RE.test(ref) && pending.ref === ref ? pending : null;
}

/** Resolves after activation (never during a prerender), `load` and idle. */
export function whenActive(d, w) {
  return new Promise((done) => {
    const idle = () => (w.requestIdleCallback ? w.requestIdleCallback(done, { timeout: 3000 }) : w.setTimeout(done, 1));
    const afterLoad = () => (d.readyState === 'complete' ? idle() : w.addEventListener('load', idle, { once: true }));
    if (d.prerendering) d.addEventListener('prerenderingchange', afterLoad, { once: true });
    else afterLoad();
  });
}

const D = typeof document === 'object' ? document : null;
const pixel = D?.body?.dataset.metaPixel;
if (pixel) boot(pixel, D.body.dataset.metaConsent !== 'off');

async function boot(id, consentRequired) {
  await whenActive(D, window);
  const root = D.documentElement;
  const tpl = root.dataset.tpl;
  const lang = root.lang;
  let tracking = false;

  D.addEventListener('hb:order-sending', (e) => {
    if (tracking) e.detail.meta = signals(D.cookie);
  });
  D.addEventListener('hb:order-placed', (e) => {
    const d = e.detail;
    if (tracking && !d.duplicate && !d.honeypot) {
      savePending({ ref: d.ref, value: d.totalDzd, contents: d.items.map((i) => ({ id: String(i.variantId), quantity: i.qty })) });
    }
  });

  const reset = D.querySelector('[data-meta-reset]');
  if (reset) {
    reset.hidden = false;
    reset.addEventListener('click', () => {
      clearChoice();
      clearPending();
      for (const name of ['_fbp', '_fbc']) for (const c of cookieExpiries(name, location.hostname)) D.cookie = c;
      location.reload();
    });
  }

  function start() {
    tracking = true;
    const n = (window.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    });
    window._fbq = window._fbq || n;
    n.push = n;
    n.loaded = true;
    n.version = '2.0';
    n.queue = [];
    const fbq = window.fbq;
    fbq('set', 'autoConfig', false, id);
    fbq('init', id);
    fbq('track', 'PageView');
    const s = D.createElement('script');
    s.async = true;
    s.src = FBEVENTS;
    D.head.append(s);
    pageEvents(fbq);
  }

  async function cartApi() {
    const url = /\/js\/cart\.js(\?v=[\w-]+)?/.exec(D.body.dataset.js || '');
    if (!url) return null;
    const m = await import(url[0]);
    return m.api;
  }

  function priceOf(product, variantId) {
    return product?.variants.find((v) => v.id === variantId)?.price ?? null;
  }

  async function pageEvents(fbq) {
    if (tpl === 'product') {
      const m = /^(\d+):(\d+)$/.exec(D.querySelector('[data-meta-content]')?.dataset.metaContent ?? '');
      if (m) fbq('track', 'ViewContent', { content_type: 'product', content_ids: [m[1]], currency: 'DZD', value: Number(m[2]) });
    }
    if (tpl === 'order-confirmed') {
      const p = purchaseFor(new URLSearchParams(location.search).get('ref'), takePending());
      if (p) fbq('track', 'Purchase', { currency: 'DZD', value: p.value, content_type: 'product', contents: p.contents }, { eventID: p.ref });
    }
    const api = await cartApi().catch(() => null);
    if (tpl === 'order-step') orderStepCheckout(fbq);
    if (api) {
      if (tpl === 'checkout') await cartCheckout(fbq, api);
      watchCart(fbq, api);
    }
  }

  function orderStepCheckout(fbq) {
    const f = D.getElementById('order-form');
    if (!f) return;
    const data = new FormData(f);
    const variant = Number(data.get('variantId'));
    const quantity = Number(data.get('qty')) || 1;
    if (!variant) {
      fbq('track', 'InitiateCheckout', { content_type: 'product', num_items: quantity });
      return;
    }
    const price = (f.dataset.variants || '').split(',').map((x) => x.split(':').map(Number)).find((x) => x[0] === variant)?.[1];
    const contents = [{ id: String(variant), quantity }];
    if (price) fbq('track', 'InitiateCheckout', { content_type: 'product', contents, num_items: quantity, currency: 'DZD', value: price * quantity });
    else fbq('track', 'InitiateCheckout', { content_type: 'product', contents, num_items: quantity });
  }

  async function cartCheckout(fbq, api) {
    const lines = api.store.lines();
    if (!lines.length) return;
    const products = await Promise.all(lines.map((l) => api.product(l.p).catch(() => null)));
    const prices = lines.map((l, i) => priceOf(products[i], l.v));
    const contents = lines.map((l) => ({ id: String(l.v), quantity: l.q }));
    const num = lines.reduce((a, l) => a + l.q, 0);
    if (prices.every((p) => p !== null)) {
      const value = lines.reduce((a, l, i) => a + prices[i] * l.q, 0);
      fbq('track', 'InitiateCheckout', { content_type: 'product', contents, num_items: num, currency: 'DZD', value });
    } else fbq('track', 'InitiateCheckout', { content_type: 'product', contents, num_items: num });
  }

  function watchCart(fbq, api) {
    let last = api.store.lines();
    let clicked = 0;
    D.addEventListener('click', () => (clicked = Date.now()), true);
    api.store.sub(() => {
      const next = api.store.lines();
      const added = addedLines(last, next);
      last = next;
      if (!added.length || Date.now() - clicked > CLICK_WINDOW_MS || D.visibilityState !== 'visible') return;
      for (const a of added) {
        api.product(a.p).catch(() => null).then((p) => {
          const price = priceOf(p, a.v);
          if (price !== null) fbq('track', 'AddToCart', { content_type: 'product', contents: [{ id: String(a.v), quantity: a.q }], currency: 'DZD', value: price * a.q });
          else fbq('track', 'AddToCart', { content_type: 'product', contents: [{ id: String(a.v), quantity: a.q }] });
        });
      }
    });
  }

  function arm() {
    if (NO_CHOICE_TEMPLATES.includes(tpl)) return;
    const events = ['scroll', 'keydown', 'pointerdown'];
    const go = () => {
      events.forEach((e) => removeEventListener(e, go, true));
      setTimeout(show, 400); // so the tap that triggered it cannot land on it
    };
    events.forEach((e) => addEventListener(e, go, { capture: true, passive: true }));
  }

  async function show() {
    let t;
    try {
      const r = await fetch(`/${lang}/meta/ui.json`);
      if (!r.ok) return;
      t = await r.json();
    } catch {
      return;
    }
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      'html{scroll-padding-block-end:var(--mc-sp,0)}.mc{position:fixed;inset-inline:0;inset-block-end:var(--mc-off,0);z-index:var(--z-sticky);display:grid;gap:var(--space-3);padding:var(--space-2) var(--gutter) calc(var(--space-2) + env(safe-area-inset-bottom));background:var(--color-surface);box-shadow:0 -1px 0 var(--color-border);font-size:var(--fs-small)}.mc p{margin:0}.mc a{color:var(--color-accent-text);display:inline-block;padding-block:calc((var(--tap-min) - 1lh)/2);margin-block:calc((1lh - var(--tap-min))/2)}.mc-a{display:flex;gap:var(--space-2)}.mc-a button{flex:1;min-block-size:var(--tap-min)}',
    );
    D.adoptedStyleSheets = [...D.adoptedStyleSheets, sheet];
    const el = D.createElement('section');
    el.className = 'mc';
    el.setAttribute('aria-labelledby', 'mc-t');
    const p = D.createElement('p');
    const label = D.createElement('span');
    label.id = 'mc-t';
    label.textContent = t.text;
    p.append(label);
    if (t.privacy) {
      const a = D.createElement('a');
      a.href = t.privacy;
      a.textContent = t.more;
      p.append(' ', a);
    }
    el.append(p);
    const row = D.createElement('div');
    row.className = 'mc-a';
    const button = (label) => {
      const b = D.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-secondary';
      b.textContent = label;
      return b;
    };
    const yes = button(t.accept);
    const no = button(t.decline);
    row.append(yes, no);
    el.append(row);
    D.body.append(el);

    const bar = D.querySelector('.cat-buybar');
    const place = () => {
      const off = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().height : 0;
      el.style.setProperty('--mc-off', `${off}px`);
      root.style.setProperty('--mc-sp', `${off + el.getBoundingClientRect().height + 8}px`);
    };
    place();
    const ro = new ResizeObserver(place);
    if (bar) ro.observe(bar);
    ro.observe(el);
    const close = () => {
      ro.disconnect();
      el.remove();
      root.style.removeProperty('--mc-sp');
      D.adoptedStyleSheets = D.adoptedStyleSheets.filter((s) => s !== sheet);
    };
    yes.addEventListener('click', () => {
      saveChoice('granted');
      close();
      start();
    });
    no.addEventListener('click', () => {
      saveChoice('denied');
      close();
    });
  }

  const choice = readChoice();
  if (choice === 'granted' || (!consentRequired && choice !== 'denied')) start();
  else {
    clearPending();
    if (choice === null) arm();
  }
}
