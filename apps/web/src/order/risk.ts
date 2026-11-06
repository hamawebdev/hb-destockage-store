/**
 * Flags and risk score (plan WEB-0 §3, lead rulings on WEB-0). Flags never reject an order; the
 * confirmation call is the real filter. `risk_score` = min(100, Σ weights) is what a later SMS-OTP
 * step would key on (≥ 50), and it orders the confirmer's queue.
 */
import { submissionFlags, type OrderFlag, type OrderInput, type TurnstileVerdict } from '@hb/shared';

export interface ServerSignals {
  /** IP over the secondary limit (flag only, never reject: CGNAT). */
  readonly ipOverLimit: boolean;
  /** Non-cancelled orders for this phone in the last 24 h, before this one. */
  readonly ordersLast24h: number;
  readonly blockedCustomer: boolean;
  /** Same phone + variant as a recent order, but not the same person/address: a new order, flagged for staff. */
  readonly possibleDuplicate: boolean;
}

/** More than 3 orders for one phone in 24 h ⇒ the 4th and later are flagged `rate_limited`. */
export const VELOCITY_LIMIT_24H = 3;

export const WEIGHTS = {
  honeypot: 60,
  fast_fill: 30,
  fill_time_missing: 10,
  turnstile_missing: 20,
  turnstile_invalid: 40,
  /** siteverify timeout or our misconfiguration: flagged `turnstile_invalid` but not the shopper's fault. */
  turnstile_error: 0,
  ip_rate: 20,
  velocity: 30,
  blocked_customer: 100,
} as const;

export interface Assessment {
  readonly flags: readonly OrderFlag[];
  readonly riskScore: number;
}

export function assess(
  input: Pick<OrderInput, 'website' | 'fillMs'>,
  turnstile: TurnstileVerdict,
  minFillMs: number,
  signals: ServerSignals,
): Assessment {
  const flags = new Set<OrderFlag>(submissionFlags(input, turnstile, minFillMs));
  let score = 0;
  if (flags.has('honeypot')) score += WEIGHTS.honeypot;
  if (flags.has('fast_fill')) score += WEIGHTS.fast_fill;
  if (flags.has('fill_time_missing')) score += WEIGHTS.fill_time_missing;
  if (turnstile === 'missing') score += WEIGHTS.turnstile_missing;
  else if (turnstile === 'invalid') score += WEIGHTS.turnstile_invalid;
  else if (turnstile === 'error') score += WEIGHTS.turnstile_error;
  if (signals.ipOverLimit) {
    flags.add('rate_limited');
    score += WEIGHTS.ip_rate;
  }
  if (signals.ordersLast24h >= VELOCITY_LIMIT_24H) {
    flags.add('rate_limited');
    score += WEIGHTS.velocity;
  }
  if (signals.possibleDuplicate) flags.add('duplicate');
  if (signals.blockedCustomer) {
    flags.add('blocked_customer');
    score += WEIGHTS.blocked_customer;
  }
  return { flags: [...flags], riskScore: Math.min(100, score) };
}

/**
 * Sink rule (lead ruling on WEB-0 §3.1): only when the honeypot AND the fill-time signal both fire.
 * JS path: honeypot + `fast_fill`. No-JS path: honeypot + (`fast_fill` or no valid review token).
 */
export function shouldSink(flags: readonly OrderFlag[], path: 'json' | 'form'): boolean {
  if (!flags.includes('honeypot')) return false;
  if (flags.includes('fast_fill')) return true;
  return path === 'form' && flags.includes('fill_time_missing');
}
