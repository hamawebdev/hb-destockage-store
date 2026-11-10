/**
 * Public courier webhooks (SHIP-0 contract rules 16, 16a; D-013).
 *
 * The route only checks the per-account URL token and stores the raw request in the D1 inbox. No
 * courier call, no order change and no decryption here: signatures are verified in apps/jobs, which
 * holds the keys. The token is part of the path, so nothing here logs the path, and an error goes
 * to the app's `onError`, which redacts it.
 */
import { getCourier } from '@hb/couriers';
import { hashWebhookToken, WEBHOOK_TOKEN_RE } from '@hb/db/webhook-token';
import type { Context, Hono } from 'hono';
import type { Env } from '../env.ts';
import { apiError } from '../http.ts';

export const COURIER_HOOK_PREFIX = '/api/courier-hook/';
/** A BLOB is written as hex (2x) in a backup statement limited to 90,000 bytes (SHIP-1 review). */
export const MAX_WEBHOOK_BODY_BYTES = 32 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_PENDING_PER_ACCOUNT = 5000;
// Same set as the adapters' crc_token rule (CARR-0 rule 11), `~` included.
const HANDSHAKE_RE = /^[A-Za-z0-9._~-]{1,256}$/;
const DROPPED_HEADER = /^(cookie|authorization|cf-.*|x-forwarded-.*|true-client-ip|x-real-ip|forwarded)$/;

interface Account {
  id: number;
  courier: string;
}

async function findAccount(env: Env, courier: string, token: string): Promise<Account | null> {
  const row = await env.DB.prepare('SELECT id, courier FROM courier_accounts WHERE webhook_token_hash = ?').bind(await hashWebhookToken(token)).first<Account>();
  return row && row.courier === courier ? row : null;
}

/** The body, read with a hard cap so a chunked request cannot get past a Content-Length check. */
async function readCapped(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get('content-length') ?? '0') > MAX_WEBHOOK_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function storedHeaders(request: Request): string | null {
  const kept: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (!DROPPED_HEADER.test(name.toLowerCase())) kept[name.toLowerCase()] = value;
  });
  const json = JSON.stringify(kept);
  return new TextEncoder().encode(json).length <= MAX_HEADER_BYTES ? json : null;
}

export function registerCourierWebhook(app: Hono<{ Bindings: Env }>): void {
  const handler = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    const adapter = getCourier(c.req.param('courier') ?? '');
    const token = c.req.param('token') ?? '';
    // No D1 for anything that cannot be a token of a courier that can send webhooks.
    if (!adapter || adapter.capabilities.webhook === 'none' || !WEBHOOK_TOKEN_RE.test(token)) return apiError(c, 404, 'not_found');
    if (c.req.method !== 'GET' && c.req.method !== 'POST') return apiError(c, 405, 'method_not_allowed', {}, { Allow: 'GET, POST' });
    const account = await findAccount(c.env, adapter.id, token);
    if (!account) return apiError(c, 404, 'not_found');

    if (c.req.method === 'GET') {
      const answer = adapter.webhookHandshake(Object.fromEntries(new URL(c.req.url).searchParams));
      if (!answer || !HANDSHAKE_RE.test(answer.body)) return apiError(c, 400, 'invalid_request');
      return c.body(answer.body, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    }

    const body = await readCapped(c.req.raw);
    const headers = storedHeaders(c.req.raw);
    if (body === null || headers === null) return apiError(c, 413, 'payload_too_large');
    const result = await c.env.DB.prepare(
      `INSERT INTO courier_webhook_inbox (account_id, courier, body, headers, received_at)
       SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM (SELECT 1 FROM courier_webhook_inbox WHERE account_id = ? AND state IN ('pending', 'held') LIMIT ?)) < ?`,
    )
      .bind(account.id, adapter.id, body, headers, Date.now(), account.id, MAX_PENDING_PER_ACCOUNT, MAX_PENDING_PER_ACCOUNT)
      .run();
    if ((result.meta.changes ?? 0) !== 1) return apiError(c, 503, 'server_error', {}, { 'Retry-After': '60' });
    return c.json({ ok: true });
  };
  app.on(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], `${COURIER_HOOK_PREFIX}:courier/:token`, handler);
}
