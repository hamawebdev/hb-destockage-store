// HB Destockage order form enhancement (ORDER-2). Plain ES module, no dependencies, loaded after LCP by
// shell's [data-js] loader. Plan: artifacts/ORDER-0/plan.md §4 + the lead's rulings. Contracts: WEB-0 §2.1–2.2.
// Rules: the total is always shown before an order is created; one idempotency key per page view, kept
// across retries; DOM writes use textContent/Option only. Pure helpers are exported for the parity tests.
// Cart mode (form data-mode="cart", /{lang}/checkout/, CART-0): the same form, quote and confirm logic over the
// lines of cart.js instead of one product; there is no no-JS path, so the form is never posted natively.

const DIGITS = /[٠-٩۰-۹０-９]/g;
/** Eastern Arabic, Persian and fullwidth digits → ASCII (same as @hb/shared toAsciiDigits). */
export const toAscii = (s) =>
  s.replace(DIGITS, (d) => {
    const c = d.charCodeAt(0);
    return String(c - (c >= 0xff10 ? 0xff10 : c >= 0x6f0 ? 0x6f0 : 0x660));
  });

/** Client hint mirroring @hb/shared normalizePhone: null when acceptable, else an error code. Server decides. */
export function phoneError(input, nsnPattern) {
  if (input.length > 64) return 'phone_invalid';
  const s = toAscii(input).replace(/＋/g, '+').replace(/[\s\p{Cf}\-‐-―−.()]/gu, '');
  if (!s) return 'phone_required';
  if (!/^\+?\d+$/.test(s)) return 'phone_invalid';
  const mobile = new RegExp(`^(?:${nsnPattern})$`);
  // NSN → verdict. "not mobile" vs "invalid" only picks the message; the server's verdict wins.
  const nsn = (x) => (mobile.test(x) ? null : /^[1-9]\d{7,8}$/.test(x) ? 'phone_not_mobile' : 'phone_invalid');
  let rest;
  if (s[0] === '+') {
    if (!s.startsWith('+213')) return 'phone_invalid';
    rest = s.slice(4);
  } else if (s.startsWith('00213')) rest = s.slice(5);
  else if (s.startsWith('213') && s.length >= 11 && s.length <= 13) rest = s.slice(3);
  else if (s[0] === '0') return nsn(s.slice(1));
  else return mobile.test(s) ? null : 'phone_invalid';
  // `+213 0555…`: a redundant trunk 0 after the country code.
  if (rest[0] === '0' && (rest.length === 9 || rest.length === 10)) rest = rest.slice(1);
  return nsn(rest);
}

const NF = {};
/** Integer DZD, Intl ar-DZ / fr-DZ (same options as @hb/shared formatPrice). */
export const fmt = (n, lang) =>
  (NF[lang] ||= new Intl.NumberFormat(lang === 'ar' ? 'ar-DZ' : 'fr-DZ', {
    style: 'currency',
    currency: 'DZD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })).format(n);

/** `id:priceDzd:maxQty,…` (form data-variants) → Map. */
export const parseVariants = (s) =>
  new Map(
    (s || '').split(',').filter(Boolean).map((x) => {
      const [id, price, max] = x.split(':').map(Number);
      return [id, { id, price, max, ok: max > 0 }];
    }),
  );

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** POST JSON with a timeout; resolves {status, body}; rejects on network error/abort. */
export async function post(url, body, ms, signal) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  signal?.addEventListener('abort', () => c.abort());
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: c.signal,
    });
    let b = {};
    try {
      b = await r.json();
    } catch {}
    return { status: r.status, body: b };
  } finally {
    clearTimeout(t);
  }
}

const D = typeof document === 'object' ? document : null;
const form = D?.getElementById('order-form');
if (form && !form.dataset.ready) init(form);

