/**
 * Transport guards for POST /api/* (plan WEB-0 §3 layer 0): cross-site, media type, size, parse.
 * All checks run before any I/O.
 */
import type { Context } from 'hono';
import {
  ORDER_ERROR_HTTP_STATUS,
  type ApiFailure,
  type OrderErrorCode,
} from '@hb/shared';

/** Request bodies above this are refused with 413 (an order is ~400 B). */
export const MAX_BODY_BYTES = 8 * 1024;
export const RETRY_AFTER_S = 5;

export type MediaKind = 'json' | 'form';

export type BodyResult =
  | { readonly ok: true; readonly kind: MediaKind; readonly text: string }
  | { readonly ok: false; readonly code: Extract<OrderErrorCode, 'forbidden_origin' | 'unsupported_media_type' | 'payload_too_large' | 'invalid_request'> };

export function mediaKind(contentType: string | undefined): MediaKind | null {
  const essence = (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (essence === 'application/json') return 'json';
  if (essence === 'application/x-www-form-urlencoded') return 'form';
  return null;
}

/**
 * Reads the body as UTF-8 text with a hard byte cap, after the cheap header checks.
 * `allowed` lists the media types the route accepts.
 */
export async function readBody(req: Request, allowed: readonly MediaKind[]): Promise<BodyResult> {
  // A browser posting from another site says so; our own form and order.js are same-origin.
  if (req.headers.get('Sec-Fetch-Site') === 'cross-site') return { ok: false, code: 'forbidden_origin' };
  const kind = mediaKind(req.headers.get('Content-Type') ?? undefined);
  if (kind === null || !allowed.includes(kind)) return { ok: false, code: 'unsupported_media_type' };
  const text = await readCappedText(req, MAX_BODY_BYTES);
  if (text === 'too_large') return { ok: false, code: 'payload_too_large' };
  if (text === null) return { ok: false, code: 'invalid_request' };
  return { ok: true, kind, text };
}

/**
 * Streams the body as strict UTF-8 with a hard byte cap: never buffers more than `max` bytes, whatever
 * Content-Length says (chunked or understated bodies included). `null` = no body or invalid UTF-8.
 */
export async function readCappedText(req: Request, max: number): Promise<string | null | 'too_large'> {
  const declared = req.headers.get('Content-Length');
  if (declared !== null && Number(declared) > max) return 'too_large';
  if (req.body === null) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return 'too_large';
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** Parses JSON text; anything but a plain object is `invalid_request` (the schemas check the rest). */
export function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** JSON failure body with the status from `ORDER_ERROR_HTTP_STATUS`, plus Retry-After where due. */
export function failure(c: Context, body: Omit<ApiFailure, 'ok'>): Response {
  const status = ORDER_ERROR_HTTP_STATUS[body.code];
  const headers: Record<string, string> = {};
  let out: ApiFailure = { ok: false, ...body };
  if (body.code === 'server_error') {
    out = { ...out, retryAfterS: RETRY_AFTER_S };
    headers['Retry-After'] = String(RETRY_AFTER_S);
  } else if (body.retryAfterS !== undefined) {
    headers['Retry-After'] = String(body.retryAfterS);
  }
  return c.json(out, status, headers);
}
