/**
 * CART-1 — settings key/value rows ⇄ CAT-1 `SnapshotSettings`.
 *
 * The D1 `settings` table (and the seed's `data/catalog/settings.json`, which the seed upserts into
 * that table) is key → JSON. Most storefront keys map one to one onto `SnapshotSettings`; these do not:
 *  - `cartEnabled` (JSON boolean): key missing ⇒ `true` (the store as it was before the switch).
 *  - `metaPixelId` (JSON string) + `metaConsentRequired` (JSON boolean, missing ⇒ `true`) become
 *    `metaPixel: { pixelId, consentRequired } | null`; no or empty `metaPixelId` ⇒ `null`. The ID's
 *    format is checked by the snapshot validator, so a bad ID fails the publish with a message.
 *
 * `SNAPSHOT_SETTINGS_KEYS` is the explicit allowlist of keys a snapshot may be built from. Anything
 * else in the table (jobs.*, seed.owned, order and call settings, and above all the Meta server
 * secrets `metaAccessTokenEnc`, `metaTestEventCode`, any `metaAccess*`) is never read here.
 */
import type { SnapshotSettings } from './types.ts';

export const SNAPSHOT_SETTINGS_KEYS = [
  'storeName',
  'contactPhone',
  'whatsapp',
  'contactEmail',
  'homeFeaturedProductIds',
  'homeHeroProductId',
  'turnstileSiteKey',
  'cartEnabled',
  'metaPixelId',
  'metaConsentRequired',
] as const;
export type SnapshotSettingsKey = (typeof SNAPSHOT_SETTINGS_KEYS)[number];

/** Keys without which no snapshot is built (never a silent default). */
export const REQUIRED_SNAPSHOT_SETTINGS_KEYS: readonly SnapshotSettingsKey[] = ['storeName', 'contactPhone', 'whatsapp'];

const ALLOWED: ReadonlySet<string> = new Set(SNAPSHOT_SETTINGS_KEYS);

export class MissingSettingError extends Error {
  readonly key: string;
  constructor(key: string, source: string) {
    super(`${source}: settings.${key} is missing`);
    this.name = 'MissingSettingError';
    this.key = key;
  }
}

/**
 * Builds the (unvalidated) `settings` object of a snapshot from key/value pairs. Only allowlisted keys
 * are looked at; the result goes through `parseSnapshot` like every other part of the snapshot.
 * Throws `MissingSettingError` when a required key is absent.
 */
export function settingsFromKeyValues(entries: Iterable<readonly [string, unknown]>, source = 'settings'): unknown {
  const m = new Map<SnapshotSettingsKey, unknown>();
  for (const [k, v] of entries) if (ALLOWED.has(k)) m.set(k as SnapshotSettingsKey, v);
  for (const k of REQUIRED_SNAPSHOT_SETTINGS_KEYS) if (!m.has(k)) throw new MissingSettingError(k, source);
  const opt = (k: SnapshotSettingsKey, dflt: unknown): unknown => (m.has(k) && m.get(k) !== null ? m.get(k) : dflt);

  const rawPixel = m.get('metaPixelId');
  const pixelId = typeof rawPixel === 'string' ? rawPixel.trim() : rawPixel;
  const metaPixel =
    pixelId === undefined || pixelId === null || pixelId === ''
      ? null
      : { pixelId, consentRequired: opt('metaConsentRequired', true) };

  return {
    storeName: m.get('storeName'),
    contactPhone: m.get('contactPhone'),
    whatsapp: m.get('whatsapp'),
    contactEmail: opt('contactEmail', null),
    homeFeaturedProductIds: opt('homeFeaturedProductIds', []),
    homeHeroProductId: opt('homeHeroProductId', null),
    turnstileSiteKey: opt('turnstileSiteKey', null),
    cartEnabled: opt('cartEnabled', true),
    metaPixel,
  };
}

/** The inverse, for seeding a database from a snapshot (tests, fixtures). Absent keys mean their default. */
export function settingsToKeyValues(s: SnapshotSettings): Record<SnapshotSettingsKey, unknown> {
  return {
    storeName: s.storeName,
    contactPhone: s.contactPhone,
    whatsapp: s.whatsapp,
    contactEmail: s.contactEmail,
    homeFeaturedProductIds: s.homeFeaturedProductIds,
    homeHeroProductId: s.homeHeroProductId,
    turnstileSiteKey: s.turnstileSiteKey,
    cartEnabled: s.cartEnabled,
    metaPixelId: s.metaPixel?.pixelId ?? null,
    metaConsentRequired: s.metaPixel?.consentRequired ?? true,
  };
}
