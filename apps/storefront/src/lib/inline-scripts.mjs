// The ONLY inline scripts on the storefront. Each body is byte-identical on every page, so apps/web's
// CSP needs one sha256 per script (hb-postbuild prints them at build time). Changing a body changes
// its hash: tell `web`. Owner: shell. Plan: artifacts/SHELL-0/plan.md §5 (speculation), §7 (RUM).

/**
 * LOADER + RUM, one script (one CSP hash).
 *
 * Loader: every element with data-js="/js/a.js /js/b.js?v=<hash>" (Base puts the page's `scripts` on
 * <body>; components may carry their own) gets its modules imported once, at the first of `load` +
 * idle, or the first focusin/pointerdown anywhere (so a customer who starts typing on a slow line is
 * not left with a plain form). Same-origin /js/ only. Nothing runs before LCP unless the visitor
 * interacts first.
 *
 * RUM (SHELL-5; payload agreed with web, apps/web/src/routes/rum.ts): after `load`, reads the
 * navigation timing entry and the last buffered largest-contentful-paint, and sends ONE beacon to
 * /api/rum (same origin, sendBeacon, text/plain JSON, about 250 B) on the first hide or pagehide:
 * {v:1, lang, tpl, path, navType, prerendered, ttfb, dns, connect, tls, proto, lcp, activationStart,
 * effectiveType}. Raw timings in ms, clamped to 0..60000, zero/absent values omitted; the Worker
 * subtracts activationStart for prerendered pages. path = location.pathname (no query, no
 * fragment). No identifiers, no cookies, no storage.
 */
export const LOADER = `(function(){var d=0;function g(){if(d)return;d=1;removeEventListener("focusin",g,!0);removeEventListener("pointerdown",g,!0);document.querySelectorAll("[data-js]").forEach(function(e){e.dataset.js.split(" ").forEach(function(u){if(/^\\/js\\/[\\w.-]+\\.js(\\?v=[\\w-]+)?$/.test(u))import(u)})})}addEventListener("focusin",g,!0);addEventListener("pointerdown",g,!0);addEventListener("load",function(){(window.requestIdleCallback||setTimeout)(g);setTimeout(function(){var n=performance.getEntriesByType("navigation")[0]||{},l=0,s=0;try{new PerformanceObserver(function(x){var e=x.getEntries();l=e[e.length-1].startTime}).observe({type:"largest-contentful-paint",buffered:!0})}catch(e){}function r(v){return v>0?Math.min(Math.round(v),6e4):void 0}function b(){if(s||!navigator.sendBeacon)return;s=1;var h=document.documentElement,c=navigator.connection;navigator.sendBeacon("/api/rum",JSON.stringify({v:1,lang:h.lang,tpl:h.dataset.tpl,path:location.pathname,navType:n.type,prerendered:n.activationStart>0,ttfb:r(n.responseStart),dns:r(n.domainLookupEnd-n.domainLookupStart),connect:r(n.connectEnd-n.connectStart),tls:n.secureConnectionStart>0?r(n.connectEnd-n.secureConnectionStart):void 0,proto:n.nextHopProtocol||void 0,lcp:r(l),activationStart:r(n.activationStart),effectiveType:c&&c.effectiveType}))}addEventListener("visibilitychange",function(){document.visibilityState=="hidden"&&b()});addEventListener("pagehide",b)},0)})})()`;

/**
 * Speculation Rules (inline <script type="speculationrules">, plan §5): prefetch same-origin links at
 * moderate eagerness (hover/pointerdown), except the API, the order steps (POST-driven, Worker-filled;
 * orderform) and anything marked data-no-prefetch; prerender product pages at moderate (category/home/
 * search → product: where it pays, Ray-Ban PDP case, STACK-REPORT §2). Nothing eager: Algerian
 * mobile data. Cross-origin links (wa.me, tel:) never match "/*".
 */
export const SPECULATION_RULES = JSON.stringify({
  prefetch: [
    {
      where: {
        and: [
          { href_matches: '/*' },
          { not: { href_matches: '/api/*' } },
          { not: { href_matches: '/*/order/*' } },
          { not: { selector_matches: '[data-no-prefetch]' } },
        ],
      },
      eagerness: 'moderate',
    },
  ],
  prerender: [
    {
      where: { and: [{ href_matches: '/*/p/*' }, { not: { selector_matches: '[data-no-prefetch]' } }] },
      eagerness: 'moderate',
    },
  ],
});

/** Every inline script body the build allows (hb-postbuild fails on any other). */
export const ALLOWED_INLINE_SCRIPTS = [LOADER, SPECULATION_RULES];
