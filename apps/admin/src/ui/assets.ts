// Same-origin static assets. `tokens.css` is served by the Worker from `@hb/ui-tokens`; the rest
// from `apps/admin/public/assets/` through the ASSETS binding (after auth).
export const ASSET = {
  tokens: '/assets/tokens.css',
  css: '/assets/admin.css',
  print: '/assets/print.css',
  js: '/assets/admin.js',
} as const;
