/**
 * Pinned `Intl` outputs (SHARED-5), framework-agnostic so the same cases run under Node (our
 * tests) and workerd (web's test env): `runFormatCases()` returns every case with its actual
 * output; all must be `ok`. Strings are exact, including the RLM marks (U+200F) ICU puts around
 * Arabic currency and the narrow no-break space (U+202F) French uses for grouping.
 * Observed on Node 24.13 (ICU 77.1, CLDR 47); see artifacts/SHARED-5/.
 */

import { formatDate, formatDateTime, formatNumber, formatPrice } from './format.ts';
import type { Lang } from './lang.ts';

export interface FormatCase {
  readonly fn: 'price' | 'number' | 'date' | 'datetime';
  readonly lang: Lang;
  /** DZD for price/number; epoch ms for date/datetime. */
  readonly input: number;
  readonly expected: string;
}

const RLM = '‏';
const NBSP = ' ';
const NNBSP = ' ';
const AR_MONTHS = ['جانفي', 'فيفري', 'مارس', 'أفريل', 'ماي', 'جوان', 'جويلية', 'أوت', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export const FORMAT_CASES: readonly FormatCase[] = [
  // Prices: integer DZD, Western digits, no decimals (STACK-REPORT §5 "189.000 د.ج.").
  { fn: 'price', lang: 'ar', input: 0, expected: `${RLM}0${NBSP}د.ج.${RLM}` },
  { fn: 'price', lang: 'ar', input: 500, expected: `${RLM}500${NBSP}د.ج.${RLM}` },
  { fn: 'price', lang: 'ar', input: 14600, expected: `${RLM}14.600${NBSP}د.ج.${RLM}` },
  { fn: 'price', lang: 'ar', input: 189000, expected: `${RLM}189.000${NBSP}د.ج.${RLM}` },
  { fn: 'price', lang: 'ar', input: 1234567, expected: `${RLM}1.234.567${NBSP}د.ج.${RLM}` },
  { fn: 'price', lang: 'fr', input: 0, expected: `0${NBSP}DA` },
  { fn: 'price', lang: 'fr', input: 500, expected: `500${NBSP}DA` },
  { fn: 'price', lang: 'fr', input: 14600, expected: `14${NNBSP}600${NBSP}DA` },
  { fn: 'price', lang: 'fr', input: 189000, expected: `189${NNBSP}000${NBSP}DA` },
  { fn: 'price', lang: 'fr', input: 1234567, expected: `1${NNBSP}234${NNBSP}567${NBSP}DA` },
  { fn: 'number', lang: 'ar', input: 16500, expected: '16.500' },
  { fn: 'number', lang: 'fr', input: 16500, expected: `16${NNBSP}500` },
  // Dates: the 15th of every month at 12:00 UTC, Algerian month names in Arabic (جانفي…).
  ...AR_MONTHS.map((m, i) => ({ fn: 'date' as const, lang: 'ar' as const, input: Date.UTC(2026, i, 15, 12), expected: `15 ${m} 2026` })),
  ...FR_MONTHS.map((m, i) => ({ fn: 'date' as const, lang: 'fr' as const, input: Date.UTC(2026, i, 15, 12), expected: `15 ${m} 2026` })),
  // Africa/Algiers (UTC+1, no DST): 23:30 UTC on 31 Dec is 1 Jan locally.
  { fn: 'date', lang: 'fr', input: Date.UTC(2025, 11, 31, 23, 30), expected: '1 janvier 2026' },
  { fn: 'date', lang: 'ar', input: Date.UTC(2025, 11, 31, 23, 30), expected: '1 جانفي 2026' },
  // 15 July 12:00 UTC = 13:00 in Algiers (no summer time).
  { fn: 'datetime', lang: 'fr', input: Date.UTC(2026, 6, 15, 12), expected: '15 juil. 2026, 13:00' },
  { fn: 'datetime', lang: 'ar', input: Date.UTC(2026, 6, 15, 12), expected: `15${RLM}/07${RLM}/2026، 13:00` },
  { fn: 'datetime', lang: 'fr', input: Date.UTC(2026, 0, 5, 8, 7), expected: '5 janv. 2026, 09:07' },
];

const FNS = { price: formatPrice, number: formatNumber, date: formatDate, datetime: formatDateTime } as const;

export interface FormatCaseResult extends FormatCase {
  readonly actual: string;
  readonly ok: boolean;
}

export function runFormatCases(cases: readonly FormatCase[] = FORMAT_CASES): FormatCaseResult[] {
  return cases.map((c) => {
    let actual: string;
    try {
      actual = FNS[c.fn](c.input, c.lang);
    } catch (e) {
      actual = `THREW: ${e instanceof Error ? e.message : String(e)}`;
    }
    return { ...c, actual, ok: actual === c.expected };
  });
}
