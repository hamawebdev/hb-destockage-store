// Comptoir de Luxe cart (CART-0, D-008). Plain ES module, no dependencies, loaded after LCP by Base's [data-js] loader.
// Everything here is the small part that must exist on every page: the pure cart rules (unit-tested), the storage
// wrapper and the header count. The sheet (dialog, CSS, copy) is cart-sheet.js, imported on first use. No cookies.
// The cart only stores ids and quantities: names, photos, prices and limits are read per language from the static
// /{lang}/cart/items/<product id>.json, so a language switch or a price change just works. /api/quote stays the authority.

export const KEY = 'hb.cart.v1';
/** @hb/shared MAX_QTY_PER_LINE and MAX_ORDER_LINES (parity test in test/cart.test.ts). */
export const MAX_QTY = 10;
export const MAX_LINES = 10;

const isId = (x) => Number.isSafeInteger(x) && x > 0;

/** Stored JSON -> valid lines. Anything corrupt, foreign or over the limits is dropped or capped, never thrown. */
export function parse(raw) {
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!d || d.v !== 1 || !Array.isArray(d.lines)) return [];
  const out = [];
  for (const l of d.lines) {
    if (!l || !isId(l.p) || !isId(l.v) || !Number.isSafeInteger(l.q) || l.q < 1) continue;
    const same = out.find((x) => x.v === l.v);
    if (same) same.q = Math.min(MAX_QTY, same.q + l.q);
    else if (out.length < MAX_LINES) out.push({ p: l.p, v: l.v, q: Math.min(MAX_QTY, l.q) });
  }
  return out;
}

export const serialize = (lines) => JSON.stringify({ v: 1, lines });

export const count = (lines) => lines.reduce((n, l) => n + l.q, 0);

const cap = (max) => Math.max(0, Math.min(MAX_QTY, Number.isFinite(max) ? Math.trunc(max) : MAX_QTY));

/**
 * One more line, or more of a line already there (one variant is always one line).
 * @returns {{lines: object[], status: 'ok'|'qty_max'|'lines_max'}} `qty_max`: stopped at the limit (nothing or part added).
 */
export function addLine(lines, p, v, qty = 1, max = MAX_QTY) {
  const m = cap(max);
  const same = lines.find((l) => l.v === v);
  if (same) {
    const q = Math.min(m, same.q + qty);
    return { lines: lines.map((l) => (l === same ? { ...l, q: Math.max(l.q, q) } : l)), status: same.q + qty > m ? 'qty_max' : 'ok' };
  }
  if (lines.length >= MAX_LINES) return { lines, status: 'lines_max' };
  if (m < 1) return { lines, status: 'qty_max' };
  return { lines: [...lines, { p, v, q: Math.min(m, qty) }], status: qty > m ? 'qty_max' : 'ok' };
}

/** New quantity for one line, kept within 1..max. @returns {{lines: object[], status: 'ok'|'qty_max'}} */
export function setQty(lines, v, q, max = MAX_QTY) {
  const m = Math.max(1, cap(max));
  const next = Math.max(1, Math.min(m, Math.trunc(q) || 1));
  return { lines: lines.map((l) => (l.v === v ? { ...l, q: next } : l)), status: q > m ? 'qty_max' : 'ok' };
}

export const removeLine = (lines, v) => lines.filter((l) => l.v !== v);

/** After an order: only what was ordered leaves the cart (another tab may have added something meanwhile). */
export const removeVariants = (lines, ids) => lines.filter((l) => !ids.includes(l.v));

/**
 * localStorage behind try/catch with a memory fallback (private mode, quota, disabled storage).
 * Lines are re-read on every call, so the last write of any tab wins and nothing goes stale.
 * @param {() => Storage} storage
 */
