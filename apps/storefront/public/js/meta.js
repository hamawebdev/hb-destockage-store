// Meta consent stub (D-011, Addendum 7): all a visitor without a stored `granted` loads before any input. It reads the
// stored choice and loads meta-full.js (the bar, the Pixel and its events) only when that is needed. Nothing here talks
// to Meta. meta-full.js is reachable by name so the build's budget counts it. Plain ES module, loaded after LCP.
const D = document;
const B = D.body;
const id = B.dataset.metaPixel;

function run() {
  const consentOff = B.dataset.metaConsent === 'off';
  let choice = null;
  try {
    choice = localStorage.getItem('hb.meta.consent.v1');
  } catch {}
  const full = () => import('./meta-full.js' + new URL(import.meta.url).search);
  const load = (mode) => full().then((m) => m.boot(id, mode));

  const reset = D.querySelector('[data-meta-reset]');
  if (reset) {
    reset.hidden = false;
    reset.addEventListener('click', () => full().then((m) => m.reset()));
  }

  if (choice === 'granted' || (consentOff && choice !== 'denied')) load('start');
  else {
    try {
      sessionStorage.removeItem('hb.meta.purchase');
    } catch {}
    // No choice yet: the bar's code loads after the first input, and 400 ms later so a tap cannot land on the bar.
    if (choice !== 'denied' && !/^(order-step|checkout)$/.test(D.documentElement.dataset.tpl)) {
      const events = ['scroll', 'keydown', 'pointerdown'];
      const go = () => {
        events.forEach((e) => removeEventListener(e, go, true));
        setTimeout(() => load('choice'), 400);
      };
      events.forEach((e) => addEventListener(e, go, { capture: true, passive: true }));
    }
  }
}

// A prerendered page reads the choice only once it is shown: it may be made in another tab meanwhile.
if (id) {
  if (D.prerendering) D.addEventListener('prerenderingchange', run, { once: true });
  else run();
}
