// Parity of public/js/order.js helpers with @hb/shared (the client hint must agree with the server).
// order.js is plain JS served as-is (SHELL-0 rule 2), so it cannot import @hb/shared; these tests keep it honest.
import { describe, expect, it } from 'vitest';
import { DZ_MOBILE_NSN_PATTERN, normalizePhone, toAsciiDigits } from '@hb/shared/phone';
import { formatPrice } from '@hb/shared/format';
import { fmt, parseVariants, phoneError, toAscii, uuid } from '../../../../public/js/order.js';

const P = DZ_MOBILE_NSN_PATTERN;

// Inputs on which every SHARED-1/SHARED-2 version agrees (accept/reject and code).
const COMMON = [
  '0555123456', '0661234567', '0771234567', '0540123456', '0560417403', '+213555123456', '00213555123456',
  '213555123456', '+213 0555 12 34 56', '05 55 12 34 56', '0555-12-34-56', '(0555) 12.34.56',
  '٠٥٥٥١٢٣٤٥٦', '۰۶۶۱۲۳۴۵۶۷', '+٢١٣٥٥٥١٢٣٤٥٦', '‏0555123456‏', '⁦0555 12 34 56⁩',
  '', '   ', 'abc', '+33612345678', '0501234567', '0531234567', '0551234567',
  '021123456', '055512345', '05551234567', '+2135551234',
];

describe('phoneError ≡ @hb/shared normalizePhone (accept/reject)', () => {
  it.each(COMMON)('%j', (input) => {
    const server = normalizePhone(input);
    const client = phoneError(input, P);
    expect(client === null, `client=${client} server=${JSON.stringify(server)}`).toBe(server.ok);
    if (!server.ok && (server.code === 'phone_required' || client === 'phone_required')) expect(client).toBe(server.code);
  });

  // SHARED-2 (team/shared 347b195, not yet on this branch's shared copy): pinned expectations.
  it.each([
    ['０５５５１２３４５６', null], // fullwidth digits
    ['＋213555123456', null], // fullwidth plus
    ['0555­123456', null], // soft hyphen (\p{Cf})
    ['0555​123456', null], // zero-width space (\p{Cf})
    ['555123456', null], // bare mobile NSN
    ['2130555123456', null], // 213 + trunk 0
    ['002130555123456', null],
    ['21123456', 'phone_invalid'], // bare non-mobile is not accepted
    ['0'.repeat(65), 'phone_invalid'],
  ])('SHARED-2 rule %j', (input, code) => {
    expect(phoneError(input, P)).toBe(code);
  });

  it('never uses the naive ^0[567] rule', () => {
    for (const x of ['0501234567', '0521234567', '0531234567']) expect(phoneError(x, P)).not.toBeNull();
  });
});

describe('toAscii ≡ toAsciiDigits', () => {
  it('converts Eastern Arabic and Persian digits the same way', () => {
    const s = 'a٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹ 0123';
    expect(toAscii(s)).toBe(toAsciiDigits(s));
  });
  it('also converts fullwidth digits (SHARED-2)', () => {
    expect(toAscii('０１２３４５６７８９')).toBe('0123456789');
  });
});

describe('fmt ≡ formatPrice', () => {
  it.each([0, 600, 14600, 29800, 189000, 1234567])('%i', (n) => {
    expect(fmt(n, 'ar')).toBe(formatPrice(n, 'ar'));
    expect(fmt(n, 'fr')).toBe(formatPrice(n, 'fr'));
  });
});

describe('small helpers', () => {
  it('parses data-variants', () => {
    expect([...parseVariants('21:3200:3,22:3400:0').values()]).toEqual([
      { id: 21, price: 3200, max: 3, ok: true },
      { id: 22, price: 3400, max: 0, ok: false },
    ]);
    expect(parseVariants('').size).toBe(0);
  });
  it('makes RFC 4122 v4 keys, fresh each time', () => {
    const a = uuid();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuid()).not.toBe(a);
  });
});
