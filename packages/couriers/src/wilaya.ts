/** Orders use the 69 wilayas; couriers still on the old scheme take 1..58. */
import type { WilayaMapping } from './types.ts';

/**
 * Wilayas 59..69 (Decree 26-206) to the wilaya they were split from. Derived from the pre-reform
 * commune codes in data/geo/source/algeria-cities.
 */
export const WILAYA_PARENT: Readonly<Record<number, number>> = {
  59: 3,
  60: 5,
  61: 7,
  62: 12,
  63: 13,
  64: 14,
  65: 17,
  66: 17,
  67: 26,
  68: 28,
  69: 32,
};

export function toWilaya58(code: number): WilayaMapping {
  if (!Number.isInteger(code) || code < 1 || code > 69) {
    return { ok: false, code: 'wilaya_unmapped', detail: `Wilaya ${String(code)} does not exist` };
  }
  return { ok: true, code: WILAYA_PARENT[code] ?? code };
}
