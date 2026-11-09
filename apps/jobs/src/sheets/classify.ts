// Turns a Google response into one of the contract's outcomes (SHEET-0 §2, Failure). Pure.
// Sheets v4 errors: `error.status` + `error.details[].reason`. Drive v3: `error.errors[].reason`.
// Token endpoint: a top-level `error` string.
import type { GuardedResult } from '@hb/couriers/http';

export type FailureOutcome = 'backoff' | 'needs_reconnect' | 'sheet_lost' | 'layout_changed';

export interface Failure {
  outcome: FailureOutcome;
  /** Stable code shown in settings. Never contains response text. */
  code: string;
  retryAfterMs: number | null;
}

export type Surface = 'sheets' | 'drive' | 'token';

/** A failure carried through the run; `message` is only the code, so it is safe to log. */
export class GoogleError extends Error {
  override readonly name = 'GoogleError';
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(failure.code);
    this.failure = failure;
  }
}

export const failure = (outcome: FailureOutcome, code: string, retryAfterMs: number | null = null): Failure => ({ outcome, code, retryAfterMs });

const backoff = (code: string, retryAfterMs: number | null = null): Failure => failure('backoff', code, retryAfterMs);

function parse(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const asRecord = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function sheetsReasons(error: Record<string, unknown>): string[] {
  const details = Array.isArray(error['details']) ? error['details'] : [];
  return details.map((d) => asRecord(d)?.['reason']).filter((r): r is string => typeof r === 'string');
}

function driveReasons(error: Record<string, unknown>): string[] {
  const errors = Array.isArray(error['errors']) ? error['errors'] : [];
  return errors.map((e) => asRecord(e)?.['reason']).filter((r): r is string => typeof r === 'string');
}

const DRIVE_RATE = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded']);
const DRIVE_SCOPE = new Set(['insufficientScopes', 'insufficientPermissions']);
const DRIVE_FILE_ACCESS = new Set(['insufficientFilePermissions', 'appNotAuthorizedToFile']);

function classifyToken(status: number, body: Record<string, unknown> | null, retry: number | null): Failure {
  const error = body?.['error'];
  if (error === 'invalid_grant') return failure('needs_reconnect', 'invalid_grant');
  if (error === 'invalid_client' || error === 'unauthorized_client') return backoff('google_client_config');
  if (status === 429) return backoff('rate_limited', retry);
  return backoff(body === null ? 'bad_response' : `token_${status}`, retry);
}

function classifySheets(status: number, error: Record<string, unknown> | null, retry: number | null): Failure {
  if (status === 429) return backoff('rate_limited', retry);
  if (status === 401) return failure('needs_reconnect', 'unauthorized');
  if (status === 404) return failure('sheet_lost', 'not_found');
  if (status === 403) {
    if (error === null) return backoff('bad_response', retry);
    const reasons = sheetsReasons(error);
    if (reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) return failure('needs_reconnect', 'scope_missing');
    if (reasons.includes('SERVICE_DISABLED')) return backoff('google_config', retry);
    if (reasons.includes('RATE_LIMIT_EXCEEDED')) return backoff('rate_limited', retry);
    return failure('sheet_lost', 'permission_denied');
  }
  return backoff(error === null ? 'bad_response' : `sheets_${status}`, retry);
}

function classifyDrive(status: number, error: Record<string, unknown> | null, retry: number | null): Failure {
  if (status === 429) return backoff('rate_limited', retry);
  if (status === 401) return failure('needs_reconnect', 'unauthorized');
  if (status === 404) return failure('sheet_lost', 'not_found');
  if (status === 403) {
    if (error === null) return backoff('bad_response', retry);
    const reasons = driveReasons(error);
    if (reasons.some((r) => DRIVE_RATE.has(r))) return backoff('rate_limited', retry);
    if (reasons.includes('storageQuotaExceeded')) return backoff('drive_full', retry);
    if (reasons.some((r) => DRIVE_SCOPE.has(r))) return failure('needs_reconnect', 'scope_missing');
    if (reasons.some((r) => DRIVE_FILE_ACCESS.has(r))) return failure('sheet_lost', 'permission_denied');
    return backoff('drive_403', retry);
  }
  return backoff(error === null ? 'bad_response' : `drive_${status}`, retry);
}

/** Null for a 2xx response; a body that then fails to parse is the caller's `bad_response`. */
export function classify(surface: Surface, r: GuardedResult): Failure | null {
  switch (r.kind) {
    case 'refused':
      return backoff('guard_refused');
    case 'timeout':
      return backoff('timeout');
    case 'network':
      return backoff('network');
    case 'redirect':
      return backoff('redirect');
    case 'too_large':
      return backoff('too_large');
    case 'response':
      break;
  }
  if (r.status >= 200 && r.status < 300) return null;
  if (r.status >= 500) return backoff('server_error', r.retryAfterMs);
  const body = parse(r.text);
  if (surface === 'token') return classifyToken(r.status, body, r.retryAfterMs);
  const error = asRecord(body?.['error']);
  return surface === 'sheets' ? classifySheets(r.status, error, r.retryAfterMs) : classifyDrive(r.status, error, r.retryAfterMs);
}
