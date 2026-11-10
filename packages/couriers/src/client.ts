/**
 * What every adapter does the same way: where to send a request, how to read an HTTP result, and
 * how to keep secrets out of what comes back.
 */
import { clampTimeout, guardedFetch, type GuardedInit, type GuardedResult } from './http.ts';
import type {
  CourierContext,
  CourierCredentials,
  CreateResult,
  CredentialCheck,
  ListResult,
  LookupUnavailable,
} from './types.ts';

export const DEFAULT_DEADLINE_MS = 25_000;
const TRACKING = /^[A-Za-z0-9_-]{1,64}$/;

export const isValidTracking = (value: unknown): value is string =>
  typeof value === 'string' && TRACKING.test(value);

/** The stand-in only outside production; otherwise the fixed production base from the code. */
export function courierBase(productionBase: string, courierId: string, ctx: CourierContext): string {
  if (ctx.env !== 'production' && ctx.standinUrl) {
    return `${ctx.standinUrl.replace(/\/+$/, '')}/${courierId}`;
  }
  return productionBase;
}

export interface Deadline {
  remaining(): number;
}

export function startDeadline(ctx: CourierContext): Deadline {
  const now = ctx.now ?? Date.now;
  const end = now() + (ctx.deadlineMs ?? DEFAULT_DEADLINE_MS);
  return { remaining: () => end - now() };
}

function guardContext(ctx: CourierContext, timeoutMs: number | undefined) {
  return {
    env: ctx.env,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
  };
}

/** One attempt. Writes and POST-based reads go through this. */
export function send(url: string, init: GuardedInit, ctx: CourierContext): Promise<GuardedResult> {
  return guardedFetch(url, init, guardContext(ctx, ctx.timeoutMs));
}

const RETRYABLE = new Set([502, 503, 504]);

function isRetryable(result: GuardedResult): boolean {
  return result.kind === 'network' || (result.kind === 'response' && RETRYABLE.has(result.status));
}

/** A GET, retried once on a network error or 502/503/504, inside the method's deadline. */
export async function read(
  url: string,
  headers: Record<string, string>,
  ctx: CourierContext,
  deadline: Deadline,
): Promise<GuardedResult> {
  let result: GuardedResult = { kind: 'timeout' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const left = deadline.remaining();
    if (left <= 0) return { kind: 'timeout' };
    result = await guardedFetch(
      url,
      { method: 'GET', headers },
      guardContext(ctx, Math.min(clampTimeout(ctx.timeoutMs), left)),
    );
    if (!isRetryable(result)) return result;
  }
  return result;
}

/** Courier wording, capped, with any URL and every credential value removed. */
export function redact(text: unknown, credentials: CourierCredentials): string {
  if (typeof text !== 'string') return '';
  let out = text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]');
  for (const value of Object.values(credentials)) {
    if (value !== '') out = out.split(value).join('***');
  }
  return out.slice(0, 300);
}

/** Parses a JSON object body, or undefined. */
export function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A short, fixed cause for a failed request. Contains nothing a courier or URL supplied. */
export function failureCause(result: GuardedResult): string {
  switch (result.kind) {
    case 'response':
      return `http_${result.status}`;
    case 'redirect':
      return `redirect_${result.status}`;
    case 'refused':
      return `guard_refused:${result.reason}`;
    case 'network':
      return 'network';
    case 'timeout':
      return 'timeout';
    case 'too_large':
      return 'too_large';
  }
}

const REJECTING_STATUS: Readonly<Record<number, 'auth' | 'rate_limited' | 'bad_request'>> = {
  400: 'bad_request',
  401: 'auth',
  403: 'auth',
  404: 'bad_request',
  422: 'bad_request',
  429: 'rate_limited',
};

/**
 * First cut at a write: a non-2xx answer becomes a result, a 2xx hands the body back to be parsed.
 * Only the listed statuses mean "nothing created"; everything else leaves it uncertain.
 */
export function classifyWrite(
  result: GuardedResult,
  message: (body: string) => unknown,
  credentials: CourierCredentials,
): { readonly done: Exclude<CreateResult, { kind: 'accepted' }> } | { readonly body: string; readonly bytes: Uint8Array } {
  if (result.kind === 'refused') {
    return { done: { kind: 'rejected', code: 'guard_refused', detail: failureCause(result) } };
  }
  if (result.kind !== 'response') return { done: { kind: 'uncertain', cause: failureCause(result) } };
  if (result.status >= 200 && result.status < 300) return { body: result.text, bytes: result.bytes };
  const code = Object.hasOwn(REJECTING_STATUS, result.status) ? REJECTING_STATUS[result.status] : undefined;
  if (code === undefined) return { done: { kind: 'uncertain', cause: failureCause(result) } };
  const detail = redact(message(result.text), credentials) || failureCause(result);
  return {
    done: {
      kind: 'rejected',
      code,
      detail,
      ...(result.retryAfterMs === null ? {} : { retryAfterMs: result.retryAfterMs }),
    },
  };
}

/** A read that didn't give a usable answer. */
export function unavailable(result: GuardedResult): LookupUnavailable {
  return {
    kind: 'unavailable',
    cause: failureCause(result),
    ...(result.kind === 'response' && result.retryAfterMs !== null ? { retryAfterMs: result.retryAfterMs } : {}),
  };
}

export function listFailure<T>(result: GuardedResult): ListResult<T> {
  return {
    ok: false,
    cause: failureCause(result),
    ...(result.kind === 'response' && result.retryAfterMs !== null ? { retryAfterMs: result.retryAfterMs } : {}),
  };
}

/** The shared HTTP half of a credential check; a 2xx returns null for the adapter to read. */
export function classifyCredentialHttp(result: GuardedResult): CredentialCheck | null {
  if (result.kind !== 'response') return { kind: 'unavailable', cause: failureCause(result) };
  if (result.status === 429) {
    return {
      kind: 'rate_limited',
      ...(result.retryAfterMs === null ? {} : { retryAfterMs: result.retryAfterMs }),
    };
  }
  if (result.status === 401 || result.status === 403) return { kind: 'invalid', detail: `http_${result.status}` };
  if (result.status < 200 || result.status >= 300) return { kind: 'unavailable', cause: `http_${result.status}` };
  return null;
}

/** Only `https:` on the courier's host list; outside production, also the stand-in's own origin. */
export function safeLabelUrl(
  value: unknown,
  hosts: readonly string[],
  ctx: CourierContext,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (ctx.env !== 'production' && ctx.standinUrl) {
    try {
      if (parsed.origin === new URL(ctx.standinUrl).origin) return parsed.toString();
    } catch {
      // A bad stand-in URL just doesn't widen the list.
    }
  }
  return parsed.protocol === 'https:' && hosts.includes(parsed.hostname) ? parsed.toString() : undefined;
}
