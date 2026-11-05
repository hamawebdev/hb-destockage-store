// Build inputs read from the environment. Pure functions so test/build-env.test.ts covers them.
// Owner: shell.

/**
 * HB_SNAPSHOT is required: an unset variable must fail the build, never fall back to the fixture
 * (lead ruling on CAT-2). `fixture` is for dev and tests only; the publish pipeline passes `seed` or
 * the export JSON path. Same rule and message as @hb/catalog/sources loadSnapshot.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {string}
 */
export function requireSnapshot(env) {
  const v = env['HB_SNAPSHOT'];
  if (v === undefined || v.trim() === '') {
    throw new Error("HB_SNAPSHOT not set: use 'seed', a path to an export JSON, or 'fixture' (dev/tests only), e.g. HB_SNAPSHOT=fixture npm run build -w @hb/storefront");
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
