import { afterEach, describe, expect, test } from 'vitest';
import { groupPhone, t } from '../src/lib/strings.ts';

const table = { 'a.plain': 'Bonjour', 'a.count': '{count} produits', 'a.ph': 'Horaires [PLACEHOLDER]' };

describe('t()', () => {
  afterEach(() => {
    delete process.env['HB_STRICT_COPY'];
  });
  test('missing key fails', () => expect(() => t(table, 'nope')).toThrow(/missing UI string "nope"/));
  test('no vars: the raw template is returned (pages wraps t() as its lookup)', () => expect(t(table, 'a.count')).toBe('{count} produits'));
  test('vars fill every {name}', () => expect(t(table, 'a.count', { count: 3 })).toBe('3 produits'));
  test('vars given but one missing fails', () => expect(() => t(table, 'a.count', { other: 1 })).toThrow(/needs \{count\}/));
  test('placeholder passes in dev, fails when HB_STRICT_COPY=1', () => {
    expect(t(table, 'a.ph')).toBe('Horaires [PLACEHOLDER]');
    process.env['HB_STRICT_COPY'] = '1';
    expect(() => t(table, 'a.ph')).toThrow(/placeholder/);
  });
});

test('groupPhone groups a national mobile number', () => expect(groupPhone('0560417403')).toBe('0560 41 74 03'));
