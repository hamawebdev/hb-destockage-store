// The cart sheet (CART-0): a native <dialog>, created on first use, so first-paint HTML and CSS pay nothing for it.
// Text goes in with textContent only. The CSS below is applied as a constructable stylesheet, which the hash-based
// style-src leaves alone; it uses only tokens already on the page (hb-postbuild keeps the ones referenced here).
// Without the sheet (no JS, import failed) a customer still orders one product from its page.

const CSS = `
.cs{--cs-d:1;position:fixed;inset-block:0;inset-inline:auto 0;margin:0;inline-size:min(92vw,420px);max-inline-size:none;block-size:100dvh;max-block-size:none;border-radius:0;border-start-start-radius:var(--radius-xl);border-end-start-radius:var(--radius-xl);background:var(--color-surface);color:var(--color-text);box-shadow:var(--shadow-overlay);overflow:hidden;opacity:1;translate:calc(100% * var(--cs-d)) 0;transition:translate var(--dur-base) var(--ease-exit),display var(--dur-base) allow-discrete,overlay var(--dur-base) allow-discrete}
[dir=rtl] .cs{--cs-d:-1}
.cs[open]{translate:0 0;transition-timing-function:var(--ease-emphasized)}
@starting-style{.cs[open]{translate:calc(100% * var(--cs-d)) 0}}
.cs::backdrop{background:var(--color-scrim);opacity:0;transition:opacity var(--dur-base) var(--ease-standard),display var(--dur-base) allow-discrete,overlay var(--dur-base) allow-discrete}
.cs[open]::backdrop{opacity:1}
@starting-style{.cs[open]::backdrop{opacity:0}}
@media (hover:none){html:has(.cs[open]){overflow:hidden}}
.cs-p{display:flex;flex-direction:column;block-size:100%}
.cs-h{display:flex;align-items:center;gap:var(--space-2);padding:var(--space-2) var(--space-5);border-block-end:var(--bw-hairline) solid var(--color-border)}
.cs-t{margin:0;font-size:var(--fs-lead);font-weight:var(--fw-emphasis);line-height:var(--lh-ui)}
.cs-n{color:var(--color-text-secondary);font-size:var(--fs-small);margin-inline-end:auto}
.cs-x,.cs-rm{display:inline-grid;place-items:center;flex:none;inline-size:var(--tap-min);block-size:var(--tap-min);border-radius:var(--radius-round);color:var(--color-text-secondary);font-size:var(--fs-lead);line-height:1;transition:background-color var(--dur-fast) var(--ease-standard)}
.cs-x:hover,.cs-rm:hover,.cs-b:hover{background:var(--color-surface-alt)}
.cs-m{flex:1;overflow-y:auto;overscroll-behavior:contain;padding-inline:var(--space-5)}
.cs-e{display:grid;gap:var(--space-4);justify-items:start;padding-block:var(--space-8)}
.cs-e p{margin:0;color:var(--color-text-secondary)}
.cs-l{margin:0;padding:0;list-style:none}
.cs-i{display:grid;grid-template-columns:var(--space-16) minmax(0,1fr) auto;gap:var(--space-1) var(--space-3);padding-block:var(--space-4);border-block-end:var(--bw-hairline) solid var(--color-border)}
.cs-i:last-child{border-block-end:0}
.cs-th{display:block;inline-size:var(--space-16);block-size:var(--space-16);border-radius:var(--radius-md);background:var(--color-surface-alt);object-fit:contain}
.cs-d{display:grid;gap:var(--space-1);min-inline-size:0;align-content:start}
.cs-na{color:var(--color-text-secondary)}
.cs-nm{margin:0;line-height:var(--lh-ui);font-size:var(--fs-small);font-weight:var(--fw-emphasis)}
.cs-v,.cs-w{margin:0;color:var(--color-text-secondary);font-size:var(--fs-caption);line-height:var(--lh-ui)}
.cs-pr{margin:0;font-variant-numeric:tabular-nums;font-size:var(--fs-small)}
.cs-q{display:inline-flex;align-items:center;justify-self:start;margin-block-start:var(--space-1);border-radius:var(--radius-pill);box-shadow:inset 0 0 0 var(--bw-control) var(--color-border)}
.cs-b{display:inline-grid;place-items:center;inline-size:var(--tap-min);block-size:var(--tap-min);border-radius:var(--radius-round);font-size:var(--fs-lead);line-height:1;color:var(--color-text)}
.cs-b[aria-disabled=true]{color:var(--color-border-control);cursor:not-allowed}
.cs-b[aria-disabled=true]:hover{background:none}
.cs-c{min-inline-size:var(--space-8);text-align:center;font-variant-numeric:tabular-nums}
.cs-w{color:var(--color-warning);margin-block-start:var(--space-1)}
.cs-f{display:grid;gap:var(--space-2);padding:var(--space-4) var(--space-5) calc(var(--space-4) + env(safe-area-inset-bottom));border-block-start:var(--bw-hairline) solid var(--color-border)}
.cs-f p{margin:0}
.cs-to{display:flex;justify-content:space-between;align-items:baseline;gap:var(--space-3);font-weight:var(--fw-emphasis)}
.cs-to bdi{font-size:var(--fs-lead);font-variant-numeric:tabular-nums}
.cs-no{color:var(--color-text-secondary);font-size:var(--fs-caption);line-height:var(--lh-ui)}
.cs-go{display:flex;margin-block-start:var(--space-2)}
.cs-kp{min-block-size:var(--tap-min);color:var(--color-accent-text);text-align:center;border-radius:var(--radius-sm)}
.cs-kp:hover{text-decoration:underline}
.cs-sr{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.cs-ch{display:grid;gap:var(--space-5);padding-block:var(--space-5)}
.cs-hd{display:flex;gap:var(--space-3);align-items:center}
.cs-fs{margin:0;padding:0;border:0;min-inline-size:0;display:grid;gap:var(--space-2)}
.cs-lg{padding:0;font-size:var(--fs-small);font-weight:var(--fw-emphasis)}
.cs-vs{display:flex;flex-wrap:wrap;gap:var(--space-2)}
.cs-ov{position:relative;display:inline-flex}
.cs-ov input{position:absolute;inset:0;inline-size:100%;block-size:100%;margin:0;opacity:0;cursor:pointer}
.cs-ov span{display:inline-flex;align-items:center;justify-content:center;min-inline-size:var(--tap-min);min-block-size:var(--tap-min);padding-inline:var(--space-4);border-radius:var(--radius-md);box-shadow:inset 0 0 0 var(--bw-control) var(--color-border-control);font-size:var(--fs-small);pointer-events:none}
.cs-ov input:checked+span{box-shadow:inset 0 0 0 2px var(--color-accent)}
.cs-ov input:focus-visible+span{outline:var(--focus-width) solid var(--color-focus);outline-offset:var(--focus-offset)}
.cs-ov input:disabled+span{color:var(--color-text-secondary);text-decoration:line-through}
`;