export function createStore(storage = () => localStorage) {
  let memory = null; // non-null once storage has failed: the cart then lives for this page view
  const subs = new Set();
  const lines = () => {
    if (memory) return memory;
    try {
      return parse(storage().getItem(KEY) ?? '');
    } catch {
      memory = [];
      return memory;
    }
  };
  const notify = () => subs.forEach((f) => f());
  return {
    lines,
    /** @param {object[]} next */
    write(next) {
      if (memory) memory = next;
      else {
        try {
          storage().setItem(KEY, serialize(next));
        } catch {
          memory = next;
        }
      }
      notify();
    },
    /** `storage` event from another tab (a null key means the whole storage was cleared). */
    onStorage(e) {
      if (e.key === KEY || e.key === null) notify();
    },
    sub(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
    notify,
  };
}

const NF = {};
const money = (n, lang) =>
  (NF[lang] ||= new Intl.NumberFormat(lang === 'ar' ? 'ar-DZ' : 'fr-DZ', {
    style: 'currency',
    currency: 'DZD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })).format(n);

/** The page's cart, once init() has run. order.js (checkout) imports this same module instance. */
export let api = null;

const D = typeof document === 'object' ? document : null;
const root = D?.querySelector('[data-cart-open]');
if (root) init(root);

function init(btn) {
  const c = btn.dataset;
  const store = createStore();
  const counters = [...D.querySelectorAll('[data-cart-n]')];
  const paint = () => {
    const n = count(store.lines());
    for (const e of counters) {
      e.textContent = n ? String(n) : '';
      e.hidden = !n;
    }
  };
  store.sub(paint);
  addEventListener('storage', (e) => store.onStorage(e));
  // bfcache: storage events are not delivered to a frozen page.
  addEventListener('pageshow', (e) => e.persisted && store.notify());

  const products = new Map();
  const product = (id) => {
    let p = products.get(id);
    if (!p) {
      p = fetch(c.items.replace('{id}', id))
        .then((r) => (r.ok ? r.json() : r.status === 404 ? null : Promise.reject(r.status)))
        .catch((err) => {
          products.delete(id); // a network failure may be retried; a 404 is an answer
          throw err;
        });
      products.set(id, p);
    }
    return p;
  };

  let sheet = null;
  const loadSheet = () =>
    (sheet ||= import(c.sheet)
      .then((m) => m.create(api))
      .catch((err) => {
        sheet = null; // a failed download may be retried on the next tap
        throw err;
      }));

  api = {
    store,
    lang: c.lang,
    urls: { checkout: c.checkout, home: c.home, ui: c.ui },
    money: (n) => money(n, c.lang),
    product,
    loadSheet,
    open: (opener) => loadSheet().then((s) => s.openCart(opener)),
    addLine,
    setQty,
    removeLine,
    removeVariants,
    count,
    maxLines: MAX_LINES,
  };

  D.addEventListener('click', (e) => {
    const t = e.target.closest?.('[data-cart-open],[data-cart-add]');
    if (!t) return;
    e.preventDefault();
    const done = 'cartOpen' in t.dataset ? api.open(t) : addFrom(t);
    done.catch(() => {}); // offline: the control simply does nothing, the page stays usable
  });
  const addFrom = (t) => {
    const form = t.dataset.form && D.getElementById(t.dataset.form);
    const variant = form ? Number(new FormData(form).get('v')) || null : null;
    return loadSheet().then((s) => s.add(Number(t.dataset.cartAdd), variant, t));
  };
  // Warm the sheet as soon as a cart control is approached, or at once when there is already something in the cart.
  const warm = (e) => e.target.closest?.('[data-cart-open],[data-cart-add]') && loadSheet().catch(() => {});
  D.addEventListener('pointerover', warm, { passive: true });
  D.addEventListener('focusin', warm);
  if (store.lines().length) (window.requestIdleCallback || setTimeout)(() => loadSheet().catch(() => {}));

  paint();
  D.documentElement.classList.add('cart-on'); // reveals the cart button and the add buttons (hidden without JS)
}
