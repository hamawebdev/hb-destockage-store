import { describe, expect, it } from 'vitest';
import { canEnable, foundDisposition, isResendSafe } from '../src/resend.ts';
import { COURIER_STATUSES, type CourierStatus, type LookupFound, type LookupResult } from '../src/types.ts';
import { getCourier, listCouriers } from '../src/registry.ts';

const T0 = Date.UTC(2026, 10, 9, 10, 0, 0);
const open = { verifyAfterSeconds: 300, verifyWithinSeconds: null };
const bounded = { verifyAfterSeconds: 300, verifyWithinSeconds: 86_400 };
const notFoundAt = (seconds: number): LookupResult => ({
  kind: 'not_found',
  checkedAt: T0 + seconds * 1000,
});

describe('isResendSafe', () => {
  it('refuses a lookup before the window, however late it is evaluated', () => {
    expect(isResendSafe(notFoundAt(10), T0, open)).toBe(false);
    expect(isResendSafe(notFoundAt(299), T0, open)).toBe(false);
  });

  it('allows a lookup at or after the window', () => {
    expect(isResendSafe(notFoundAt(300), T0, open)).toBe(true);
    expect(isResendSafe(notFoundAt(1_000_000), T0, open)).toBe(true);
  });

  it('enforces the upper bound on scan-based couriers', () => {
    expect(isResendSafe(notFoundAt(86_400), T0, bounded)).toBe(true);
    expect(isResendSafe(notFoundAt(86_401), T0, bounded)).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses a non-finite attempt time %s',
    (attempt) => {
      expect(isResendSafe(notFoundAt(1000), attempt, open)).toBe(false);
    },
  );

  it('refuses a non-finite checkedAt', () => {
    expect(isResendSafe({ kind: 'not_found', checkedAt: Number.NaN }, T0, open)).toBe(false);
  });

  it('refuses an attempt time after the lookup', () => {
    expect(isResendSafe(notFoundAt(1000), T0 + 2_000_000, open)).toBe(false);
  });

  it.each<LookupResult>([
    { kind: 'found', tracking: 't', rawStatus: 'x', status: 'pending', gone: false },
    { kind: 'multiple', trackings: ['a', 'b'] },
    { kind: 'unavailable', cause: 'down' },
  ])('refuses $kind', (lookup) => {
    expect(isResendSafe(lookup, T0 - 10_000_000, open)).toBe(false);
  });
});

const found = (status: CourierStatus, gone = false): LookupFound => ({
  kind: 'found',
  tracking: 't',
  rawStatus: 'raw',
  status,
  gone,
});

describe('foundDisposition', () => {
  const expected: Record<CourierStatus, string> = {
    pending: 'draft',
    in_transit: 'shipped',
    delivered: 'shipped',
    returning: 'shipped',
    returned: 'shipped',
    exception: 'person',
    unknown: 'person',
  };

  it.each(COURIER_STATUSES)('needs-validation courier: %s', (status) => {
    expect(foundDisposition(found(status), { needsValidation: true })).toBe(expected[status]);
  });

  it.each(COURIER_STATUSES)('no draft step: %s is shipped', (status) => {
    expect(foundDisposition(found(status), { needsValidation: false })).toBe('shipped');
  });

  it.each([true, false])('gone goes to a person (needsValidation %s)', (needsValidation) => {
    expect(foundDisposition(found('in_transit', true), { needsValidation })).toBe('person');
  });
});

describe('canEnable', () => {
  const courier = (baseUrl: 'confirmed' | 'probed' | 'unconfirmed') => ({
    confidence: { baseUrl, statusList: 'official' as const, notes: [] },
  });

  it('holds an unconfirmed tenant until a valid check', () => {
    expect(canEnable(courier('unconfirmed'), null)).toBe(false);
    expect(canEnable(courier('unconfirmed'), 'invalid')).toBe(false);
    expect(canEnable(courier('unconfirmed'), 'unavailable')).toBe(false);
    expect(canEnable(courier('unconfirmed'), 'rate_limited')).toBe(false);
    expect(canEnable(courier('unconfirmed'), 'valid')).toBe(true);
  });

  it('does not hold a probed or confirmed courier', () => {
    expect(canEnable(courier('probed'), null)).toBe(true);
    expect(canEnable(courier('confirmed'), null)).toBe(true);
  });
});

describe('registry', () => {
  it.each(['__proto__', 'constructor', 'toString', '', 'nope'])('finds nothing for %s', (id) => {
    expect(getCourier(id)).toBeUndefined();
  });

  it('has unique, URL-safe ids', () => {
    const ids = listCouriers().map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });
});
