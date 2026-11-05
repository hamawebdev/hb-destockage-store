/**
 * SHARED-2 — phone normalisation tests.
 * Rule source: libphonenumber v9.0.42, PhoneNumberMetadata.xml territory DZ, checked at master
 * commit 5ea78f46ccc1a258012344801ce04eb6eb4c55da (2026-11-04). See artifacts/SHARED-2/plan.md.
 */
import { describe, expect, test } from 'vitest';
import {
  DZ_MOBILE_NSN_PATTERN,
  DZ_NON_MOBILE_NSN_PATTERNS,
  PHONE_INPUT_MAX_LENGTH,
  formatPhoneDisplay,
  formatPhoneInternational,
  normalizePhone,
  toAsciiDigits,
} from '../src/phone.ts';

describe('provenance', () => {
  test('patterns are verbatim libphonenumber v9.0.42 DZ metadata', () => {
    expect(DZ_MOBILE_NSN_PATTERN).toBe('5(?:4[0-29]|6[0-4])\\d{6}|(?:55|6\\d|7[7-9])\\d{7}');
    expect(DZ_NON_MOBILE_NSN_PATTERNS).toEqual([
      '9619\\d{5}|(?:[1-3]\\d|4[013-689])\\d{6}', // fixedLine
      '800\\d{6}', // tollFree
      '80[3-689]1\\d{5}', // premiumRate
      '98[23]\\d{6}', // voip
    ]);
  });
  test('equals the CLAUDE.md rule (written without non-capturing groups)', () => {
    expect(DZ_MOBILE_NSN_PATTERN.replaceAll('?:', '')).toBe('5(4[0-29]|6[0-4])\\d{6}|(55|6\\d|7[7-9])\\d{7}');
  });
});

// Independent oracle: allocated mobile prefixes written out by hand from the metadata
// (dialled form, 4 digits), not derived from the regex under test.
const ALLOCATED = new Set<string>([
  '0540', '0541', '0542', '0549',
  ...Array.from({ length: 10 }, (_, i) => `055${i}`),
  '0560', '0561', '0562', '0563', '0564',
  ...Array.from({ length: 100 }, (_, i) => `06${String(i).padStart(2, '0')}`),
  ...Array.from({ length: 30 }, (_, i) => `0${77 + Math.floor(i / 10)}${i % 10}`),
]);

describe('prefix sweep 0500–0799 × every accepted input form', () => {
  const prefixes = Array.from({ length: 300 }, (_, i) => `0${500 + i}`);
  const SUFFIX = '123456';

  test('oracle has the expected size', () => {
    // 4 + 10 + 5 + 100 + 30
    expect(ALLOCATED.size).toBe(149);
  });

  test.each(prefixes)('%s', (prefix) => {
    const national = `${prefix}${SUFFIX}`;
    const nsn = national.slice(1);
    const forms = [national, `+213${nsn}`, `00213${nsn}`, `213${nsn}`, `+213 ${national}`, `00213${national}`, `213${national}`];
    for (const form of forms) {
      const r = normalizePhone(form);
      if (ALLOCATED.has(prefix)) expect(r, form).toEqual({ ok: true, e164: `+213${nsn}`, national });
      else expect(r, form).toEqual({ ok: false, code: 'phone_not_mobile' });
    }
    // Bare NSN (trunk 0 left out): accepted only when it is exactly a mobile.
    expect(normalizePhone(nsn)).toEqual(
      ALLOCATED.has(prefix) ? { ok: true, e164: `+213${nsn}`, national } : { ok: false, code: 'phone_invalid' },
    );
  });
});

