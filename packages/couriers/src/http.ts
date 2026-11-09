/**
 * The one outbound HTTP helper for courier and Google calls (BRIEF §3). Nothing else in the package
 * calls `fetch`. One attempt per call; it never throws. Outside production it refuses every host
 * but loopback, before opening a socket.
 */

export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export type RefusalReason = 'host_not_local' | 'not_https' | 'invalid_url';

export type GuardedResult =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly text: string;
      readonly bytes: Uint8Array;
      readonly headers: Headers;
      readonly retryAfterMs: number | null;
    }
  | { readonly kind: 'redirect'; readonly status: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network'; readonly message: string }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'refused'; readonly reason: RefusalReason };

export interface GuardContext {
  /** The Worker's `ENV`. Anything but exactly `production` is held to loopback. */
  readonly env: string | undefined;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export type GuardedInit = Omit<RequestInit, 'redirect' | 'signal'>;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** Applies the guard to a URL. Exported so callers can pre-check; `guardedFetch` always applies it. */
export function checkOutboundUrl(
  url: string,
  env: string | undefined,
): { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly reason: RefusalReason } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'invalid_url' };
  if (env === 'production') {
    return parsed.protocol === 'https:'
      ? { ok: true, url: parsed }
      : { ok: false, reason: 'not_https' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'invalid_url' };
  }
  return LOCAL_HOSTS.has(parsed.hostname)
    ? { ok: true, url: parsed }
    : { ok: false, reason: 'host_not_local' };
}

/** Clamps to 1 ms..60 s; non-finite input falls back to the default. */
export function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(value), 1), MAX_TIMEOUT_MS);
}

const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** `Retry-After` as delta seconds or an HTTP date. Garbage gives null; large values are clamped to 1 h. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d{1,12}$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  if (!HTTP_DATE.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}

function networkMessage(error: unknown): string {
  // Only the error's name and a system code: fetch errors can quote the URL, and URLs can carry tokens.
  const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
  const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause : undefined;
  const code = cause?.code;
  return typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? `${name}:${code}` : name;
}

async function readBody(response: Response, maxBytes: number): Promise<Uint8Array | 'too_large'> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      return 'too_large';
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function guardedFetch(
  url: string,
  init: GuardedInit,
  ctx: GuardContext,
): Promise<GuardedResult> {
  const checked = checkOutboundUrl(url, ctx.env);
  if (!checked.ok) return { kind: 'refused', reason: checked.reason };

  const doFetch = ctx.fetch ?? fetch;
  const now = ctx.now ?? Date.now;
  const maxBytes = ctx.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();

  const work = (async (): Promise<GuardedResult> => {
    try {
      const response = await doFetch(checked.url.toString(), {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        return { kind: 'redirect', status: response.status };
      }
      const bytes = await readBody(response, maxBytes);
      if (bytes === 'too_large') return { kind: 'too_large' };
      return {
        kind: 'response',
        status: response.status,
        text: new TextDecoder().decode(bytes),
        bytes,
        headers: response.headers,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), now()),
      };
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'timeout' };
      return { kind: 'network', message: networkMessage(error) };
    }
  })();

  // Raced as well as aborted, so a body that ignores the abort signal still ends on time.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<GuardedResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'timeout' });
    }, clampTimeout(ctx.timeoutMs));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
