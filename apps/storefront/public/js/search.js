// Search page (pages, PAGES-3). Loaded after LCP by shell's loader; plain JS, no imports.
// The per-language index (`SearchIndex`, CAT-5) is fetched on the first focus/typing, or at once
// when the URL already carries ?q=. The query is folded with geo's normalizeForSearch (ported
// line for line below; parity test: src/components/catalog/test/search.test.ts) and every word
// must occur in an entry's key `k` (searchKey output: name, brand, category, option values).
// Results are rendered with DOM APIs (no innerHTML) and announced through the role=status line.
const root = typeof document === 'undefined' ? null : document.querySelector('.cat-search');

// --- geo GEO-5 data/geo/search.mjs normalizeForSearch, verbatim -------------------------------
export function normalizeForSearch(s) {
  return String(s ?? '')
    .normalize('NFD')
    .toLowerCase()
    .replace(/[̀-ͯـً-ٰٟ]/g, '')
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/ß/g, 'ss')
    .replace(/[ڧڨ]/g, 'ق')
    .replace(/ڢ/g, 'ف')
    .replace(/ک/g, 'ك')
    .replace(/[ىی]/g, 'ي')
    .replace(/ٱ/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) & 15))
    .replace(/['`’ʼ]/g, '')
    .replace(/[^a-z0-9ء-ي]+/g, ' ')
    .trim();
}

/** Entries whose key contains every word of the folded query; names that start with it first. */
export function match(entries, query, limit = 48) {
  const q = normalizeForSearch(query);
  if (!q) return [];
  const words = q.split(' ');
  const hits = entries.filter((e) => words.every((w) => e.k.includes(w)));
  const head = (e) => (normalizeForSearch(e.n).startsWith(q) ? 0 : 1);
  return hits.map((e, i) => [head(e), i, e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, limit).map((x) => x[2]);
}

if (root) {
  const d = root.dataset;
  const S = JSON.parse(d.i18n || '{}');
  const lang = d.lang === 'ar' ? 'ar' : 'fr';
  const min = Number(d.min) || 2;
  const input = root.querySelector('#cat-q');
  const status = root.querySelector('#cat-sstatus');
  const list = root.querySelector('#cat-sresults');
  const money = new Intl.NumberFormat(lang + '-DZ', { style: 'currency', currency: 'DZD', maximumFractionDigits: 0 });
  const plural = new Intl.PluralRules(lang + '-DZ');
  // Bidi isolate (FSI…PDI) so a Latin query inside Arabic text keeps its order.
  const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
  const iso = (s) => '⁨' + s + '⁩';
  let index;
  let timer;
  let seq = 0;

  const load = () =>
    (index ??= fetch(d.index, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => j.entries)
      .catch((e) => {
        index = undefined;
        throw e;
      }));

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const item = (e) => {
    const li = el('li');
    const a = el('a', 'cat-res');
    a.href = e.u;
    if (e.t) {
      const img = el('img', 'cat-res-img');
      Object.assign(img, { src: e.t, alt: '', width: 64, height: 64, loading: 'lazy', decoding: 'async' });
      a.append(img);
    } else a.append(el('span', 'cat-res-img'));
    const text = el('span', 'cat-res-text');
    text.append(el('span', 'cat-res-name', e.n));
    const meta = el('span', 'cat-res-meta');
    if (e.b) {
      const b = el('bdi', null, e.b);
      b.dir = 'ltr';
      if (lang === 'ar') b.lang = 'fr';
      meta.append(b, ' · ');
    }
    const price = money.format(e.p);
    meta.append(el('span', 'cat-res-price', e.f ? fill(S['price.from'], { price }) : price));
    meta.append(' · ' + e.c);
    if (e.s === 2) meta.append(' · ', el('span', 'cat-res-out', S['stock.out']));
    if (e.x && S['dev.placeholder']) meta.append(' ' + S['dev.placeholder']);
    text.append(meta);
    a.append(text);
    li.append(a);
    return li;
  };

  const show = (items) => {
    list.replaceChildren(...items.map(item));
    list.hidden = items.length === 0;
  };

  const run = async () => {
    const raw = input.value.trim();
    const n = ++seq;
    root.classList.toggle('is-active', raw !== '');
    if (!raw) {
      show([]);
      status.textContent = '';
      return;
    }
    if (normalizeForSearch(raw).length < min) {
      show([]);
      status.textContent = S['search.short'];
      return;
    }
    let entries;
    try {
      status.textContent = S['search.loading'];
      entries = await load();
    } catch {
      if (n === seq) status.textContent = S['search.error'];
      return;
    }
    if (n !== seq) return;
    const hits = match(entries, raw);
    show(hits);
    status.textContent = hits.length
      ? fill(S['search.results.' + plural.select(hits.length)] || S['search.results.other'], { count: hits.length, q: iso(raw) })
      : fill(S['search.none'], { q: iso(raw) }) + ' ' + S['search.noneHint'];
  };

  const sync = () => {
    const u = new URL(location.href);
    if (input.value.trim()) u.searchParams.set(d.q, input.value.trim());
    else u.searchParams.delete(d.q);
    history.replaceState(null, '', u);
  };

  input.addEventListener('focus', () => load().catch(() => {}), { once: true });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      run();
      sync();
    }, 150);
  });
  root.querySelector('form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    clearTimeout(timer);
    run();
    sync();
  });

  const q = new URLSearchParams(location.search).get(d.q);
  if (q) {
    input.value = q;
    run();
  }
}
