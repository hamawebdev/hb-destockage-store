// The single absolute origin (no trailing slash) for canonical/hreflang/og and pagedata's
// sitemap/robots: @hb/catalog's siteOriginFromEnv (HB_SITE_ORIGIN; unset only with
// HB_SNAPSHOT=fixture → https://comptoirdeluxe.example). One implementation for both layers.
import { siteOriginFromEnv } from '@hb/catalog/sources';

export const SITE_ORIGIN = siteOriginFromEnv(process.env);
