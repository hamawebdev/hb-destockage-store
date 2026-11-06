// Product page enhancement (pages). Loaded after LCP by shell's loader; plain JS, no imports.
// 1. Variant picker: resolve the chosen combination to a variant (`.cat-vps > [data-k]`),
//    switch every price/stock block and "selected value" label, mark values that cannot be
//    combined with the other options (multi), fill the hidden variantId (multi) and tell the
//    order form: `hb:variant` {variantId, priceDzd, maxQty, available} on #order-form, at init
//    and on every change (contract with orderform).
// 2. Gallery: thumbnails scroll the track only (not the page), aria-current follows the slide,
//    and a variant with its own photo brings it into view.
const pdp = document.querySelector('.cat-pdp');
const picker = pdp && pdp.querySelector('.cat-picker');
const track = pdp && pdp.querySelector('.cat-gal-track');
const thumbs = pdp ? [...pdp.querySelectorAll('.cat-gal-thumbs a')] : [];

const show = (i, smooth) => {
  const slide = track && track.children[i];
  if (!slide) return;
  track.scrollTo({ left: slide.offsetLeft - track.children[0].offsetLeft, behavior: smooth ? 'smooth' : 'instant' });
  thumbs.forEach((a, j) => (j === i ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
};

if (track) {
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

if (picker) {
  const multi = picker.dataset.mode === 'multi';
  const sets = [...picker.querySelectorAll('fieldset')];
  const blocks = [...pdp.querySelectorAll('.cat-pdp-buy .cat-vps > [data-k]')];
  const form = document.getElementById('order-form');
  const hidden = multi ? picker.querySelector('input[name="variantId"]') : null;
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
        // Not colour (or the strike) alone: the radio's name says it too, for screen readers.
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
    if (block && block.dataset.img && !init) show(Number(block.dataset.img), true);
    if (form) {
      form.dispatchEvent(
        new CustomEvent('hb:variant', {
          detail: {
            variantId: block ? Number(block.dataset.v) : null,
            priceDzd: block ? Number(block.dataset.p) : null,
            maxQty: block ? Number(block.dataset.max) : 0,
            available: !!block && block.dataset.a === '1',
          },
        }),
      );
    }
  };

  picker.addEventListener('change', () => update(false));
  update(true);
}
