// Storefront build config. Owner: shell. Plan: /artifacts/SHELL-0/plan.md (§2 CSS, §3 URLs).
import { defineConfig } from 'astro/config';
import hbPostbuild from './integrations/hb-postbuild.mjs';
import { ALLOWED_INLINE_SCRIPTS } from './src/lib/inline-scripts.mjs';
import { SITE_ORIGIN } from './src/lib/site.mjs';
import { allRoutes } from './src/lib/catalog.ts';

// Lightning CSS targets: the Algerian baseline (research_i18n_ui row 8, ~98% of DZ traffic).
// Old targets would lower logical properties to physical ones + :dir() fallbacks.
const v = (major, minor = 0) => (major << 16) | (minor << 8);
const cssTargets = { chrome: v(111), edge: v(111), safari: v(16, 4), ios_saf: v(16, 4), firefox: v(115), samsung: v(22) };

export default defineConfig({
  site: SITE_ORIGIN,
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory', inlineStylesheets: 'always' },
  compressHTML: true,
  prefetch: false,
  devToolbar: { enabled: false },
  scopedStyleStrategy: 'where',
  server: { port: 4150, host: '127.0.0.1' },
  vite: {
    css: { lightningcss: { targets: cssTargets } },
    build: { cssMinify: 'lightningcss', cssTarget: ['chrome111', 'edge111', 'safari16.4', 'firefox115'], assetsInlineLimit: 0 },
  },
  integrations: [
    hbPostbuild({
      allowedInlineScripts: ALLOWED_INLINE_SCRIPTS,
      routes: allRoutes,
      // orderform's Worker-filled review template (not in the route map).
      extraGroups: [{ pattern: /^\/(ar|fr)\/order\/review\/index\.html$/, template: 'order-review' }],
    }),
  ],
});
