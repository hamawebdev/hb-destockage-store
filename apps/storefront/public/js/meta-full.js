// Meta Pixel, consent choice and funnel events (D-014, artifacts/META-0/contract.md §5, §6). Loaded by the stub meta.js:
// after the first input for the choice, or at once for a stored `granted`; an unconfigured build does not ship this file.
// Nothing loads from or is sent to Meta before the visitor accepts. The choice is stored without a cookie.
// Pure helpers are exported for the tests, as order.js does.

const CHOICE_KEY = 'hb.meta.consent.v1';
const PENDING_KEY = 'hb.meta.purchase';
/** Same pattern as @hb/shared META_ID_RE (parity test). Checked before anything goes in the order body. */
export const META_ID_RE = /^fb\.\d\.\d{10,16}\.[\w.-]{1,480}$/;
/** Same shape as @hb/shared ORDER_REF_RE. */
export const REF_RE = /^HB-[0-9A-HJKMNP-TV-Z]{5}$/;
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

export const readCookie = (all, name) => new RegExp(`(?:^|; *)${name}=([^;]*)`).exec(all)?.[1].trim() ?? null;

/** What goes in the order body: consent, the page's Pixel ID, and _fbp/_fbc only if well-formed. */
export function signals(cookies, pixel) {
  const out = { consent: true, pixel };
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
  return pending && REF_RE.test(ref) && pending.ref === ref ? pending : null;
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

/**
 * Resolves once LCP has settled: on a thin page `load` and idle can come before it, and a page that builds its content
 * after `load` (checkout) paints a larger entry later. Done when no new entry has arrived for `quiet` ms.
 * A hidden tab has no LCP, so while hidden nothing counts down; the wait starts when it becomes visible.
 * Where the API is missing there is nothing to wait for; `cap` bounds the wait on a page with no LCP candidate.
 */
export function whenLcp(w, { cap = 5000, quiet = 500 } = {}, d = w.document) {
  return new Promise((done) => {
    const PO = w.PerformanceObserver;
    if (!PO?.supportedEntryTypes?.includes('largest-contentful-paint')) return done();
    let seen = false;
    let capTimer = null;
    let quietTimer = null;
    const visible = () => d.visibilityState !== 'hidden';
    const finish = () => {
      o.disconnect();
      w.clearTimeout(capTimer);
      w.clearTimeout(quietTimer);
      done();
    };
    const settle = () => {
      w.clearTimeout(quietTimer);
      quietTimer = w.setTimeout(finish, quiet);
    };
    const o = new PO((list) => {
      if (!list.getEntries().length) return;
      seen = true;
      if (visible()) settle();
    });
    o.observe({ type: 'largest-contentful-paint', buffered: true });
    const arm = () => {
      capTimer = w.setTimeout(finish, cap);
      if (seen) settle();
    };
    if (visible()) arm();
    else {
      const onChange = () => {
        if (!visible()) return;
        d.removeEventListener('visibilitychange', onChange);
        arm();
      };
      d.addEventListener('visibilitychange', onChange);
    }
  });
}

/** Resolves when the checkout has drawn its rows or shown the empty state: its LCP comes after that. Bounded by `cap`. */
export function whenRows(d, w, cap = 5000) {
  return new Promise((done) => {
    const end = Date.now() + cap;
    const poll = () => (d.getElementById('of-rows')?.children.length || d.getElementById('of-empty')?.hidden === false || Date.now() > end ? done() : w.setTimeout(poll, 50));
    poll();
  });
}

const D = typeof document === 'object' ? document : null;

/** What the privacy page's button does: forget the choice and everything Meta left in this browser. */
export function reset() {
  clearChoice();
  clearPending();
  for (const name of ['_fbp', '_fbc']) for (const c of cookieExpiries(name, location.hostname)) D.cookie = c;
  location.reload();
}

/** @param {'start'|'choice'} mode start: tracking begins after LCP has settled. choice: show the bar (input has already happened). */
export async function boot(id, mode) {
  await whenActive(D, window);
  const onCheckout = D.documentElement.dataset.tpl === 'checkout';
  if (mode === 'start') {
    if (onCheckout) await whenRows(D, window);
    await whenLcp(window, onCheckout ? { quiet: 1500 } : {});
  }
  const root = D.documentElement;
  const tpl = root.dataset.tpl;
  const lang = root.lang;
  let tracking = false;

  D.addEventListener('hb:order-sending', (e) => {
    if (tracking) e.detail.meta = signals(D.cookie, id);
  });
  D.addEventListener('hb:order-placed', (e) => {
    const d = e.detail;
    if (tracking && !d.duplicate && !d.honeypot) {
      savePending({ ref: d.ref, value: d.totalDzd, contents: d.items.map((i) => ({ id: String(i.variantId), quantity: i.qty })) });
    }
  });

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

  function initiateCheckout(fbq, contents, numItems, value) {
    if (value !== null) fbq('track', 'InitiateCheckout', { content_type: 'product', contents: contents, num_items: numItems, currency: 'DZD', value: value });
    else fbq('track', 'InitiateCheckout', { content_type: 'product', contents: contents, num_items: numItems });
  }

  function orderStepCheckout(fbq) {
    const f = D.getElementById('order-form');
    if (!f) return;
    const data = new FormData(f);
    const variant = Number(data.get('variantId'));
    const quantity = Number(data.get('qty')) || 1;
    const price = variant ? (f.dataset.variants || '').split(',').map((x) => x.split(':').map(Number)).find((x) => x[0] === variant)?.[1] : 0;
    initiateCheckout(fbq, variant ? [{ id: String(variant), quantity }] : [], quantity, price ? price * quantity : null);
  }

  async function cartCheckout(fbq, api) {
    const lines = api.store.lines();
    if (!lines.length) return;
    const products = await Promise.all(lines.map((l) => api.product(l.p).catch(() => null)));
    const prices = lines.map((l, i) => priceOf(products[i], l.v));
    const contents = lines.map((l) => ({ id: String(l.v), quantity: l.q }));
    const value = prices.every((p) => p !== null) ? lines.reduce((a, l, i) => a + prices[i] * l.q, 0) : null;
    initiateCheckout(fbq, contents, lines.reduce((a, l) => a + l.q, 0), value);
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
      // Literal values: the build does not scan this file when trimming page CSS, so a token used only here may be
      // absent, and an unconfigured or configured page must carry the same CSS (§6).
      'html{scroll-padding-block-end:var(--mc-sp,0)}body{padding-block-end:var(--mc-sp,0)}.mc{position:fixed;inset-inline:0;inset-block-end:var(--mc-off,0);z-index:10;display:grid;gap:12px;padding:8px 1rem calc(8px + env(safe-area-inset-bottom));background:#fff;box-shadow:0 -1px 0 #d2d2d7;font-size:.875rem}.mc p{margin:0}.mc a{color:#06c;display:inline-block;padding-block:calc((44px - 1lh)/2 + 1px);margin-block:calc((1lh - 44px)/2 - 1px)}.mc-a{display:flex;gap:8px}.mc-a button{flex:1;min-block-size:44px;font:inherit;background:#fff;border:1px solid #86868b;border-radius:99px}',
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

  // The stub has already read the choice and decided the mode.
  if (mode === 'start') start();
  else show();
}
