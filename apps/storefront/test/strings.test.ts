import { afterEach, describe, expect, test } from 'vitest';
import { PLACEHOLDER_RE, groupPhone, placeholderParts, t } from '../src/lib/strings.ts';

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

describe('placeholder markers', () => {
  test('both forms are detected', () => {
    for (const v of ['x [PLACEHOLDER]', '[PLACEHOLDER: note]', 'a [PLACEHOLDER : texte] b']) expect(PLACEHOLDER_RE.test(v), v).toBe(true);
    expect(PLACEHOLDER_RE.test('placeholder text')).toBe(false);
  });
  test('placeholderParts splits text and markers, keeping notes', () => {
    expect(placeholderParts('Horaires 9 h [PLACEHOLDER]')).toEqual([{ text: 'Horaires 9 h' }, { note: null }]);
    expect(placeholderParts('Délai [PLACEHOLDER : à confirmer] puis fin')).toEqual([{ text: 'Délai' }, { note: 'à confirmer' }, { text: 'puis fin' }]);
    expect(placeholderParts('عادةً [PLACEHOLDER: المدة في انتظار تأكيد HB Destockage]')).toEqual([{ text: 'عادةً' }, { note: 'المدة في انتظار تأكيد HB Destockage' }]);
    expect(placeholderParts('no marker')).toEqual([{ text: 'no marker' }]);
  });
  test('strict mode refuses the noted form too', () => {
    process.env['HB_STRICT_COPY'] = '1';
    try {
      expect(() => t({ k: 'x [PLACEHOLDER: y]' }, 'k')).toThrow(/placeholder/);
    } finally {
      delete process.env['HB_STRICT_COPY'];
    }
  });
});
