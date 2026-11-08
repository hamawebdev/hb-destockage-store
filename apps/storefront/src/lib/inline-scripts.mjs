// The ONLY inline executable scripts on the storefront. Each body is byte-identical on every page,
// so apps/web's CSP needs one sha256 per script (printed by hb-postbuild at build time).
// Changing a body changes its hash: tell `web`. Owner: shell. Plan: artifacts/SHELL-0/plan.md §5, §7.

/**
 * Post-LCP module loader. Every element with data-js="/js/a.js /js/b.js?v=<hash>" (Base puts the
 * page's `scripts` on <body>; components such as the order form put their own) gets its modules
 * imported once, at the first of: `load` + idle, or the first focusin/pointerdown anywhere (so a
 * customer who starts typing on a slow line is not left with a plain form). Same-origin /js/ only.
 * Nothing runs before LCP unless the visitor interacts first.
 */
export const LOADER = `(function(){var d=0;function g(){if(d)return;d=1;removeEventListener("focusin",g,!0);removeEventListener("pointerdown",g,!0);document.querySelectorAll("[data-js]").forEach(function(e){e.dataset.js.split(" ").forEach(function(u){if(/^\\/js\\/[\\w.-]+\\.js(\\?v=[\\w-]+)?$/.test(u))import(u)})})}addEventListener("focusin",g,!0);addEventListener("pointerdown",g,!0);addEventListener("load",function(){(window.requestIdleCallback||setTimeout)(g)})})()`;

/** Every inline script body the build allows (hb-postbuild fails on any other). */
export const ALLOWED_INLINE_SCRIPTS = [LOADER];
