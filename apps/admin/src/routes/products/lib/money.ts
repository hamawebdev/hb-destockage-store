/**
 * Integer-DZD inputs for prices (ACAT-2) and fees (ACAT-4). Stricter than a "strip the separators"
 * parse: a dot or comma is accepted only as a thousands separator in well-formed 3-digit groups
 * (`14.600`, `14 600`, `1,500,000`), because Algerian prices are written `14.600 د.ج`. Anything that
 * looks like decimals (`1.5`, `1500.00`), a sign, an exponent or an unsafe integer is refused.
 * Eastern-Arabic / Persian digits are converted first (@hb/shared `toAsciiDigits`).
 *
 * Order ceiling: @hb/shared SHARED-3 adds `MAX_ORDER_TOTAL_DZD` (10,000,000) and the order flow
 * refuses totals above it. SHARED-3 is not on main yet, so the same value is declared here; switch
 * to the import when it lands.
 */
import * as v from 'valibot';
import { MAX_QTY_PER_LINE, toAsciiDigits } from '@hb/shared';

/** = @hb/shared `MAX_ORDER_TOTAL_DZD` (SHARED-3). TODO(ACAT-2): import once SHARED-3 is on main. */
export const MAX_ORDER_TOTAL_DZD = 10_000_000;

const GROUPED = /^\d{1,3}(?:[ .,'  ]\d{3})+$/;

/** Parses an integer DZD amount; null when the text is not one. */
export function parseDzd(input: string, max: number): number | null {
  const s = toAsciiDigits(input).trim();
  if (s === '') return null;
  let digits: string;
  if (/^\d+$/.test(s)) digits = s;
  else if (GROUPED.test(s) && new Set(s.replace(/\d/g, '')).size === 1) digits = s.replace(/\D/g, '');
  else return null;
  if (digits.length > 12) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n <= max ? n : null;
}

/** Valibot field: required integer DZD in [0, max]. */
export const vDzd = (max: number) =>
  v.pipe(
    v.optional(v.string(), ''),
    v.check((s) => toAsciiDigits(s).trim() !== '', 'form.required'),
    v.transform((s) => parseDzd(s, max)),
    v.number('form.invalid'),
  );

/** Valibot field: optional integer DZD; absent/'' → null. */
export const vOptionalDzd = (max: number) =>
  v.pipe(
    v.optional(v.string(), ''),
    v.transform((s) => (toAsciiDigits(s).trim() === '' ? null : (parseDzd(s, max) ?? Number.NaN))),
    v.nullable(v.pipe(v.number(), v.check((n) => !Number.isNaN(n), 'form.invalid'))),
  );

/** How a unit price interacts with the order ceiling (warnings on the variant grid). */
export function orderCeiling(priceDzd: number): { kind: 'ok' } | { kind: 'unorderable' } | { kind: 'maxQty'; maxQty: number } {
  if (priceDzd > MAX_ORDER_TOTAL_DZD) return { kind: 'unorderable' };
  const maxQty = Math.floor(MAX_ORDER_TOTAL_DZD / Math.max(priceDzd, 1));
  return maxQty < MAX_QTY_PER_LINE ? { kind: 'maxQty', maxQty } : { kind: 'ok' };
}
