// The single absolute origin (no trailing slash) for canonical/hreflang/og and pagedata's sitemap.
// HB_SITE_ORIGIN; unset is allowed only with HB_SNAPSHOT=fixture (src/lib/build-env.mjs siteOrigin).
import { siteOrigin } from './build-env.mjs';

export const SITE_ORIGIN = siteOrigin(process.env);
