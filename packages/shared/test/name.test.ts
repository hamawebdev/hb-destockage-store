/**
 * SHARED-7 — normalizeName is the single order-name rule. Behaviour must equal NameSchema before
 * SHARED-7 (0338ace). OLD_NAME_SCHEMA below is that schema copied verbatim, used as the oracle.
 * Inputs: rev-d's 11 (artifacts/DB-6/confirm-r2-name-rev-d.md) plus 20,000 seeded random strings.
 */
import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import { NAME_MAX_LENGTH, NAME_MIN_LENGTH, normalizeName, type NameResult } from '../src/name.ts';
import { NameSchema, parseOrderInput } from '../src/order-schema.ts';

// ---- Oracle: NameSchema as of 0338ace, verbatim. ---------------------------------------------
const OLD_INVISIBLE_RE = /[\u200b\u200e\u200f\u061c\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const OLD_FORBIDDEN_IN_NAME_RE = /[\p{Cc}\p{Cs}\p{Co}]|(?![\u200c\u200d])\p{Cf}/u;
const OLD_NAME_SCHEMA = v.pipe(
  v.string('name_required'),
  v.normalize('NFC'),
  v.transform((s) => s.replace(OLD_INVISIBLE_RE, '').replace(/\s+/gu, ' ').trim()),
  v.nonEmpty('name_required'),
  v.check((s) => !OLD_FORBIDDEN_IN_NAME_RE.test(s), 'name_invalid'),
  v.regex(/\p{L}/u, 'name_invalid'),
  v.minLength(2, 'name_invalid'),
  v.maxLength(80, 'name_invalid'),
);
// ------------------------------------------------------------------------------------------------

/** A schema's result in normalizeName's shape; the first issue wins, as in toFieldErrors. */
function viaSchema(schema: v.GenericSchema<unknown, string>, input: unknown): NameResult {
  const r = v.safeParse(schema, input);
  return r.success ? { ok: true, value: r.output } : { ok: false, code: r.issues[0].message as 'name_required' | 'name_invalid' };
}

function checkAll(input: unknown): void {
  const old = viaSchema(OLD_NAME_SCHEMA, input);
  expect(viaSchema(NameSchema, input), JSON.stringify(input)).toEqual(old);
  expect(normalizeName(input), JSON.stringify(input)).toEqual(old);
}

test('length limits are unchanged', () => {
  expect([NAME_MIN_LENGTH, NAME_MAX_LENGTH]).toEqual([2, 80]);
});

describe("rev-d's 11 inputs (DB-6 confirm-r2): storefront behaviour unchanged", () => {
  const cases: [string, NameResult][] = [
    ['Amine\tBenali', { ok: true, value: 'Amine Benali' }],
    ['Amine\nBenali', { ok: true, value: 'Amine Benali' }],
    ['Amine\r\nBenali', { ok: true, value: 'Amine Benali' }],
    ['می\u200cخواهم علي', { ok: true, value: 'می\u200cخواهم علي' }],
    ['عل\u200dي أمين', { ok: true, value: 'عل\u200dي أمين' }],
    ['Ami\u00adne Benali', { ok: false, code: 'name_invalid' }],
    ['Amine\ue000 Benali', { ok: false, code: 'name_invalid' }],
    ['Amine\uD800 Benali', { ok: false, code: 'name_invalid' }],
    ['Amine\u0007 Benali', { ok: false, code: 'name_invalid' }],
    ['Amine Benali', { ok: true, value: 'Amine Benali' }],
    ['\u200fAmine Benali\u200f', { ok: true, value: 'Amine Benali' }],
  ];
  test.each(cases)('%j', (input, want) => {
    expect(normalizeName(input)).toEqual(want);
    checkAll(input);
  });

  test('parseOrderInput reports the same code on the name field', () => {
    const base = {
      lang: 'ar',
      items: [{ variantId: 1, qty: 1 }],
      phone: '0661100000',
      wilayaCode: 16,
      communeId: 1601,
      idempotencyKey: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      expectedTotalDzd: 1000,
    };
    for (const [name, want] of cases) {
      const r = parseOrderInput({ ...base, name });
      if (want.ok) expect(r.ok && r.value.name).toBe(want.value);
      else expect(r).toEqual({ ok: false, errors: [{ field: 'name', code: want.code }] });
    }
  });
});

test('non-string and edge inputs', () => {
  for (const x of [undefined, null, 42, {}, [], true, '', ' ', '\t\n', 'a', 'ab', '12', 'a'.repeat(80), 'a'.repeat(81), ' a'.repeat(41)])
    checkAll(x);
  expect(normalizeName(undefined)).toEqual({ ok: false, code: 'name_required' });
  expect(normalizeName('a'.repeat(81))).toEqual({ ok: false, code: 'name_invalid' });
});

describe('20,000 seeded random strings: old NameSchema \u2261 new NameSchema \u2261 normalizeName', () => {
  // mulberry32
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
  const PIECES = [
    // Latin, composed and decomposed accents, digits, punctuation
    'a', 'B', 'z', 'é', 'e\u0301', 'Ï', 'ß', 'œ', '1', '9', '-', "'", '.', ',',
    // Arabic letters, tashkeel, tatweel, Eastern digits, Arabic comma
    'م', 'ح', 'د', 'أ', 'إ', 'ة', 'ى', 'ڨ', '\u064e', '\u0651', 'ـ', '\u0663', '\u060c',
    // spaces: ASCII, NBSP, NNBSP, ideographic, tabs and line breaks
    ' ', '  ', '\u00a0', '\u202f', '\u3000', '\t', '\n', '\r\n', '\u0085', '\u2028',
    // zero-width and bidi format characters
    '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u200e', '\u200f', '\u061c', '\u202a', '\u202e', '\u2066', '\u2069',
    // other format characters: soft hyphen, invisible operators, tag
    '\u00ad', '\u2061', '\u{E0041}',
    // controls
    '\u0000', '\u0007', '\u001B', '\u007F', '\u0090',
    // lone surrogates, valid pair (emoji), private use
    '\uD800', '\uDFFF', '\u{1F600}', '\ue000', '\u{F0000}',
  ];
  const strings: string[] = [];
  const next = rng(20261107);
  for (let i = 0; i < 20_000; i++) {
    const len = Math.floor(next() * (i % 10 === 0 ? 60 : 12));
    let s = '';
    for (let j = 0; j < len; j++) s += PIECES[Math.floor(next() * PIECES.length)];
    strings.push(s);
  }

  test('all agree', () => {
    let ok = 0;
    let required = 0;
    let invalid = 0;
    for (const s of strings) {
      const old = viaSchema(OLD_NAME_SCHEMA, s);
      const neu = viaSchema(NameSchema, s);
      const fn = normalizeName(s);
      if (JSON.stringify(neu) !== JSON.stringify(old) || JSON.stringify(fn) !== JSON.stringify(old)) {
        expect.fail(`${JSON.stringify(s)}: old ${JSON.stringify(old)} new ${JSON.stringify(neu)} fn ${JSON.stringify(fn)}`);
      }
      if (old.ok) ok++;
      else if (old.code === 'name_required') required++;
      else invalid++;
    }
    // Every outcome is well represented, so the comparison is not vacuous.
    expect(ok).toBeGreaterThan(1000);
    expect(required).toBeGreaterThan(500);
    expect(invalid).toBeGreaterThan(5000);
  });
});
