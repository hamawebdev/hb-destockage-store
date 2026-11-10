// Meta Pixel build settings (artifacts/META-0/contract.md §2.1; MSET-4, D-017). Pure, tested in
// test/meta-config.test.ts. The only source is the published snapshot's `settings.metaPixel`, which the
// admin's Meta screen feeds through the publish export. No environment variable is read for Meta:
// a snapshot without a Pixel means the storefront ships nothing Meta-related at all.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fixtureSnapshot } from '@hb/catalog/fixtures/snapshot';
import { settingsFromKeyValues } from '@hb/catalog/settings';
import { findRepoRoot } from '@hb/catalog/sources';

/**
 * @param {unknown} metaPixel the snapshot's `settings.metaPixel`: `{ pixelId, consentRequired }`, or null/undefined
 * @returns {{ pixelId: string, consent: 'required' | 'off' } | null} null = Meta is off
 */
export function metaBuildConfig(metaPixel) {
  if (metaPixel === null || metaPixel === undefined) return null;
  if (typeof metaPixel !== 'object') throw new Error('settings.metaPixel must be an object or null');
  const { pixelId, consentRequired } = /** @type {{ pixelId?: unknown, consentRequired?: unknown }} */ (metaPixel);
  // Same rule as @hb/shared isMetaPixelId (parity test). The message never echoes the value.
  if (typeof pixelId !== 'string' || !/^\d{15,16}$/.test(pixelId) || /^0+$/.test(pixelId)) {
    throw new Error('settings.metaPixel.pixelId must be 15 or 16 digits, not all zeros');
  }
  if (typeof consentRequired !== 'boolean') throw new Error('settings.metaPixel.consentRequired must be true or false');
  return { pixelId, consent: consentRequired ? 'required' : 'off' };
}

/**
 * `settings.metaPixel` of the snapshot HB_SNAPSHOT names, read synchronously from the same source as
 * @hb/catalog/sources loadSnapshot (parity test): `fixture`, `seed` (data/catalog/settings.json, D1-style
 * keys) or a path to an export JSON. Unset HB_SNAPSHOT: off (the build itself fails on that elsewhere).
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {unknown}
 */
export function snapshotMetaPixel(env) {
  const which = (env['HB_SNAPSHOT'] ?? '').trim();
  if (which === '') return null;
  if (which === 'fixture') return fixtureSnapshot.settings.metaPixel;
  const root = findRepoRoot(process.cwd());
  if (which === 'seed') {
    const raw = JSON.parse(readFileSync(join(root, 'data/catalog/settings.json'), 'utf8'));
    return /** @type {{ metaPixel?: unknown }} */ (settingsFromKeyValues(Object.entries(raw), 'data/catalog/settings.json')).metaPixel;
  }
  const snapshot = JSON.parse(readFileSync(isAbsolute(which) ? which : join(root, which), 'utf8'));
  return snapshot?.settings?.metaPixel;
}

/** @type {Map<string, ReturnType<typeof metaBuildConfig>>} */
const cache = new Map();

/** The build's settings, read when called (cached per HB_SNAPSHOT value) so tests can change the snapshot. */
export function metaConfig() {
  const key = process.env['HB_SNAPSHOT'] ?? '';
  if (!cache.has(key)) cache.set(key, metaBuildConfig(snapshotMetaPixel(process.env)));
  return cache.get(key) ?? null;
}