function init(f) {
  f.dataset.ready = '1';
  const $ = (id) => D.getElementById('of-' + id);
  const ds = f.dataset;
  const lang = ds.lang;
  // BUG-12: six UI-state strings inline (#of-ui); error copy + phone pattern in /{lang}/order/form.json, fetched now
  // (after LCP). Until it is loaded a confirm press posts the plain no-JS form (server review page, its own messages).
  const UI = new Map([...$('ui').content.querySelectorAll('[data-k]')].map((p) => [p.dataset.k, p.textContent]));
  let M = new Map();
  let cfg = null;
  const loadCfg = (tries) =>
    fetch(ds.cfg)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((c) => {
        cfg = c;
        M = new Map(Object.entries(c.m));
        f.classList.add('of-cfg'); // state hook: error copy available (tests wait on it, not on timing)
      })
      .catch(() => tries > 0 && loadCfg(tries - 1));
  if (ds.cfg) loadCfg(1);
  const msg = (k, v = {}) => (M.get(k) ?? UI.get(k) ?? '').replace(/\{(\w+)\}/g, (x, n) => (n in v ? v[n] : x));
  const money = (n) => fmt(n, lang);
  const variants = parseVariants(ds.variants);
  const vLabels = ds.vl ? JSON.parse(ds.vl) : {};
  const cartMode = ds.mode === 'cart';
  let cart = null; // cart.js api (cart mode)
  let rows = []; // cart mode: {p, v, q, name, label, price, max, ok, img, priceEl}
  const el = f.elements;
  const [name, phone, wil, com, qty, btn, sum, sumH, status, alertEl, help] =
    ['name', 'phone', 'wilaya', 'commune', 'qty', 'submit', 'sum', 'sum-h', 'status', 'alert', 'help'].map($);
  const feeLabel = $('s-fee-l').textContent;
  // Texts already in the static DOM (not duplicated in #of-ui).
  const pendingText = $('s-fee').textContent;
  const waitingText = com.options[0].text;
  const submitText = btn.textContent;
  const formMax = Number(qty?.max) || 10;
  const communes = new Map();
  const quotes = new Map();
  let key = uuid();
  let started = 0; // performance.now() of the first interaction (fillMs)
  let busy = false;
  let blocked = false; // quote failed / area unavailable: confirm stays disabled (lead's rule)
  let communeFail = false; // commune list unavailable → native submit to the server review step
  let quote = null; // last quote applied to the summary, with .k = inputs it was made for
  let seq = 0;
  let qCtrl = null;
  let qTimer = 0;
  let ts = null; // Turnstile module (ORDER-3)
  // A "total changed" alert must stay until the customer acts (edits a field or presses confirm): a quote arriving
  // on its own (e.g. the re-quote that follows it) must not clear it (ORDER-2 review r2 F1, lead's rule).
  let stickyAlert = false;
  const customerActed = () => (stickyAlert = false);

  const readVariant = () => variants.get(Number(el.namedItem('variantId')?.value)) ?? null;
  let variant = readVariant();
  const n = () => (qty ? Math.trunc(Number(toAscii(qty.value))) || 0 : 0);
  /** What is being ordered, in the /api/quote and /api/order shape. */
  const items = () =>
    cartMode ? rows.filter((r) => r.ok).map((r) => ({ variantId: r.v, qty: r.q })) : variant ? [{ variantId: variant.id, qty: n() }] : [];
  const inputs = () => `${items().map((i) => `${i.variantId}:${i.qty}`).join(',')}|${wil.value}|${com.value}`;
  const text = (e, t) => (e.textContent = t);
  const say = (t) => text(status, t);
  const setBlocked = (b) => {
    blocked = b;
    b ? btn.setAttribute('aria-disabled', 'true') : busy || btn.removeAttribute('aria-disabled');
    help.hidden = !b;
  };
  const showAlert = (t, withHelp) => {
    text(alertEl, t || '');
    if (withHelp) help.hidden = false;
  };
  const fieldOf = { name, phone, wilayaCode: wil, communeId: com, items: qty };
  const fields = qty ? [name, phone, wil, com, qty] : [name, phone, wil, com];
  const setErr = (input, code, v) => {
    const slot = D.getElementById(input.id + '-err');
    text(slot, code ? msg(code, v) : '');
    code ? input.setAttribute('aria-invalid', 'true') : input.removeAttribute('aria-invalid');
  };
  const clearErrors = () => {
    for (const i of fields) setErr(i, null);
    showAlert('');
  };
  const countMsg = (c) => msg('count_' + new Intl.PluralRules(lang === 'ar' ? 'ar-DZ' : 'fr-DZ').select(c), { count: c });

  f.classList.add('of-js');

  // --- interaction start: fillMs + lazy Turnstile (first focusin / pointerdown inside the form) -----------
  const start = () => {
    if (started) return;
    started = performance.now();
    if (ds.tsJs && ds.tsKey)
      import(ds.tsJs)
        .then((m) => {
          ts = m;
          m.load($('ts'), ds.tsKey, lang);
        })
        .catch(() => {});
  };
  f.addEventListener('focusin', start);
  f.addEventListener('pointerdown', start);
  if (f.contains(D.activeElement)) start();

  // --- quantity --------------------------------------------------------------------------------------
  const clampQty = () => {
    if (!qty) return;
    const max = Math.max(1, Math.min(formMax, variant?.max || formMax));
    qty.max = String(max);
    const v = n();
    if (qty.value !== '' && (v < 1 || v > max)) qty.value = String(Math.min(max, Math.max(1, v)));
  };
  f.addEventListener('click', (e) => {
    const b = e.target.closest?.('.of-step');
    if (b) {
      customerActed();
      qty.value = String((n() || 1) + Number(b.dataset.d));
      changed();
    }
  });
  qty?.addEventListener('input', () => {
    clearTimeout(qTimer);
    customerActed();
    qTimer = setTimeout(changed, 300);
  });

  // --- variant (pages' contract: hb:variant on the form; inputs outside <form> carry form="order-form") ----
  f.addEventListener('hb:variant', (e) => {
    customerActed();
    const x = e.detail;
    variant = x?.variantId ? { id: x.variantId, price: x.priceDzd, max: x.maxQty, ok: !!x.available } : null;
    changed();
  });
  D.addEventListener('change', (e) => {
    const t = e.target;
    if (t.form !== f) return;
    customerActed();
    if (t === wil) loadCommunes();
    if (t.name === 'variantId') variant = readVariant();
    if (t === wil || t === com || t === qty || t.name === 'variantId') changed();
  });

  // --- communes (per-wilaya JSON, page language, already collated) --------------------------------------
  async function loadCommunes() {
    const code = wil.value;
    com.disabled = true;
    com.length = 0;
    com.add(new Option(code ? msg('loading') : waitingText, ''));
    com.setAttribute('aria-busy', 'true');
    let list = communes.get(code);
    for (let i = 0; code && !list && i < 2; i++) {
      try {
        const r = await fetch(ds.communes.replace('{code}', code));
        if (r.ok) list = await r.json();
      } catch {}
    }
    if (wil.value !== code) return;
    com.removeAttribute('aria-busy');
    communeFail = !!code && !list;
    if (!list) {
      com.options[0].text = waitingText;
      return;
    }
    communes.set(code, list);
    com.options[0].text = msg('commune_placeholder');
    for (const [id, label] of list) com.add(new Option(label, String(id)));
    com.disabled = false;
  }

  // --- summary + live quote ----------------------------------------------------------------------------
  function render() {
    const q = quote && quote.k === inputs() ? quote : null;
    if (cartMode) paintRows();
    else {
      const line = q?.lines?.[0];
      const unit = line ? line.unitPriceDzd : variant?.price;
      text($('s-unit'), unit == null ? '—' : money(unit * (n() || 1)));
      const vEl = $('s-var');
      if (vEl) text(vEl, variant ? vLabels[variant.id] ?? '' : '');
    }
    const avail = q?.available;
    const wName = wil.selectedOptions[0]?.text.replace(/^\d+\s*-\s*/, '');
    text($('s-fee-l'), avail ? msg('delivery_to', { wilaya: wName }) : feeLabel);
    const waiting = !q && !blocked && items().length && (cartMode || variant?.ok) && sum.getAttribute('aria-busy');
    text($('s-fee'), avail ? money(q.feeDzd) : !wil.value ? pendingText : waiting ? msg('calculating') : '—');
    text($('s-total'), avail ? money(q.totalDzd) : '—');
  }

  function changed() {
    clampQty();
    render();
    requote();
  }

  async function requote() {
    const k = inputs();
    if (quote?.k === k) return quote;
    if ((!cartMode && (!variant?.ok || n() < 1)) || !items().length || !wil.value) {
      quote = null;
      render();
      return null;
    }
    let d = quotes.get(k);
    if (!d) {
      const my = ++seq;
      qCtrl?.abort();
      qCtrl = new AbortController();
      sum.setAttribute('aria-busy', 'true');
      render();
      const body = { items: items(), wilayaCode: Number(wil.value) };
      if (com.value) body.communeId = Number(com.value);
      try {
        const r = await post(ds.quote, body, 8000, qCtrl.signal);
        d = { ...r.body, status: r.status };
      } catch {
        d = { status: 0 };
      }
      if (my !== seq) return null;
      sum.removeAttribute('aria-busy');
      if (d.status === 200 && d.ok) quotes.set(k, d);
    }
    return apply(k, d);
  }

  /** Applies a quote answer (also the `quote` carried by 409 order answers). */
  function apply(k, d) {
    if (cartMode) syncRows(d.lines);
    const line = d.lines?.[0];
    if (!cartMode && line && variant && line.variantId === variant.id) {
      variant.max = line.maxQty;
      variant.ok = line.maxQty > 0;
      if (line.unitPriceDzd != null) variant.price = line.unitPriceDzd;
    }
    if (d.ok && d.status === 200) {
      quote = { ...d, k };
      setBlocked(!d.available);
      if (!d.available) showAlert(msg('delivery_unavailable'), true);
      else if (!stickyAlert) showAlert('');
      render();
      if (d.available && k === inputs()) say(msg('updated', { total: money(d.totalDzd) })); // never announce a stale total
      return quote;
    }
    quote = null;
    render();
    if (d.status === 422 && d.errors) fieldErrors(d.errors);
    else if (d.code === 'out_of_stock' || d.code === 'variant_unavailable') {
      if (cartMode) {
        settleRows();
        showAlert(msg(d.code));
      } else {
        clampQty();
        setErr(qty, d.code);
      }
    } else if (d.code === 'order_total_out_of_range') {
      setBlocked(true);
      showAlert(msg(d.code), true);
    } else {
      setBlocked(true);
      stickyAlert = false; // the failure message replaces it and is not sticky itself
      showAlert(msg('quote_failed'), true);
    }
    return null;
  }

  $('retry').addEventListener('click', () => {
    quotes.delete(inputs());
    quote = null;
    setBlocked(false);
    showAlert('');
    if (communeFail) loadCommunes();
    requote();
  });

  function fieldErrors(errors) {
    let first = null;
    for (const e of errors || []) {
      const input = fieldOf[e.field];
      if (input) {
        setErr(input, M.has(e.code) ? e.code : 'invalid_request', { max: qty.max });
        first ||= input;
      } else showAlert(msg(M.has(e.code) ? e.code : 'invalid_request'));
    }
    first?.focus();
  }

  // --- client checks (hints; the server is authoritative) ----------------------------------------------
  function check() {
    const nm = name.value.trim();
    const q = n();
    const max = Number(qty?.max);
    const list = [
      [name, !nm ? 'name_required' : nm.length < 2 || nm.length > 80 || !/\p{L}/u.test(nm) ? 'name_invalid' : 0],
      [phone, phoneError(phone.value, cfg.re)],
      [wil, wil.value ? 0 : 'wilaya_required'],
      [com, !wil.value || com.value ? 0 : 'commune_required'],
    ];
    if (qty) list.push([qty, q >= 1 && q <= max && String(q) === toAscii(qty.value).trim() ? 0 : 'qty_invalid']);
    const bad = list.filter((x) => x[1]);
    for (const [i, c] of list) setErr(i, c || null, { max });
    return bad;
  }

  // --- submit ------------------------------------------------------------------------------------------
  f.addEventListener('submit', async (e) => {
    if (!cfg || (communeFail && wil.value)) {
      // No error copy yet (form.json failed, slow or not loaded) or no commune list: never block the order. Let the
      // browser post the no-JS form; the server's review step validates, shows its own messages and the total.
      // The cart has no no-JS path: say so and let the customer retry instead of posting nothing useful.
      if (!cartMode) {
        el.idempotencyKey.value = '';
        return;
      }
      e.preventDefault();
      if (!cfg) loadCfg(1);
      showAlert(msg('quote_failed'), true);
      return;
    }
    e.preventDefault();
    customerActed();
    if (busy) return;
    showAlert('');
    const bad = check();
    if (bad.length) {
      showAlert(countMsg(bad.length));
      bad[0][0].focus();
      return;
    }
    if (cartMode ? !items().length : !variant?.ok) {
      showAlert(msg(cartMode ? 'items_empty' : variant ? 'variant_unavailable' : 'variant_required'));
      return;
    }
    if (blocked) {
      help.hidden = false;
      alertEl.textContent || showAlert(msg('quote_failed'), true);
      return;
    }
    if (quote?.k !== inputs() || !quote.available) {
      // Confirm gate: the total for exactly these inputs has not been shown yet → show it, confirm next press.
      const q = await requote();
      if (q?.available) {
        sumH.focus();
        say(msg('check_total'));
      }
      return;
    }
    send(false);
  });

  async function send(isRetry) {
    busy = true;
    btn.setAttribute('aria-disabled', 'true');
    text(btn, msg('submitting'));
    say(msg('submitting'));
    const sentK = inputs(); // the inputs this request (and any 409 quote in its answer) is about
    const body = {
      idempotencyKey: key,
      lang,
      items: items(),
      name: name.value,
      phone: phone.value,
      wilayaCode: Number(wil.value),
      communeId: Number(com.value),
      expectedTotalDzd: quote.totalDzd,
      website: el.website.value,
    };
    if (started) body.fillMs = Math.round(performance.now() - started);
    const tok = ts ? await ts.token(3000).catch(() => '') : '';
    if (tok) body.turnstileToken = tok;
    let r;
    try {
      r = await post(f.action, body, 20000);
    } catch {
      if (!isRetry) {
        await new Promise((ok) => setTimeout(ok, 1500));
        return send(true); // same key: if the first attempt reached the server, this returns that order
      }
      r = { status: 0, body: {} };
    }
    const d = r.body || {};
    if (d.ok && d.ref) {
      if (cartMode) cart.store.write(cart.removeVariants(cart.store.lines(), body.items.map((i) => i.variantId)));
      location.assign(d.confirmationUrl || `${cfg.confirm}?ref=${encodeURIComponent(d.ref)}`);
      return;
    }
    busy = false;
    btn.removeAttribute('aria-disabled');
    text(btn, submitText);
    say('');
    if (r.status) ts?.reset(); // the server has seen (and spent) this Turnstile token
    const c = d.code;
    // 409 answers carry a fresh quote (WEB-0 §2.2) for the inputs that were SENT. If the customer edited the form
    // while the request was pending, it is not the summary of what is on screen: render() shows "—" for it and the
    // current inputs are re-quoted, so the confirm gate cannot pass on a stale total (ORDER-2 review r1 F1).
    if (d.quote) {
      quotes.clear(); // a 409 means server prices/stock moved: cached quotes for other inputs are stale too
      apply(sentK, { ...d.quote, ok: true, status: 200 });
      if (sentK !== inputs()) changed();
    }
    if (c === 'total_changed') {
      showAlert(msg('total_changed'));
      stickyAlert = true;
      sumH.focus();
    } else if (c === 'validation') {
      showAlert(countMsg(d.errors?.length || 1));
      fieldErrors(d.errors);
    } else if (c === 'out_of_stock' || c === 'variant_unavailable') {
      changed(); // clamps qty to the fresh maxQty and re-quotes
      if (cartMode) showAlert(msg(c));
      else {
        setErr(qty, c);
        qty.focus();
      }
    } else if (c === 'delivery_unavailable') {
      showAlert(msg(c), true);
    } else if (c === 'rate_limited') {
      showAlert(msg(c), true);
      btn.setAttribute('aria-disabled', 'true');
      busy = true;
      setTimeout(() => {
        busy = false;
        btn.removeAttribute('aria-disabled');
      }, (d.retryAfterS || 60) * 1000);
    } else {
      const k = r.status === 0 ? 'network_error' : M.has(c) ? c : r.status >= 500 ? 'server_error' : 'invalid_request';
      showAlert(msg(k), k !== 'invalid_request');
    }
  }

  // Back from the confirmation page (bfcache): a deliberate new order gets a new key.
  addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    if (cartMode) loadRows();
    key = uuid();
    ts?.reset(); // the previous order spent the Turnstile token too (ORDER-3 review r1 nit)
    busy = false;
    btn.removeAttribute('aria-disabled');
    text(btn, submitText);
    say('');
  });

  // --- cart mode: the lines of cart.js, drawn here; same quote and confirm path as a single product -------
  function drawRows() {
    const list = $('rows');
    list.textContent = '';
    for (const r of rows) {
      const li = D.createElement('li');
      li.className = r.ok ? 'of-row' : 'of-row is-na';
      const th = D.createElement(r.img ? 'img' : 'span');
      th.className = 'of-th';
      if (r.img) {
        th.srcset = r.img.srcset;
        th.src = r.img.src;
        th.sizes = '64px';
        th.alt = '';
        th.width = 64;
        th.height = 64;
        th.decoding = 'async';
      }
      const d = D.createElement('div');
      d.className = 'of-l-d';
      const add = (cls, t, tag = 'p') => {
        const e = D.createElement(tag);
        e.className = cls;
        const b = D.createElement('bdi');
        b.textContent = t;
        e.append(b);
        d.append(e);
        return e;
      };
      add('of-l-n', r.name || msg(r.err ? 'load_failed' : 'unavailable'));
      if (r.ok) {
        if (r.label) add('of-l-v', r.label);
        r.priceEl = add('of-l-p', '');
        const q = D.createElement('div');
        q.className = 'of-q';
        const btnQ = (mark, delta, label) => {
          const b = D.createElement('button');
          b.type = 'button';
          b.className = 'of-b';
          b.textContent = mark;
          b.dataset.k = `${delta > 0 ? 'plus' : 'minus'}:${r.v}`;
          b.setAttribute('aria-label', `${msg(label)} · ${r.name}`);
          const stop = delta > 0 ? r.q >= r.max : r.q <= 1;
          if (stop) b.setAttribute('aria-disabled', 'true');
          b.addEventListener('click', () => stepRow(r, delta));
          return b;
        };
        const c = D.createElement('span');
        c.className = 'of-c';
        c.textContent = String(r.q);
        q.append(btnQ('−', -1, 'dec'), c, btnQ('+', 1, 'inc'));
        d.append(q);
        if (r.maxed) add('of-note', msg('qty_max'));
      } else if (r.name) add('of-l-v', msg('unavailable'));
      li.append(th, d);
      const rm = D.createElement('button');
      rm.type = 'button';
      rm.className = 'of-b';
      rm.textContent = '×';
      rm.dataset.k = `rm:${r.v}`;
      rm.setAttribute('aria-label', msg('remove', { name: r.name || msg('unavailable') }));
      rm.addEventListener('click', () => removeRow(r));
      li.append(rm);
      list.append(li);
    }
    const anyNa = rows.some((r) => !r.ok);
    const note = $('rows-note');
    note.hidden = !anyNa;
    if (anyNa) text(note, msg('unavailable_note'));
    paintRows();
  }

  function paintRows() {
    for (const r of rows) if (r.ok && r.priceEl) text(r.priceEl.firstChild, money(r.price * r.q));
  }

  /** Quote answers (200 or 409) carry each line's current price and stock. */
  function syncRows(lines) {
    let drop = false;
    for (const l of lines || []) {
      const r = rows.find((x) => x.v === l.variantId);
      if (!r) continue;
      r.max = l.maxQty;
      if (l.maxQty > 0) {
        if (l.unitPriceDzd != null) r.price = l.unitPriceDzd;
      } else if (r.ok) {
        r.ok = false;
        drop = true;
      }
    }
    if (drop) drawRows();
  }

  /** After a stock answer: quantities follow the stock, and the cart keeps what was shown. */
  function settleRows() {
    let moved = false;
    for (const r of rows) {
      if (r.ok && r.q > r.max) {
        r.q = Math.max(1, r.max);
        r.maxed = true;
        moved = true;
      }
    }
    if (moved) {
      cart.store.write(cart.store.lines().map((l) => {
        const r = rows.find((x) => x.v === l.v);
        return r ? { ...l, q: r.q } : l;
      }));
    }
    drawRows();
    changed();
  }

  let focusKey = null;
  function stepRow(r, delta) {
    customerActed();
    if (delta > 0 && r.q >= r.max) {
      r.maxed = true;
      drawRows();
      refocus(`plus:${r.v}`);
      return;
    }
    if (delta < 0 && r.q <= 1) return;
    r.maxed = false;
    focusKey = `${delta > 0 ? 'plus' : 'minus'}:${r.v}`;
    cart.store.write(cart.setQty(cart.store.lines(), r.v, r.q + delta, r.max).lines);
  }
  function removeRow(r) {
    customerActed();
    focusKey = 'first';
    cart.store.write(cart.removeLine(cart.store.lines(), r.v));
  }
  function refocus(k) {
    const target = k === 'first' ? D.querySelector('#of-rows button') ?? name : D.querySelector(`[data-k="${k}"]`);
    target?.focus({ preventScroll: true });
  }

  /** (Re)builds `rows` from the cart and the static per-product JSON; quantity changes keep the lines' server data. */
  async function loadRows() {
    const lines = cart.store.lines();
    const data = await Promise.all(lines.map((l) => cart.product(l.p).catch(() => 'err')));
    const prev = new Map(rows.map((r) => [r.v, r]));
    rows = lines.map((l, i) => {
      const p = data[i];
      const v = p && p !== 'err' ? p.variants.find((x) => x.id === l.v) : undefined;
      const had = prev.get(l.v);
      const ok = !!v?.ok && v.max > 0 && !(had && !had.ok);
      const max = had ? Math.min(had.max, v?.max ?? had.max) : v?.max ?? 0;
      return {
        p: l.p,
        v: l.v,
        q: ok ? Math.min(l.q, max || l.q) : l.q,
        name: p && p !== 'err' ? p.name : '',
        label: p && p !== 'err' && p.variants.length > 1 ? v?.label ?? '' : '',
        price: had && ok ? had.price : v?.price ?? 0,
        max,
        ok,
        img: p && p !== 'err' ? p.img : null,
        err: p === 'err',
        maxed: had?.maxed ?? false,
        priceEl: null,
      };
    });
    const clamped = rows.filter((r, i) => r.ok && r.q !== lines[i].q);
    if (clamped.length) {
      clamped.forEach((r) => (r.maxed = true));
      cart.store.write(lines.map((l) => {
        const r = rows.find((x) => x.v === l.v);
        return r ? { ...l, q: r.q } : l;
      }));
      return;
    }
    const empty = !rows.length;
    $('empty').hidden = !empty;
    f.hidden = empty;
    if (empty) return;
    drawRows();
    changed();
    if (focusKey) {
      refocus(focusKey);
      focusKey = null;
    }
    if (wil.value && !com.value && !com.options[1] && !communes.has(wil.value)) loadCommunes();
  }

  if (cartMode) {
    import(ds.cart)
      .then((m) => {
        cart = m.api;
        cart.store.sub(() => loadRows());
        return loadRows();
      })
      .catch(() => showAlert(msg('quote_failed'), true));
  } else {
    clampQty();
    if (wil.value) loadCommunes().then(changed);
    else render();
  }
}
