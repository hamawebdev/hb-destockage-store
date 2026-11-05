// Lazy Turnstile for the order form (ORDER-3). First-party file (measure's rule: no third-party URL in the HTML
// or inline scripts). order.js imports it on the form's first focusin/pointerdown, never on load, idle or scroll.
// Invisible/interaction-only widget, explicit render. A missing token never blocks the order: the server
// accepts and flags it (CLAUDE.md). CSP on product pages: script-src + frame-src https://challenges.cloudflare.com.
// Docs: developers.cloudflare.com/turnstile/get-started/client-side-rendering/ (+ widget-configurations).

const API = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let state = 'idle'; // idle | loading | ready | failed
let tok = '';
let widget = null;
let waiters = [];

const settle = (t) => {
  tok = t;
  for (const w of waiters.splice(0)) w(t);
};
const fail = () => {
  state = 'failed';
  settle('');
};

/** Injects api.js once and renders the widget into `slot`. Gives up after 10 s (order goes without a token). */
export function load(slot, sitekey, lang) {
  if (state !== 'idle') return;
  state = 'loading';
  const s = document.createElement('script');
  const timer = setTimeout(fail, 10000);
  s.src = API;
  s.async = true;
  s.onerror = () => {
    clearTimeout(timer);
    fail();
  };
  s.onload = () => {
    clearTimeout(timer);
    try {
      widget = window.turnstile.render(slot, {
        sitekey,
        action: 'order',
        appearance: 'interaction-only',
        language: lang,
        'response-field': false,
        'refresh-expired': 'auto',
        callback: (t) => {
          state = 'ready';
          settle(t);
        },
        'error-callback': () => settle(''),
        'expired-callback': () => (tok = ''),
        'timeout-callback': () => (tok = ''),
      });
    } catch {
      fail();
    }
  };
  document.head.append(s);
}

/** Current token, waiting at most `ms` for one that is still being produced. Resolves '' when there is none. */
export function token(ms) {
  if (tok || state === 'idle' || state === 'failed') return Promise.resolve(tok);
  return new Promise((ok) => {
    waiters.push(ok);
    setTimeout(() => ok(tok), ms);
  });
}

/** Tokens are single-use: after the server has seen one (any answer), ask the widget for a fresh one. */
export function reset() {
  tok = '';
  if (widget != null && window.turnstile) {
    try {
      window.turnstile.reset(widget);
    } catch {}
  }
}
