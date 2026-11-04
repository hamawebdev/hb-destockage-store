import { expect, test } from 'vitest';
import { formatDate, formatDateTime, formatNumber, formatPrice } from '../src/format.ts';

// Exact strings from Node 24 / ICU 77.1. SHARED-5 records the same assertions under workerd.
test('formatPrice', () => {
  expect(formatPrice(189000, 'ar')).toBe('‏189.000 د.ج.‏');
  expect(formatPrice(189000, 'fr')).toBe('189 000 DA');
  expect(formatPrice(14600, 'ar')).toBe('‏14.600 د.ج.‏');
  expect(formatPrice(500, 'fr')).toBe('500 DA');
});

test('formatNumber uses Western digits', () => {
  expect(formatNumber(16500, 'ar')).toBe('16.500');
  expect(formatNumber(16500, 'fr')).toBe('16 500');
});

test('formatDate uses Algerian month names and Africa/Algiers', () => {
  const jan15 = Date.UTC(2026, 0, 15, 12);
  expect(formatDate(jan15, 'ar')).toBe('15 جانفي 2026');
  expect(formatDate(jan15, 'fr')).toBe('15 janvier 2026');
  // 23:30 UTC on 31 Dec is already 1 Jan in Algiers (UTC+1).
  expect(formatDate(Date.UTC(2025, 11, 31, 23, 30), 'fr')).toBe('1 janvier 2026');
});

test('formatDateTime is 24-hour in Algiers time', () => {
  expect(formatDateTime(Date.UTC(2026, 6, 15, 12), 'fr')).toMatch(/13:00/);
  expect(formatDateTime(Date.UTC(2026, 6, 15, 12), 'ar')).toMatch(/13:00/);
});
