import { describe, expect, test } from 'vitest';
import { buildYear, requireSnapshot } from '../src/lib/build-env.mjs';

describe('requireSnapshot', () => {
  test('unset or empty fails with a clear message', () => {
    expect(() => requireSnapshot({})).toThrow(/HB_SNAPSHOT not set/);
    expect(() => requireSnapshot({ HB_SNAPSHOT: ' ' })).toThrow(/HB_SNAPSHOT not set/);
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
