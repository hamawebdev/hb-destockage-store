/** Courier timestamps and event keys. */
import { normaliseRaw } from './status.ts';

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ALGERIA_OFFSET_MS = 3_600_000; // UTC+1, no DST.

/** Epoch ms from a courier date, or null. Naive dates are Algeria time, whatever the host's zone. */
export function parseCourierDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const naive = NAIVE.exec(text);
  if (naive) {
    const [y, mo, d, h, mi, s] = naive.slice(1).map(Number) as [number, number, number, number, number, number];
    const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
    const check = new Date(asUtc);
    // Date.UTC rolls 02-31 over to March; refuse it instead.
    if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
    return asUtc - ALGERIA_OFFSET_MS;
  }
  if (!ZONED.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}

/**
 * `tracking|status|time`, falling back to the courier's event id, then `none`. Same-channel
 * redelivery gives the same key; `none` accepts that a status repeated later collapses into one.
 */
export function eventKey(
  tracking: string,
  rawStatus: string,
  time: { readonly occurredAt: number | null; readonly eventId?: string | null },
): string {
  const status = normaliseRaw(rawStatus) ?? '';
  if (time.occurredAt !== null) return `${tracking}|${status}|${time.occurredAt}`;
  if (time.eventId) return `${tracking}|${status}|ev:${time.eventId}`;
  return `${tracking}|${status}|none`;
}
