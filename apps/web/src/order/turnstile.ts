/**
 * Server-side Turnstile check (plan WEB-0 §3 layer 5). Never rejects an order: the verdict only
 * becomes a flag (`turnstile_missing` / `turnstile_invalid`) and `orders.turnstile`.
 * Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
import type { TurnstileVerdict } from '@hb/shared';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_ACTION = 'order';
export const SITEVERIFY_TIMEOUT_MS = 3_000;

export interface TurnstileCheck {
  readonly token: string | undefined;
  readonly secret: string | undefined;
  readonly ip: string | null;
  /** Our idempotency key: lets siteverify answer a retried check of the same token consistently. */
  readonly idempotencyKey: string;
  /** Hostnames our widget runs on (`SITE_HOSTS`). */
  readonly hosts: readonly string[];
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function verifyTurnstile(check: TurnstileCheck): Promise<TurnstileVerdict> {
  if (check.token === undefined || check.token.trim() === '') return 'missing';
  // No secret configured: we cannot verify, which is our fault, not the shopper's.
  if (check.secret === undefined || check.secret === '') return 'error';
  const body = new FormData();
  body.set('secret', check.secret);
  body.set('response', check.token);
  body.set('idempotency_key', check.idempotencyKey);
  if (check.ip !== null) body.set('remoteip', check.ip);
  try {
    const res = await (check.fetcher ?? fetch)(SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(check.timeoutMs ?? SITEVERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return 'error';
    const out = (await res.json()) as { success?: unknown; hostname?: unknown; action?: unknown };
    if (out.success !== true) return 'invalid';
    if (typeof out.hostname !== 'string' || !check.hosts.includes(out.hostname.toLowerCase())) return 'invalid';
    if (out.action !== TURNSTILE_ACTION) return 'invalid';
    return 'ok';
  } catch {
    return 'error';
  }
}
