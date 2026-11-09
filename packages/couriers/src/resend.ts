/**
 * The rules that keep a parcel from being created twice, or a draft from being marked shipped.
 * Callers use these rather than reading lookup results themselves.
 */
import type { CourierAdapter, CourierCapabilities, LookupFound, LookupResult } from './types.ts';

/** No source gives a settle delay; a stated conservative choice (contract §7). */
export const VERIFY_AFTER_SECONDS = 300;
/** Scan-based lookups only: archived orders drop out of the scan. Also a choice (contract §7). */
export const SCAN_VERIFY_WITHIN_SECONDS = 86_400;

/**
 * True only for a `not_found` looked up at least `verifyAfterSeconds` after the attempt ended and,
 * where the courier sets one, no later than `verifyWithinSeconds`. A slow POST can still create the
 * parcel after we gave up on it, so an early `not_found` proves nothing.
 */
export function isResendSafe(
  lookup: LookupResult,
  attemptEndedAt: number,
  capabilities: Pick<CourierCapabilities, 'verifyAfterSeconds' | 'verifyWithinSeconds'>,
): boolean {
  if (lookup.kind !== 'not_found') return false;
  if (!Number.isFinite(attemptEndedAt) || !Number.isFinite(lookup.checkedAt)) return false;
  const elapsedMs = lookup.checkedAt - attemptEndedAt;
  if (elapsedMs < capabilities.verifyAfterSeconds * 1000) return false;
  const within = capabilities.verifyWithinSeconds;
  return within === null || elapsedMs <= within * 1000;
}

export type FoundDisposition = 'shipped' | 'draft' | 'person';

/**
 * What a parcel found after an uncertain create means. On a courier with a draft step only a status
 * past pending proves it shipped; `exception` and `unknown` tell us nothing, so a person decides.
 */
export function foundDisposition(
  found: LookupFound,
  capabilities: Pick<CourierCapabilities, 'needsValidation'>,
): FoundDisposition {
  if (found.gone) return 'person';
  if (!capabilities.needsValidation) return 'shipped';
  switch (found.status) {
    case 'in_transit':
    case 'delivered':
    case 'returning':
    case 'returned':
      return 'shipped';
    case 'pending':
      return 'draft';
    case 'exception':
    case 'unknown':
      return 'person';
  }
}

/** An unconfirmed tenant can't be switched on until its credentials have actually worked. */
export function canEnable(
  courier: Pick<CourierAdapter, 'confidence'>,
  lastCheck: 'valid' | 'invalid' | 'unavailable' | 'rate_limited' | null,
): boolean {
  return courier.confidence.baseUrl !== 'unconfirmed' || lastCheck === 'valid';
}
