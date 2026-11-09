/** Exact status lookup. No case-folding, no substring, no regex: anything unlisted is `unknown`. */
import type { CourierStatus } from './types.ts';

// A Map, so a raw status of `constructor` or `__proto__` finds nothing.
export type StatusTable = ReadonlyMap<string, CourierStatus>;

export function statusTable(entries: Readonly<Record<string, CourierStatus>>): StatusTable {
  return new Map(Object.entries(entries).map(([raw, status]) => [raw.normalize('NFC'), status]));
}

/** The form statuses are compared in: trimmed and NFC. Non-strings have no form. */
export function normaliseRaw(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().normalize('NFC');
  return value === '' ? null : value;
}

export function mapStatus(table: StatusTable, raw: unknown): CourierStatus {
  const value = normaliseRaw(raw);
  return value === null ? 'unknown' : (table.get(value) ?? 'unknown');
}
