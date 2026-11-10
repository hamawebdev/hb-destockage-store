// CART-1: settings key/value rows → SnapshotSettings (cartEnabled, metaPixel) and their validation.
import { describe, expect, test } from 'vitest';
import {
  fixtureSnapshot,
  MissingSettingError,
  SNAPSHOT_SETTINGS_KEYS,
  settingsFromKeyValues,
  settingsToKeyValues,
  validateSnapshot,
  type CatalogSnapshot,
} from '../src/index.ts';

const base = (): Record<string, unknown> => {
  const { cartEnabled: _c, metaPixelId: _p, metaConsentRequired: _m, ...rest } = settingsToKeyValues(fixtureSnapshot.settings);
  return rest;
};
const map = (kv: Record<string, unknown>) => settingsFromKeyValues(Object.entries(kv)) as Record<string, unknown>;
const issues = (kv: Record<string, unknown>): string[] => {
  const s = { ...fixtureSnapshot, settings: map(kv) } as unknown as CatalogSnapshot;
  const r = validateSnapshot(s, { requireAllWilayas: false });
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
};

describe('settingsFromKeyValues', () => {
  test('keys missing ⇒ cart on, no Pixel (today\'s store), and the result validates', () => {
    const s = map(base());
    expect(s['cartEnabled']).toBe(true);
    expect(s['metaPixel']).toBeNull();
    expect(issues(base())).toEqual([]);
  });

  test('cartEnabled false/true is carried; a non-boolean fails validation', () => {
    expect(map({ ...base(), cartEnabled: false })['cartEnabled']).toBe(false);
    expect(map({ ...base(), cartEnabled: true })['cartEnabled']).toBe(true);
    expect(issues({ ...base(), cartEnabled: 'no' }).join()).toMatch(/settings\.cartEnabled: cartEnabled must be true or false/);
  });

  test('metaPixelId → metaPixel; metaConsentRequired missing ⇒ true; empty ID ⇒ null', () => {
    expect(map({ ...base(), metaPixelId: '123456789012345' })['metaPixel']).toEqual({ pixelId: '123456789012345', consentRequired: true });
    expect(map({ ...base(), metaPixelId: ' 1234567890123456 ', metaConsentRequired: false })['metaPixel']).toEqual({
      pixelId: '1234567890123456',
      consentRequired: false,
    });
    expect(map({ ...base(), metaPixelId: '' })['metaPixel']).toBeNull();
    expect(map({ ...base(), metaPixelId: null, metaConsentRequired: false })['metaPixel']).toBeNull();
    expect(issues({ ...base(), metaPixelId: '1234567890123456', metaConsentRequired: false })).toEqual([]);
  });

  test.each([
    ['12345678901234', /15 or 16 digits/],
    ['12345678901234567', /15 or 16 digits/],
    ['12345678901234a', /15 or 16 digits/],
    ['000000000000000', /all zeros/],
    ['١٢٣٤٥٦٧٨٩٠١٢٣٤٥', /15 or 16 digits/],
    [123456789012345, /metaPixelId must be a string/],
  ])('an invalid Pixel ID %j fails the snapshot with a clear message', (id, msg) => {
    expect(issues({ ...base(), metaPixelId: id }).join()).toMatch(msg);
  });

  test('metaConsentRequired must be boolean when a Pixel is set', () => {
    expect(issues({ ...base(), metaPixelId: '123456789012345', metaConsentRequired: 'yes' }).join()).toMatch(/metaConsentRequired must be true or false/);
  });

  test('only allowlisted keys are read: Meta server secrets and internal keys never appear', () => {
    const SENTINEL = 'SENTINEL-do-not-export-7f3a';
    const kv = {
      ...base(),
      metaPixelId: '123456789012345',
      metaAccessTokenEnc: SENTINEL,
      metaTestEventCode: SENTINEL,
      metaAccessTokenIv: SENTINEL,
      'jobs.backup_status': { health: SENTINEL },
    };
    const out = map(kv);
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(Object.keys(out).sort()).toEqual(Object.keys(fixtureSnapshot.settings).sort());
    for (const k of SNAPSHOT_SETTINGS_KEYS as readonly string[]) expect(k.startsWith('metaAccess') || k === 'metaTestEventCode').toBe(false);
  });

  test('a missing required key throws MissingSettingError naming it', () => {
    const { whatsapp: _w, ...kv } = base();
    expect(() => map(kv)).toThrow(MissingSettingError);
    expect(() => map(kv)).toThrow(/settings\.whatsapp is missing/);
  });

  test('settingsToKeyValues round-trips', () => {
    const withPixel = { ...fixtureSnapshot.settings, cartEnabled: false, metaPixel: { pixelId: '123456789012345', consentRequired: false } };
    expect(settingsFromKeyValues(Object.entries(settingsToKeyValues(withPixel)))).toEqual(withPixel);
    expect(settingsFromKeyValues(Object.entries(settingsToKeyValues(fixtureSnapshot.settings)))).toEqual(fixtureSnapshot.settings);
  });
});
