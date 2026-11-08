// Product page enhancement (pages). Plain JS after load via shell's loader; contract and comments:
// lib/variants.ts (picker, hb:variant), Gallery.astro and DeferredImg.astro (images deferred past LCP).
const pdp = document.querySelector('.cat-pdp');
const picker = pdp && pdp.querySelector('.cat-picker');
const track = pdp && pdp.querySelector('.cat-gal-track');
const thumbs = pdp ? [...pdp.querySelectorAll('.cat-gal-thumbs a')] : [];

const later = track ? [...track.querySelectorAll('img[data-srcset]')] : [];
const promote = (img) => {
  if (!img.dataset.srcset) return;
  img.srcset = img.dataset.srcset;
  img.src = img.dataset.src;
  delete img.dataset.srcset;
  img.hidden = false;
};
const wake = (all) => (all ? later : later.slice(0, 1)).forEach(promote);
const show = (i, smooth) => {
  wake(true);
  const slide = track && track.children[i];
  if (!slide) return;
  track.scrollTo({ left: slide.offsetLeft - track.children[0].offsetLeft, behavior: smooth ? 'smooth' : 'instant' });
  thumbs.forEach((a, j) => (j === i ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
};

(window.requestIdleCallback || setTimeout)(() => {
  for (const img of document.querySelectorAll('img[data-srcset]')) if (!track || !track.contains(img)) promote(img);
  wake(false);
});
if (track) {
  for (const ev of ['pointerdown', 'scroll', 'focusin']) track.addEventListener(ev, () => wake(true), { once: true, passive: true });
  thumbs.forEach((a, i) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      show(i, true);
    }),
  );
  track.addEventListener('scrollend', () => {
    const i = Math.round(Math.abs(track.scrollLeft) / track.clientWidth);
    thumbs.forEach((a, j) => (j === i ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
  });
  if (thumbs[0]) thumbs[0].setAttribute('aria-current', 'true');
}

const ctas = [...document.querySelectorAll('[data-cta]')];
document.querySelectorAll('[data-cta-btn]').forEach((b) => (b.hidden = true));
ctas.forEach((a) => (a.hidden = false));

if (picker) {
  const multi = picker.dataset.mode === 'multi';
  const sets = [...picker.querySelectorAll('fieldset')];
  const blocks = [...pdp.querySelectorAll('.cat-pdp-buy .cat-vps > [data-k]')];
  const form = document.getElementById('order-form');
  const hidden = multi ? picker.querySelector('input[type=hidden]') : null;
  const keyOf = (ids) => ids.map(Number).sort((a, b) => a - b).join('-');
  const find = (key) => blocks.find((b) => b.dataset.k === key);
  const chosen = () => sets.map((f) => (f.querySelector('input:checked') || {}).dataset?.ov);

  const update = (init) => {
    const ids = chosen();
    const complete = ids.every(Boolean);
    const block = complete ? find(keyOf(ids)) : undefined;
    const key = block ? block.dataset.k : null;

    for (const box of pdp.querySelectorAll('.cat-vps')) {
      box.classList.add('is-js');
      for (const el of box.children) el.classList.toggle('is-on', key ? el.dataset.k === key : el.classList.contains('cat-vp-none'));
    }
    sets.forEach((f, fi) => {
      const radios = [...f.querySelectorAll('input')];
      const curs = f.querySelector('.cat-curs');
      curs.classList.add('is-js');
      [...curs.children].forEach((c, i) => c.classList.toggle('is-on', radios[i] && radios[i].checked));
      if (!multi) return;
      for (const r of radios) {
        const alt = ids.slice();
        alt[fi] = r.dataset.ov;
        const b = alt.every(Boolean) && find(keyOf(alt));
        const na = !(b && b.dataset.a === '1');
        const label = r.parentElement;
        label.toggleAttribute('data-na', na);
        let note = label.querySelector('.cat-na-t');
        if (na && !note && !r.disabled) {
          note = document.createElement('span');
          note.className = 'cat-sr cat-na-t';
          note.textContent = ' (' + picker.dataset.naLabel + ')';
          label.lastElementChild.append(note);
        } else if (!na && note) note.remove();
      }
    });

    if (hidden) hidden.value = block ? block.dataset.v : '';
    const ok = !!block && block.dataset.a === '1';
    for (const a of ctas) {
      a.href = a.dataset.cta + (ok ? '?v=' + block.dataset.v : '');
      a.setAttribute('aria-disabled', !ok);
    }
    if (block && block.dataset.img && !init) show(Number(block.dataset.img), true);
    if (form) {
      form.dispatchEvent(
        new CustomEvent('hb:variant', {
          detail: {
            variantId: block ? Number(block.dataset.v) : null,
            priceDzd: block ? Number(block.dataset.p) : null,
            maxQty: block ? Number(block.dataset.max) : 0,
            available: ok,
          },
        }),
      );
    }
  };

  // Order step: preselect from ?v= (or opt.* without JS on the product page), also when a prerender is shown.
  const fromQuery = () => {
    const q = new URLSearchParams(location.search);
    const b = blocks.find((x) => x.dataset.v === q.get('v'));
    const ids = b ? b.dataset.k.split('-') : [...q].filter(([k]) => k.startsWith('opt.')).map(([, v]) => v);
    const hit = find(keyOf(ids));
    if (!hit || hit.dataset.a !== '1') return;
    for (const id of hit.dataset.k.split('-')) document.getElementById('ov-' + id).checked = true;
  };
  picker.addEventListener('change', () => update(false));
  document.addEventListener('prerenderingchange', () => (fromQuery(), update(true)));
  fromQuery();
  update(true);
}
