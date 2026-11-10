// Build inputs read from the environment. Pure functions so test/build-env.test.ts covers them.
// Owner: shell.

/**
 * HB_SNAPSHOT is required: an unset variable must fail the build, never fall back to the fixture
 * (lead ruling on CAT-2). `fixture` is for dev and tests only; the publish pipeline passes `seed` or
 * the export JSON path. Same rule and message as @hb/catalog/sources loadSnapshot. A partial
 * snapshot (HB_SNAPSHOT_PARTIAL=1) is refused unless HB_SNAPSHOT=fixture.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {string}
 */
export function requireSnapshot(env) {
  const v = env['HB_SNAPSHOT'];
  if (v === undefined || v.trim() === '') {
    throw new Error("HB_SNAPSHOT not set: use 'seed', a path to an export JSON, or 'fixture' (dev/tests only), e.g. HB_SNAPSHOT=fixture npm run build -w @hb/storefront");
  }
  if (env['HB_SNAPSHOT_PARTIAL'] === '1' && v !== 'fixture') {
    throw new Error('HB_SNAPSHOT_PARTIAL=1 is allowed only with HB_SNAPSHOT=fixture: a partial snapshot would ship without the 69 wilayas (lead ruling)');
  }
  return v;
}

/**
 * Year for the footer ©: from SOURCE_DATE_EPOCH (seconds, UTC) when set, so a rebuild of the same
 * snapshot is byte-identical; otherwise the build clock.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {Date} [now]
 * @returns {number}
 */
export function buildYear(env, now = new Date()) {
  const s = env['SOURCE_DATE_EPOCH'];
  if (s === undefined || s === '') return now.getUTCFullYear();
  if (!/^\d+$/.test(s)) throw new Error(`SOURCE_DATE_EPOCH must be integer seconds, got "${s}"`);
  return new Date(Number(s) * 1000).getUTCFullYear();
}

/** Origin used only for HB_SNAPSHOT=fixture builds (same as @hb/catalog FIXTURE_ORIGIN). */
export const FIXTURE_ORIGIN = 'https://comptoirdeluxe.example';

/**
 * The single site origin (canonical, hreflang, og:url, og:image, and pagedata's sitemap/robots):
 * HB_SITE_ORIGIN, normalised (trailing slashes dropped), https://host[:port] or http://localhost[:port].
 * Unset: FIXTURE_ORIGIN for HB_SNAPSHOT=fixture, otherwise the build fails (lead ruling on CAT-6).
 * Mirror of @hb/catalog/sources siteOriginFromEnv, which src/lib/site.mjs uses; kept for the unit
 * tests that pin the rule (test/build-env.test.ts) and must stay identical to it.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {string}
 */
export function siteOrigin(env) {
  const raw = env['HB_SITE_ORIGIN'];
  if (raw === undefined || raw.trim() === '') {
    if (env['HB_SNAPSHOT'] === 'fixture') return FIXTURE_ORIGIN;
    throw new Error('HB_SITE_ORIGIN not set: the production origin (e.g. https://example.dz) is required unless HB_SNAPSHOT=fixture');
  }
  const v = raw.trim().replace(/\/+$/, '');
  if (!/^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/localhost(:\d+)?)$/i.test(v)) {
    throw new Error(`HB_SITE_ORIGIN must be https://host[:port] or http://localhost[:port] with no path, got "${raw}"`);
  }
  return v;
}
