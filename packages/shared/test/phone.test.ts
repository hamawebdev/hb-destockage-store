import { describe, expect, test } from 'vitest';
import { formatPhoneDisplay, normalizePhone, toAsciiDigits } from '../src/phone.ts';

// Contract-level table; SHARED-2 extends it to every prefix range.
describe('normalizePhone', () => {
  test.each([
    ['0560417403', '+213560417403'],
    ['05 60 41 74 03', '+213560417403'],
    ['05-60-41-74-03', '+213560417403'],
    ['05.60.41.74.03', '+213560417403'],
    ['(0560) 41 74 03', '+213560417403'],
    ['+213560417403', '+213560417403'],
    ['+213 0560417403', '+213560417403'],
    ['00213560417403', '+213560417403'],
    ['213560417403', '+213560417403'],
    ['٠٥٦٠٤١٧٤٠٣', '+213560417403'],
    ['۰۵۶۰۴۱۷۴۰۳', '+213560417403'],
    ['‏0560417403‎', '+213560417403'],
    ['+213 779 942 022', '+213779942022'],
    ['0661234567', '+213661234567'],
    ['0550123456', '+213550123456'],
    ['0540123456', '+213540123456'],
    ['0564123456', '+213564123456'],
  ])('%s → %s', (input, e164) => {
    const r = normalizePhone(input);
    expect(r).toEqual({ ok: true, e164, national: `0${e164.slice(4)}` });
  });

  test.each([
    ['', 'phone_required'],
    ['   ', 'phone_required'],
    ['‏', 'phone_required'],
    ['0560a17403', 'phone_invalid'],
    ['056041740', 'phone_invalid'],
    ['05604174033', 'phone_invalid'],
    ['560417403', 'phone_invalid'],
    ['+33612345678', 'phone_invalid'],
    ['05+60417403', 'phone_invalid'],
    // the whole alternation is anchored: neither alternative may match a prefix or a suffix
    ['+2135401234567', 'phone_invalid'],
    ['05401234567', 'phone_invalid'],
    ['01550123456', 'phone_invalid'],
    ['+21315501234567', 'phone_invalid'],
    // well-formed but not a mobile
    ['0501234567', 'phone_not_mobile'],
    ['0521234567', 'phone_not_mobile'],
    ['0531234567', 'phone_not_mobile'],
    ['0543123456', 'phone_not_mobile'],
    ['0565123456', 'phone_not_mobile'],
    ['0761234567', 'phone_not_mobile'],
    ['021234567', 'phone_not_mobile'],
    ['+21321234567', 'phone_not_mobile'],
  ])('%s → %s', (input, code) => {
    expect(normalizePhone(input)).toEqual({ ok: false, code });
  });
});

test('toAsciiDigits', () => {
  expect(toAsciiDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹ abc')).toBe('0123456789 0123456789 abc');
});

test('formatPhoneDisplay', () => {
  expect(formatPhoneDisplay('+213560417403')).toBe('05 60 41 74 03');
  expect(formatPhoneDisplay('0779942022')).toBe('07 79 94 20 22');
  expect(formatPhoneDisplay('garbage')).toBe('garbage');
});