describe('normalizePhone: accepted inputs', () => {
  test.each([
    ['0560417403', '+213560417403'],
    ['560417403', '+213560417403'],
    ['05 60 41 74 03', '+213560417403'],
    ['0560 41 74 03', '+213560417403'],
    ['05-60-41-74-03', '+213560417403'],
    ['05.60.41.74.03', '+213560417403'],
    ['05–60—41‐74−03', '+213560417403'],
    ['(0560) 41 74 03', '+213560417403'],
    ['05 60 41\t74\n03', '+213560417403'],
    ['+213560417403', '+213560417403'],
    ['+213 (0) 560 41 74 03', '+213560417403'],
    ['+213 0560417403', '+213560417403'],
    ['00213560417403', '+213560417403'],
    ['00 213 560 41 74 03', '+213560417403'],
    ['213560417403', '+213560417403'],
    ['2130560417403', '+213560417403'], // review r1 N-1
    ['213 0560 41 74 03', '+213560417403'],
    ['002130560417403', '+213560417403'],
    ['٠٥٦٠٤١٧٤٠٣', '+213560417403'],
    ['۰۵۶۰۴۱۷۴۰۳', '+213560417403'],
    ['０５６０４１７４０３', '+213560417403'],
    ['＋２１３５６０４１７４０３', '+213560417403'],
    ['+٢١٣ ٥٦٠ ٤١ ٧٤ ٠٣', '+213560417403'],
    ['05٦٠4١74۰3', '+213560417403'],
    ['‏0560417403‎', '+213560417403'],
    ['⁧+213 560 41 74 03⁩', '+213560417403'],
    ['‫0560417403‬', '+213560417403'],
    ['﻿0560417403', '+213560417403'],
    ['05؜60417403', '+213560417403'],
    ['  0560417403  ', '+213560417403'],
    ['+213 779 942 022', '+213779942022'],
    ['0661234567', '+213661234567'],
    ['0699999999', '+213699999999'],
    ['0550000000', '+213550000000'],
    ['0540123456', '+213540123456'],
    ['0549123456', '+213549123456'],
    ['0564123456', '+213564123456'],
    ['0770000000', '+213770000000'],
    ['0799999999', '+213799999999'],
  ])('%j → %s', (input, e164) => {
    expect(normalizePhone(input)).toEqual({ ok: true, e164, national: `0${e164.slice(4)}` });
  });
});

describe('normalizePhone: rejected inputs', () => {
  test.each([
    // empty
    ['', 'phone_required'],
    ['   ', 'phone_required'],
    ['‏‎', 'phone_required'],
    ['--..()', 'phone_required'],
    // not a phone number
    ['0560a17403', 'phone_invalid'],
    ['O560417403', 'phone_invalid'],
    ['056041740', 'phone_invalid'],
    ['05604174033', 'phone_invalid'],
    ['+33612345678', 'phone_invalid'],
    ['0033612345678', 'phone_invalid'],
    ['05+60417403', 'phone_invalid'],
    ['++213560417403', 'phone_invalid'],
    ['0560417403#', 'phone_invalid'],
    ['0560/417403', 'phone_invalid'],
    ['0560*417403', 'phone_invalid'],
    ['21', 'phone_invalid'],
    ['2131560417403', 'phone_invalid'],
    ['21305604174033', 'phone_invalid'],
    ['0', 'phone_invalid'],
    ['+213', 'phone_invalid'],
    ['12345678', 'phone_invalid'],
    ['1234567890', 'phone_invalid'],
    ['0'.repeat(PHONE_INPUT_MAX_LENGTH + 1), 'phone_invalid'],
    [' '.repeat(PHONE_INPUT_MAX_LENGTH) + '0560417403', 'phone_invalid'],
    // anchoring: neither alternative may match a prefix or suffix of the NSN
    ['+2135401234567', 'phone_invalid'],
    ['05401234567', 'phone_invalid'],
    ['01550123456', 'phone_invalid'],
    ['+21315501234567', 'phone_invalid'],
    ['+213 5401234561', 'phone_invalid'],
    ['0661234567 0661234567', 'phone_invalid'],
    // well-formed Algerian numbers that are not mobiles
    ['0501234567', 'phone_not_mobile'],
    ['0511234567', 'phone_not_mobile'],
    ['0521234567', 'phone_not_mobile'],
    ['0531234567', 'phone_not_mobile'],
    ['0543123456', 'phone_not_mobile'],
    ['0548123456', 'phone_not_mobile'],
    ['0565123456', 'phone_not_mobile'],
    ['0571234567', 'phone_not_mobile'],
    ['0761234567', 'phone_not_mobile'],
    ['0701234567', 'phone_not_mobile'],
    ['021234567', 'phone_not_mobile'], // Algiers fixed line
    ['021 23 45 67', 'phone_not_mobile'],
    ['038123456', 'phone_not_mobile'], // Annaba fixed line
    ['049123456', 'phone_not_mobile'],
    ['+21321234567', 'phone_not_mobile'],
    ['0961912345', 'phone_not_mobile'], // fixed 9619
    ['0800123456', 'phone_not_mobile'], // toll free
    ['0808123456', 'phone_not_mobile'], // premium
    ['0982123456', 'phone_not_mobile'], // voip
    ['0983123456', 'phone_not_mobile'],
  ])('%j → %s', (input, code) => {
    expect(normalizePhone(input)).toEqual({ ok: false, code });
  });

  test('non-mobile 8-digit NSN not in a fixed range is invalid, not "not mobile"', () => {
    expect(normalizePhone('047123456')).toEqual({ ok: false, code: 'phone_invalid' }); // 47 not allocated
    expect(normalizePhone('051234567')).toEqual({ ok: false, code: 'phone_invalid' }); // 8-digit 5x
  });
});

