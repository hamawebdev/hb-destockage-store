import { describe, expect, test } from 'vitest';
import { FIXTURE_ORIGIN, buildYear, requireSnapshot, siteOrigin } from '../src/lib/build-env.mjs';

describe('requireSnapshot', () => {
  test('unset or empty fails with a clear message', () => {
    expect(() => requireSnapshot({})).toThrow(/HB_SNAPSHOT not set/);
    expect(() => requireSnapshot({ HB_SNAPSHOT: ' ' })).toThrow(/HB_SNAPSHOT not set/);
  });
  test('a partial snapshot is refused unless it is the fixture', () => {
    expect(() => requireSnapshot({ HB_SNAPSHOT: 'seed', HB_SNAPSHOT_PARTIAL: '1' })).toThrow(/only with HB_SNAPSHOT=fixture/);
    expect(() => requireSnapshot({ HB_SNAPSHOT: '/x/export.json', HB_SNAPSHOT_PARTIAL: '1' })).toThrow(/only with HB_SNAPSHOT=fixture/);
    expect(requireSnapshot({ HB_SNAPSHOT: 'fixture', HB_SNAPSHOT_PARTIAL: '1' })).toBe('fixture');
  });
  test('any explicit value passes through', () => {
    expect(requireSnapshot({ HB_SNAPSHOT: 'fixture' })).toBe('fixture');
    expect(requireSnapshot({ HB_SNAPSHOT: '/tmp/export.json' })).toBe('/tmp/export.json');
  });
});

describe('buildYear', () => {
  test('SOURCE_DATE_EPOCH (UTC seconds) wins', () => {
    expect(buildYear({ SOURCE_DATE_EPOCH: '1767225599' }, new Date('2030-06-01'))).toBe(2025); // 2025-12-31T23:59:59Z
    expect(buildYear({ SOURCE_DATE_EPOCH: '1767225600' })).toBe(2026);
  });
  test('falls back to the build clock', () => expect(buildYear({}, new Date('2027-03-01T00:00:00Z'))).toBe(2027));
  test('rejects a non-integer epoch', () => expect(() => buildYear({ SOURCE_DATE_EPOCH: 'yesterday' })).toThrow(/integer seconds/));
});

describe('siteOrigin', () => {
  test('unset: fixture gets the fixture origin, anything else fails', () => {
    expect(siteOrigin({ HB_SNAPSHOT: 'fixture' })).toBe(FIXTURE_ORIGIN);
    expect(() => siteOrigin({ HB_SNAPSHOT: 'seed' })).toThrow(/HB_SITE_ORIGIN not set/);
    expect(() => siteOrigin({ HB_SNAPSHOT: '/x/export.json', HB_SITE_ORIGIN: ' ' })).toThrow(/HB_SITE_ORIGIN not set/);
  });
  test('normalised: trailing slashes dropped', () => expect(siteOrigin({ HB_SNAPSHOT: 'seed', HB_SITE_ORIGIN: 'https://shop.example.dz//' })).toBe('https://shop.example.dz'));
  test('https host[:port] or http://localhost only, no path', () => {
    expect(siteOrigin({ HB_SITE_ORIGIN: 'http://localhost:4150' })).toBe('http://localhost:4150');
    expect(() => siteOrigin({ HB_SITE_ORIGIN: 'http://shop.example.dz' })).toThrow(/must be/);
    expect(() => siteOrigin({ HB_SITE_ORIGIN: 'https://shop.example.dz/fr' })).toThrow(/must be/);
  });
});

describe('siteOrigin matches @hb/catalog siteOriginFromEnv', async () => {
  const { siteOriginFromEnv } = await import('@hb/catalog/sources');
  const cases: Record<string, string>[] = [
    { HB_SNAPSHOT: 'fixture' },
    { HB_SNAPSHOT: 'seed', HB_SITE_ORIGIN: 'https://shop.example.dz/' },
    { HB_SITE_ORIGIN: 'http://localhost:4150' },
  ];
  test.each(cases)('%o', (env) => expect(siteOrigin(env)).toBe(siteOriginFromEnv(env)));
  test('both refuse an unset origin outside the fixture', () => {
    expect(() => siteOrigin({ HB_SNAPSHOT: 'seed' })).toThrow();
    expect(() => siteOriginFromEnv({ HB_SNAPSHOT: 'seed' })).toThrow();
  });
});
