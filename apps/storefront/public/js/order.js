// HB Destockage order form enhancement (ORDER-2). Plain ES module, no dependencies, loaded after LCP by
// shell's [data-js] loader. Plan: artifacts/ORDER-0/plan.md §4 + the lead's rulings. Contracts: WEB-0 §2.1–2.2.
// Rules: the total is always shown before an order is created; one idempotency key per page view, kept
// across retries; DOM writes use textContent/Option only. Pure helpers are exported for the parity tests.

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
  const M = new Map([...$('msgs').content.querySelectorAll('[data-k]')].map((p) => [p.dataset.k, p.textContent]));
  const msg = (k, v = {}) => (M.get(k) ?? M.get('server_error')).replace(/\{(\w+)\}/g, (x, n) => (n in v ? v[n] : x));
  const money = (n) => fmt(n, lang);
  const variants = parseVariants(ds.variants);
  const el = f.elements;
  const [name, phone, wil, com, qty, btn, sum, sumH, status, alertEl, help] =
    ['name', 'phone', 'wilaya', 'commune', 'qty', 'submit', 'sum', 'sum-h', 'status', 'alert', 'help'].map($);
  const feeLabel = $('s-fee-l').textContent;
  const formMax = Number(qty.max) || 10;
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

  const readVariant = () => variants.get(Number(el.namedItem('variantId')?.value)) ?? null;
  let variant = readVariant();
  const n = () => Math.trunc(Number(toAscii(qty.value))) || 0;
  const inputs = () => `${variant?.id}|${n()}|${wil.value}|${com.value}`;
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
  const setErr = (input, code, v) => {
    const slot = D.getElementById(input.id + '-err');
    text(slot, code ? msg(code, v) : '');
    code ? input.setAttribute('aria-invalid', 'true') : input.removeAttribute('aria-invalid');
  };
  const clearErrors = () => {
    for (const i of [name, phone, wil, com, qty]) setErr(i, null);
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
    const max = Math.max(1, Math.min(formMax, variant?.max || formMax));
    qty.max = String(max);
    const v = n();
    if (qty.value !== '' && (v < 1 || v > max)) qty.value = String(Math.min(max, Math.max(1, v)));
  };
  f.addEventListener('click', (e) => {
    const b = e.target.closest?.('.of-step');
    if (b) {
      qty.value = String((n() || 1) + Number(b.dataset.d));
      changed();
    }
  });
  qty.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(changed, 300);
  });

  // --- variant (pages' contract: hb:variant on the form; inputs outside <form> carry form="order-form") ----
  f.addEventListener('hb:variant', (e) => {
    const x = e.detail;
    variant = x?.variantId ? { id: x.variantId, price: x.priceDzd, max: x.maxQty, ok: !!x.available } : null;
    changed();
  });
  D.addEventListener('change', (e) => {
    const t = e.target;
    if (t.form !== f) return;
    if (t === wil) loadCommunes();
    if (t.name === 'variantId') variant = readVariant();
    if (t === wil || t === com || t === qty || t.name === 'variantId') changed();
  });

  // --- communes (per-wilaya JSON, page language, already collated) --------------------------------------
  async function loadCommunes() {
    const code = wil.value;
    com.disabled = true;
    com.length = 0;
    com.add(new Option(msg(code ? 'loading' : 'commune_waiting'), ''));
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
      com.options[0].text = msg('commune_waiting');
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
    const line = q?.lines?.[0];
    const unit = line ? line.unitPriceDzd : variant?.price;
    text($('s-unit'), unit == null ? '—' : money(unit));
    text($('s-qty'), String(n() || 1));
    text($('s-sub'), q ? money(q.subtotalDzd) : unit == null ? '—' : money(unit * (n() || 1)));
    const avail = q?.available;
    const wName = wil.selectedOptions[0]?.text.replace(/^\d+\s*-\s*/, '');
    text($('s-fee-l'), avail ? msg('delivery_to', { wilaya: wName }) : feeLabel);
    const waiting = !q && !blocked && variant?.ok && sum.getAttribute('aria-busy');
    text($('s-fee'), avail ? money(q.feeDzd) : !wil.value ? msg('delivery_pending') : waiting ? msg('calculating') : '—');
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
    if (!variant?.ok || !wil.value || n() < 1) {
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
      const body = { items: [{ variantId: variant.id, qty: n() }], wilayaCode: Number(wil.value) };
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
    const line = d.lines?.[0];
    if (line && variant && line.variantId === variant.id) {
      variant.max = line.maxQty;
      variant.ok = line.maxQty > 0;
      if (line.unitPriceDzd != null) variant.price = line.unitPriceDzd;
    }
    if (d.ok && d.status === 200) {
      quote = { ...d, k };
      setBlocked(!d.available);
      showAlert(d.available ? '' : msg('delivery_unavailable'), !d.available);
      render();
      if (d.available) say(msg('updated', { total: money(d.totalDzd) }));
      return quote;
    }
    quote = null;
    render();
    if (d.status === 422 && d.errors) fieldErrors(d.errors);
    else if (d.code === 'out_of_stock' || d.code === 'variant_unavailable') {
      clampQty();
      setErr(qty, d.code);
    } else {
      setBlocked(true);
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
    const max = Number(qty.max);
    const list = [
      [name, !nm ? 'name_required' : nm.length < 2 || nm.length > 80 || !/\p{L}/u.test(nm) ? 'name_invalid' : 0],
      [phone, phoneError(phone.value, ds.phoneRe)],
      [wil, wil.value ? 0 : 'wilaya_required'],
      [com, !wil.value || com.value ? 0 : 'commune_required'],
      [qty, q >= 1 && q <= max && String(q) === toAscii(qty.value).trim() ? 0 : 'qty_invalid'],
    ];
    const bad = list.filter((x) => x[1]);
    for (const [i, c] of list) setErr(i, c || null, { max });
    return bad;
  }

  // --- submit ------------------------------------------------------------------------------------------
  f.addEventListener('submit', async (e) => {
    if (communeFail && wil.value) {
      // JS could not load the communes: let the browser post the no-JS form (server review step shows the total).
      el.idempotencyKey.value = '';
      return;
    }
    e.preventDefault();
    if (busy) return;
    showAlert('');
    const bad = check();
    if (bad.length) {
      showAlert(countMsg(bad.length));
      bad[0][0].focus();
      return;
    }
    if (!variant?.ok) {
      showAlert(msg(variant ? 'variant_unavailable' : 'variant_required'));
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
    const body = {
      idempotencyKey: key,
      lang,
      items: [{ variantId: variant.id, qty: n() }],
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
      location.assign(d.confirmationUrl || `${ds.confirm}?ref=${encodeURIComponent(d.ref)}`);
      return;
    }
    busy = false;
    btn.removeAttribute('aria-disabled');
    text(btn, msg('submit'));
    say('');
    const c = d.code;
    // 409 answers carry a fresh quote (WEB-0 §2.2): show it; the next press confirms against it.
    if (d.quote) apply(inputs(), { ...d.quote, ok: true, status: 200 });
    if (c === 'total_changed') {
      showAlert(msg('total_changed'));
      sumH.focus();
    } else if (c === 'validation') {
      showAlert(countMsg(d.errors?.length || 1));
      fieldErrors(d.errors);
    } else if (c === 'out_of_stock' || c === 'variant_unavailable') {
      changed(); // clamps qty to the fresh maxQty and re-quotes
      setErr(qty, c);
      qty.focus();
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
    key = uuid();
    busy = false;
    btn.removeAttribute('aria-disabled');
    text(btn, msg('submit'));
    say('');
  });

  clampQty();
  if (wil.value) loadCommunes().then(changed);
  else render();
}