describe('review r1 nit: every invisible format character (\\p{Cf}) is ignored', () => {
  // All format characters in the runtime's Unicode tables (soft hyphen, ALM, Mongolian vowel
  // separator, ZWSP…RLM, bidi embeddings/isolates, word joiner and invisible operators, BOM, tags…).
  const CF: string[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (/^\p{Cf}$/u.test(ch)) CF.push(ch);
  }

  test('the class includes the characters pasted numbers carry', () => {
    for (const cp of [0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0x2066, 0x2069, 0xfeff])
      expect(CF).toContain(String.fromCodePoint(cp));
    expect(CF.length).toBeGreaterThan(150);
  });

  test.each(['0555123456', '+213 555 12 34 56', '٠٥٥٥١٢٣٤٥٦'])('%j with each Cf char at start, middle and end', (base) => {
    const want = normalizePhone(base);
    expect(want.ok).toBe(true);
    for (const ch of CF) {
      const mid = Math.floor(base.length / 2);
      for (const input of [ch + base, base.slice(0, mid) + ch + base.slice(mid), base + ch]) {
        expect(normalizePhone(input), JSON.stringify(input)).toEqual(want);
      }
    }
  });

  test.each([
    ['\u200B0555123456', '+213555123456'], // rev-d's vector
    ['\u2068\u200E+213 555 12 34 56\u2069', '+213555123456'],
    ['05\u00AD55\u00AD12\u00AD34\u00AD56', '+213555123456'],
    ['\u200D0555\u200C123456\u2060', '+213555123456'],
  ])('%j → %s', (input, e164) => {
    expect(normalizePhone(input)).toMatchObject({ ok: true, e164 });
  });

  test('format characters alone are still "required"', () => {
    expect(normalizePhone('\u200B\u200C\u00AD\uFEFF')).toEqual({ ok: false, code: 'phone_required' });
  });
});

describe('every non-ASCII digit at every position', () => {
  const base = '0560417403';
  const sets = [
    ['eastern', 0x0660],
    ['persian', 0x06f0],
    ['fullwidth', 0xff10],
  ] as const;
  test.each(sets)('%s', (_name, zero) => {
    for (let pos = 0; pos < base.length; pos++) {
      for (let d = 0; d <= 9; d++) {
        const ascii = base.slice(0, pos) + String(d) + base.slice(pos + 1);
        const mixed = base.slice(0, pos) + String.fromCharCode(zero + d) + base.slice(pos + 1);
        expect(normalizePhone(mixed)).toEqual(normalizePhone(ascii));
      }
    }
  });
});

test('toAsciiDigits', () => {
  expect(toAsciiDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹ ０１２３４５６７８９ abc')).toBe('0123456789 0123456789 0123456789 abc');
  expect(toAsciiDigits('٦٠٠ دج')).toBe('600 دج');
});

describe('idempotence and round-trip (seeded random inputs)', () => {
  // mulberry32: deterministic, no dependency.
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const ALPHABET = ['0', '1', '2', '5', '6', '7', '9', '+', ' ', '-', '.', '٥', '۶', '‏', 'a', '(', ')'];

  test('5,000 random strings: ok results re-normalise to themselves', () => {
    const next = rng(20261104);
    let oks = 0;
    for (let i = 0; i < 5000; i++) {
      const len = 1 + Math.floor(next() * 16);
      let s = i % 4 === 0 ? '0' + ['5', '6', '7'][i % 3] : '';
      for (let j = 0; j < len; j++) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
      const r = normalizePhone(s);
      if (!r.ok) continue;
      oks++;
      expect(normalizePhone(r.e164)).toEqual(r);
      expect(normalizePhone(r.national)).toEqual(r);
      expect(normalizePhone(formatPhoneDisplay(r.e164))).toEqual(r);
      expect(normalizePhone(formatPhoneInternational(r.e164))).toEqual(r);
      expect(r.e164).toMatch(/^\+213[567]\d{8}$/);
    }
    expect(oks).toBeGreaterThan(0);
  });
});

describe('display', () => {
  test('national 0X XX XX XX XX', () => {
    expect(formatPhoneDisplay('+213560417403')).toBe('05 60 41 74 03');
    expect(formatPhoneDisplay('0779942022')).toBe('07 79 94 20 22');
  });
  test('international +213 X XX XX XX XX', () => {
    expect(formatPhoneInternational('+213779942022')).toBe('+213 7 79 94 20 22');
    expect(formatPhoneInternational('0560417403')).toBe('+213 5 60 41 74 03');
  });
  test('non-normalised input is returned unchanged', () => {
    for (const s of ['garbage', '056041740', '+33612345678', '']) {
      expect(formatPhoneDisplay(s)).toBe(s);
      expect(formatPhoneInternational(s)).toBe(s);
    }
  });
});
