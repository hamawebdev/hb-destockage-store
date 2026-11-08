// Absolute origin for canonical/hreflang/og/sitemap. No trailing slash.
// [PLACEHOLDER] default until the client confirms the production domain; set HB_SITE_ORIGIN in the publish build.
export const SITE_ORIGIN = (process.env.HB_SITE_ORIGIN ?? 'https://hbdestockagedz.com').replace(/\/+$/, '');
