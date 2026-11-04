/**
 * Response helpers shared by every /api/* route. Plan: artifacts/WEB-0/plan.md §2, §9.2.
 * API responses are never cached, never framed, never sniffed and never set cookies.
 */
import type { Context, MiddlewareHandler } from 'hono';

/** Headers on every /api/* response (JSON or empty). */
export const API_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

export const apiHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(API_HEADERS)) c.res.headers.set(k, v);
  // Defence in depth: nothing on this origin sets cookies (CLAUDE.md "Storefront: no cookies").
  c.res.headers.delete('Set-Cookie');
};

/** Stable machine-readable error codes for transport-level failures (field/business codes: @hb/shared). */
export type TransportErrorCode =
  | 'not_found'
  | 'method_not_allowed'
  | 'invalid_request'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'forbidden_origin'
  | 'server_error';

export function apiError(
  c: Context,
  status: 400 | 403 | 404 | 405 | 413 | 415 | 500 | 503,
  code: TransportErrorCode,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return c.json({ ok: false, code, ...extra }, status, headers);
}

/** Structured log line. Never pass names, phones or IPs here. */
export function log(evt: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ evt, ...fields }));
}
