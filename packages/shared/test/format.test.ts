/** SHARED-5 — Intl formatters. The pinned cases live in src/format-check.ts so web can run them in workerd. */
import { describe, expect, test } from 'vitest';
import { FORMAT_CASES, runFormatCases } from '../src/format-check.ts';
import { formatDate, formatDateTime, formatNumber, formatPrice } from '../src/format.ts';

describe('pinned outputs (Node)', () => {
  test.each(runFormatCases().map((r) => [`${r.fn} ${r.lang} ${r.input}`, r] as const))('%s', (_label, r) => {
    expect(r.actual).toBe(r.expected);
  });
  test('covers every month in both languages', () => {
    expect(FORMAT_CASES.filter((c) => c.fn === 'date').length).toBe(26);
  });
});

test('report string "189.000 د.ج." is the ar-DZ output once the bidi marks and NBSP are dropped', () => {
  expect(formatPrice(189000, 'ar').replace(/‏/g, '').replace(/ /g, ' ')).toBe('189.000 د.ج.');
});

test('Western digits only, never Eastern Arabic', () => {
  for (const s of [formatPrice(1234567, 'ar'), formatNumber(16500, 'ar'), formatDate(Date.UTC(2026, 9, 25), 'ar'), formatDateTime(Date.UTC(2026, 9, 25), 'ar')])
    expect(s).not.toMatch(/[٠-٩۰-۹]/);
});

test('Date objects and epoch ms give the same output; formatters are cached', () => {
  const ms = Date.UTC(2026, 2, 1, 10);
  expect(formatDate(new Date(ms), 'fr')).toBe(formatDate(ms, 'fr'));
  expect(formatDateTime(new Date(ms), 'ar')).toBe(formatDateTime(ms, 'ar'));
  expect(formatPrice(1, 'fr')).toBe(formatPrice(1, 'fr'));
});

test('runFormatCases reports mismatches instead of throwing', () => {
  const [r] = runFormatCases([{ fn: 'price', lang: 'fr', input: 1, expected: 'nope' }]);
  expect(r).toMatchObject({ ok: false, actual: '1 DA' });
});