const D = typeof document === 'object' ? document : null;
function adopt() {
  const s = new CSSStyleSheet();
  s.replaceSync(CSS);
  D.adoptedStyleSheets = [...D.adoptedStyleSheets, s];
}

const el = (tag, cls, text) => {
  const e = D.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const bdi = (text) => el('bdi', '', text);

/** Line price model: which stored lines can still be sold, from the per-product JSON. Pure, unit-tested. */
export function resolveLines(lines, products) {
  return lines.map((l, i) => {
    const p = products[i];
    if (p === 'err') return { l, state: 'error' };
    const variant = p?.variants?.find((x) => x.id === l.v);
    if (!p || !variant || !variant.ok || variant.max < 1) return { l, p, variant, state: 'unavailable' };
    return { l, p, variant, q: Math.min(l.q, variant.max), state: 'ok' };
  });
}

/** Sum of the lines that can still be ordered (products only; delivery is added at checkout). */
export const linesTotal = (resolved) => resolved.reduce((n, r) => (r.state === 'ok' ? n + r.variant.price * r.q : n), 0);

/** The variant matching a complete set of option values; undefined when incomplete or impossible. */
export const matchVariant = (variants, chosen) =>
  chosen.every(Boolean) ? variants.find((v) => v.ovs.length === chosen.length && chosen.every((c) => v.ovs.includes(c))) : undefined;

export function create(api) {
  adopt();
  const { store, money, lang } = api;
  let ui = null;
  const loadUi = () =>
    (ui ||= fetch(api.urls.ui)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .catch((err) => {
        ui = null;
        throw err;
      }));
  let S = {};
  const t = (k, v = {}) => (S[k] ?? '').replace(/\{(\w+)\}/g, (x, n) => (n in v ? v[n] : x));
  const plural = (base, n) => t(`${base}.${new Intl.PluralRules(lang === 'ar' ? 'ar-DZ' : 'fr-DZ').select(n)}`, { count: n });

  const dlg = el('dialog', 'cs');
  dlg.setAttribute('aria-labelledby', 'cs-t');
  const panel = el('div', 'cs-p');
  const head = el('div', 'cs-h');
  const title = el('h2', 'cs-t');
  title.id = 'cs-t';
  const countEl = el('span', 'cs-n');
  const close = el('button', 'cs-x', '×');
  close.type = 'button';
  close.addEventListener('click', () => dlg.close());
  head.append(title, countEl, close);
  const main = el('div', 'cs-m');
  const foot = el('div', 'cs-f');
  const live = el('p', 'cs-sr');
  live.setAttribute('aria-live', 'polite');
  panel.append(head, main, foot, live);
  dlg.append(panel);
  D.body.append(dlg);

  let opener = null;
  let view = 'cart';
  let seq = 0;
  let lastCount = null;
  let maxed = new Set(); // variant ids showing "maximum reached"
  let notice = ''; // one short message for the whole sheet (lines limit)

  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
  dlg.addEventListener('close', () => {
    notice = '';
    maxed = new Set();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  });
  store.sub(() => dlg.open && view === 'cart' && renderCart());

  const announceCount = (n) => {
    if (lastCount !== null && lastCount !== n) live.textContent = plural('cart.count', n);
    lastCount = n;
  };

  function show(by) {
    opener = by ?? opener;
    if (!dlg.open) dlg.showModal();
  }

  /** Waits for `p` up to 200 ms, so the sheet opens filled on a normal connection and at once on a slow one. */
  const brief = (p) => Promise.race([p, new Promise((ok) => setTimeout(ok, 200))]);

  const fetchAll = (lines) => Promise.all(lines.map((l) => api.product(l.p).catch(() => 'err')));

  function setQtyButton(btn, disabled) {
    if (disabled) btn.setAttribute('aria-disabled', 'true');
    else btn.removeAttribute('aria-disabled');
  }

  function lineEl(r) {
    const li = el('li', 'cs-i');
    const name = r.p?.name ?? '';
    const thumb = r.p?.img ? el('img', 'cs-th') : el('span', 'cs-th');
    if (r.p?.img) {
      thumb.srcset = r.p.img.srcset;
      thumb.src = r.p.img.src;
      thumb.sizes = '64px';
      thumb.alt = '';
      thumb.width = 64;
      thumb.height = 64;
      thumb.loading = 'lazy';
      thumb.decoding = 'async';
    }
    const body = el('div', 'cs-d');
    const rm = el('button', 'cs-rm', '×');
    rm.type = 'button';
    rm.setAttribute('aria-label', t('cart.remove', { name: name || t('cart.unavailable') }));
    rm.dataset.k = `rm:${r.l.v}`;
    rm.addEventListener('click', () => {
      keepFocus = 'close';
      store.write(api.removeLine(store.lines(), r.l.v));
    });
    const nm = el('p', 'cs-nm');
    nm.append(bdi(name || t(r.state === 'error' ? 'cart.loadFailed' : 'cart.unavailable')));
    body.append(nm);
    if (r.state === 'ok') {
      if (r.p.variants.length > 1 && r.variant.label) {
        const v = el('p', 'cs-v');
        v.append(bdi(r.variant.label));
        body.append(v);
      }
      const pr = el('p', 'cs-pr');
      pr.append(bdi(money(r.variant.price * r.q)));
      body.append(pr);
      const q = el('div', 'cs-q');
      const minus = el('button', 'cs-b', '−');
      const plus = el('button', 'cs-b', '+');
      const n = el('span', 'cs-c', String(r.q));
      for (const [b, d, label] of [[minus, -1, 'order.qty.decrease'], [plus, 1, 'order.qty.increase']]) {
        b.type = 'button';
        b.dataset.k = `${d > 0 ? 'plus' : 'minus'}:${r.l.v}`;
        b.setAttribute('aria-label', `${t(label)} · ${name}`);
        b.addEventListener('click', () => stepLine(r, d));
      }
      setQtyButton(minus, r.q <= 1);
      setQtyButton(plus, r.q >= r.variant.max);
      q.append(minus, n, plus);
      body.append(q);
      if (maxed.has(r.l.v)) body.append(el('p', 'cs-w', t('cart.qtyMax')));
    } else {
      li.classList.add('cs-na');
      if (r.state === 'unavailable' && name) body.append(el('p', 'cs-v', t('cart.unavailable')));
    }
    li.append(thumb, body, rm);
    return li;
  }

  function stepLine(r, d) {
    if (d > 0 && r.q >= r.variant.max) {
      maxed.add(r.l.v);
      renderCart(`plus:${r.l.v}`);
      return;
    }
    if (d < 0 && r.q <= 1) return;
    maxed.delete(r.l.v);
    keepFocus = `${d > 0 ? 'plus' : 'minus'}:${r.l.v}`;
    store.write(api.setQty(store.lines(), r.l.v, r.q + d, r.variant.max).lines);
  }

  let keepFocus = null;

  function restoreFocus(k) {
    const want = k ?? keepFocus;
    keepFocus = null;
    if (want) (want === 'close' ? close : dlg.querySelector(`[data-k="${want}"]`) ?? close).focus({ preventScroll: true });
  }

  function fillFoot(resolved) {
    foot.textContent = '';
    const ok = resolved.filter((r) => r.state === 'ok');
    foot.hidden = resolved.length === 0;
    if (!resolved.length) return;
    if (resolved.length > ok.length) foot.append(el('p', 'cs-no', t('cart.unavailableNote')));
    if (notice) foot.append(el('p', 'cs-w', notice));
    if (ok.length) {
      const to = el('p', 'cs-to');
      to.append(el('span', '', t('cart.total')), bdi(money(linesTotal(resolved))));
      foot.append(to, el('p', 'cs-no', t('cart.deliveryNext')));
      const go = el('a', 'btn btn-primary btn-block cs-go', t('product.orderCta'));
      go.href = api.urls.checkout;
      foot.append(go);
    }
    const keep = el('button', 'cs-kp', t('confirmation.continue'));
    keep.type = 'button';
    keep.addEventListener('click', () => dlg.close());
    foot.append(keep);
  }

  /** @param {string} [focusKey] control to keep focus on after the list is rebuilt */
  async function renderCart(focusKey) {
    view = 'cart';
    const my = ++seq;
    const lines = store.lines();
    S = await loadUi();
    const products = await fetchAll(lines);
    if (my !== seq) return;
    const resolved = resolveLines(lines, products);
    // Stock went down since it was added: follow it, once, and say so on that line.
    const clamped = resolved.filter((r) => r.state === 'ok' && r.l.q !== r.q);
    if (clamped.length) {
      clamped.forEach((r) => maxed.add(r.l.v));
      store.write(lines.map((x) => {
        const r = clamped.find((c) => c.l.v === x.v);
        return r ? { ...x, q: r.q } : x;
      }));
      return;
    }
    title.textContent = t('cart.title');
    const n = lines.reduce((a, l) => a + l.q, 0);
    countEl.textContent = n ? plural('cart.count', n) : '';
    close.setAttribute('aria-label', t('common.close'));
    announceCount(n);
    main.textContent = '';
    if (!lines.length) {
      const e = el('div', 'cs-e');
      const a = el('a', 'btn btn-secondary', t('home.heroCta'));
      a.href = api.urls.home;
      e.append(el('p', '', t('cart.empty')), a);
      main.append(e);
    } else {
      const ul = el('ul', 'cs-l');
      ul.setAttribute('role', 'list');
      ul.append(...resolved.map(lineEl));
      main.append(ul);
    }
    fillFoot(resolved);
    restoreFocus(focusKey);
  }

  function renderChoice(p, onDone) {
    view = 'choice';
    ++seq;
    title.textContent = t('cart.choose');
    countEl.textContent = '';
    close.setAttribute('aria-label', t('common.close'));
    main.textContent = '';
    foot.hidden = false;
    foot.textContent = '';
    const wrap = el('div', 'cs-ch');
    const hd = el('div', 'cs-hd');
    const thumb = p.img ? el('img', 'cs-th') : el('span', 'cs-th');
    if (p.img) {
      thumb.srcset = p.img.srcset;
      thumb.src = p.img.src;
      thumb.sizes = '64px';
      thumb.alt = '';
      thumb.width = 64;
      thumb.height = 64;
    }
    const txt = el('div', 'cs-d');
    const nm = el('p', 'cs-nm');
    nm.append(bdi(p.name));
    const price = el('p', 'cs-pr');
    txt.append(nm, price);
    hd.append(thumb, txt);
    wrap.append(hd);
    const chosen = p.options.map(() => 0);
    const add = el('button', 'btn btn-primary btn-block', t('cart.add'));
    add.type = 'button';
    add.disabled = true;
    const na = el('p', 'cs-w');
    na.hidden = true;
    const sync = () => {
      const v = matchVariant(p.variants, chosen);
      const ok = !!v?.ok;
      add.disabled = !ok;
      add.dataset.v = ok ? String(v.id) : '';
      price.textContent = '';
      const shown = ok ? v.price : v ? 0 : Math.min(...p.variants.filter((x) => x.ok).map((x) => x.price));
      if (shown) price.append(bdi(money(shown)));
      na.hidden = !(chosen.every(Boolean) && !ok);
      na.textContent = t('cart.unavailable');
    };
    p.options.forEach((o, i) => {
      const fs = el('fieldset', 'cs-fs');
      const lg = el('legend', 'cs-lg', o.name);
      const vs = el('div', 'cs-vs');
      for (const val of o.values) {
        const lb = el('label', 'cs-ov');
        const r = el('input');
        r.type = 'radio';
        r.name = `cs-${o.id}`;
        r.value = String(val.id);
        r.disabled = !p.variants.some((x) => x.ok && x.ovs.includes(val.id));
        r.addEventListener('change', () => {
          chosen[i] = val.id;
          sync();
        });
        lb.append(r, el('span', '', val.label));
        vs.append(lb);
      }
      fs.append(lg, vs);
      wrap.append(fs);
    });
    main.append(wrap);
    foot.append(na, add);
    sync();
    add.addEventListener('click', () => {
      const v = p.variants.find((x) => String(x.id) === add.dataset.v);
      if (v) onDone(v);
    });
  }

  /** Puts one unit of a known variant in the cart and shows the cart. */
  async function push(p, v, by) {
    const r = api.addLine(store.lines(), p.id, v.id, 1, v.max);
    if (r.status === 'lines_max') notice = t('cart.linesMax', { max: api.maxLines });
    if (r.status === 'qty_max') maxed.add(v.id);
    store.write(r.lines);
    await brief(renderCart());
    show(by);
    lastCount = store.lines().reduce((a, l) => a + l.q, 0);
    if (r.status === 'ok') live.textContent = `${t('cart.added')} ${plural('cart.count', lastCount)}`;
    close.focus({ preventScroll: true });
  }

  return {
    async openCart(by) {
      S = await loadUi();
      lastCount = store.lines().reduce((a, l) => a + l.q, 0);
      await brief(renderCart());
      show(by);
    },
    async add(productId, variantId, by) {
      S = await loadUi();
      lastCount = store.lines().reduce((a, l) => a + l.q, 0);
      let p;
      try {
        p = await api.product(productId);
      } catch {
        p = undefined;
      }
      if (!p) {
        // Network or no longer sold: show the cart as it is rather than doing nothing.
        notice = t('cart.loadFailed');
        await brief(renderCart());
        show(by);
        return;
      }
      const v = variantId ? p.variants.find((x) => x.id === variantId && x.ok) : p.variants.length === 1 && p.variants[0].ok ? p.variants[0] : null;
      if (v) return push(p, v, by);
      renderChoice(p, (picked) => push(p, picked, by));
      show(by);
      const first = dlg.querySelector('input:not(:disabled)');
      if (first) first.focus({ preventScroll: true });
    },
  };
}
