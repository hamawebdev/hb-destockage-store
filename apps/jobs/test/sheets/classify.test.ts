// SHEET-2: one test per row of the contract's failure table, with each API's real envelope.
import { describe, expect, test } from 'vitest';
import type { GuardedResult } from '@hb/couriers/http';
import { classify, type FailureOutcome, type Surface } from '../../src/sheets/classify.ts';
import { resolveGoogleEndpoints } from '../../src/sheets/google.ts';

const res = (status: number, body: unknown, retryAfterMs: number | null = null): GuardedResult => ({
  kind: 'response',
  status,
  text: typeof body === 'string' ? body : JSON.stringify(body),
  bytes: new Uint8Array(),
  headers: new Headers(),
  retryAfterMs,
});

const sheets403 = (reason?: string): GuardedResult => res(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'x', ...(reason ? { details: [{ reason }] } : {}) } });
const drive403 = (reason: string): GuardedResult => res(403, { error: { code: 403, message: 'x', errors: [{ reason }] } });

const cases: [string, Surface, GuardedResult, FailureOutcome, string][] = [
  ['timeout', 'sheets', { kind: 'timeout' }, 'backoff', 'timeout'],
  ['network', 'drive', { kind: 'network', message: 'x' }, 'backoff', 'network'],
  ['redirect', 'sheets', { kind: 'redirect', status: 302 }, 'backoff', 'redirect'],
  ['too large', 'sheets', { kind: 'too_large' }, 'backoff', 'too_large'],
  ['guard refusal', 'sheets', { kind: 'refused', reason: 'host_not_local' }, 'backoff', 'guard_refused'],
  ['5xx', 'token', res(503, 'x'), 'backoff', 'server_error'],
  ['HTML 502 from Sheets', 'sheets', res(502, '<html>'), 'backoff', 'server_error'],
  ['Sheets 429', 'sheets', res(429, { error: { status: 'RESOURCE_EXHAUSTED' } }), 'backoff', 'rate_limited'],
  ['Sheets scope', 'sheets', sheets403('ACCESS_TOKEN_SCOPE_INSUFFICIENT'), 'needs_reconnect', 'scope_missing'],
  ['Sheets service disabled', 'sheets', sheets403('SERVICE_DISABLED'), 'backoff', 'google_config'],
  ['Sheets rate 403', 'sheets', sheets403('RATE_LIMIT_EXCEEDED'), 'backoff', 'rate_limited'],
  ['Sheets permission denied', 'sheets', sheets403(), 'sheet_lost', 'permission_denied'],
  ['Sheets 404', 'sheets', res(404, { error: { status: 'NOT_FOUND' } }), 'sheet_lost', 'not_found'],
  ['Sheets 401', 'sheets', res(401, { error: { status: 'UNAUTHENTICATED' } }), 'needs_reconnect', 'unauthorized'],
  ['Sheets 403 not JSON', 'sheets', res(403, '<html>'), 'backoff', 'bad_response'],
  ['Sheets other 4xx', 'sheets', res(400, { error: { status: 'INVALID_ARGUMENT' } }), 'backoff', 'sheets_400'],
  ['Drive 429', 'drive', res(429, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }), 'backoff', 'rate_limited'],
  ['Drive rate', 'drive', drive403('rateLimitExceeded'), 'backoff', 'rate_limited'],
  ['Drive user rate', 'drive', drive403('userRateLimitExceeded'), 'backoff', 'rate_limited'],
  ['Drive daily', 'drive', drive403('dailyLimitExceeded'), 'backoff', 'rate_limited'],
  ['Drive full', 'drive', drive403('storageQuotaExceeded'), 'backoff', 'drive_full'],
  ['Drive scopes', 'drive', drive403('insufficientScopes'), 'needs_reconnect', 'scope_missing'],
  ['Drive permissions (scope)', 'drive', drive403('insufficientPermissions'), 'needs_reconnect', 'scope_missing'],
  ['Drive file permissions', 'drive', drive403('insufficientFilePermissions'), 'sheet_lost', 'permission_denied'],
  ['Drive not authorised to file', 'drive', drive403('appNotAuthorizedToFile'), 'sheet_lost', 'permission_denied'],
  ['Drive 404', 'drive', res(404, { error: { errors: [{ reason: 'notFound' }] } }), 'sheet_lost', 'not_found'],
  ['Drive 401', 'drive', res(401, { error: { errors: [{ reason: 'authError' }] } }), 'needs_reconnect', 'unauthorized'],
  ['Drive other 403', 'drive', drive403('domainPolicy'), 'backoff', 'drive_403'],
  ['Drive 400', 'drive', res(400, { error: { errors: [{ reason: 'invalid' }] } }), 'backoff', 'drive_400'],
  ['Token invalid_grant', 'token', res(400, { error: 'invalid_grant' }), 'needs_reconnect', 'invalid_grant'],
  ['Token invalid_client', 'token', res(401, { error: 'invalid_client' }), 'backoff', 'google_client_config'],
  ['Token unauthorized_client', 'token', res(400, { error: 'unauthorized_client' }), 'backoff', 'google_client_config'],
  ['Token not JSON', 'token', res(400, '<html>'), 'backoff', 'bad_response'],
  ['Token other', 'token', res(400, { error: 'invalid_request' }), 'backoff', 'token_400'],
];

describe('classify', () => {
  test.each(cases)('%s', (_name, surface, result, outcome, code) => {
    expect(classify(surface, result)).toMatchObject({ outcome, code });
  });

  test('2xx is not a failure', () => {
    expect(classify('sheets', res(200, {}))).toBeNull();
  });

  test('Retry-After is carried for rate limits', () => {
    expect(classify('sheets', res(429, { error: {} }, 600_000))?.retryAfterMs).toBe(600_000);
    expect(classify('drive', { ...(drive403('rateLimitExceeded') as Extract<GuardedResult, { kind: 'response' }>), retryAfterMs: 5000 })?.retryAfterMs).toBe(5000);
  });

  test('response text never reaches the code', () => {
    const f = classify('token', res(400, { error: 'secret-text-from-google' }));
    expect(JSON.stringify(f)).not.toContain('secret-text');
  });
});

describe('resolveGoogleEndpoints', () => {
  const STANDIN = 'http://127.0.0.1:4420';

  test('production ignores the stand-in and uses Google', () => {
    const e = resolveGoogleEndpoints({ ENV: 'production', GOOGLE_STANDIN_URL: STANDIN });
    expect(e?.token).toBe('https://oauth2.googleapis.com/token');
    expect(e?.auth).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(e?.sheets).toBe('https://sheets.googleapis.com/v4/spreadsheets');
    expect(e?.drive).toBe('https://www.googleapis.com/drive/v3/files');
  });

  test.each([['development'], ['test'], [''], [undefined]])('ENV=%s with a loopback stand-in', (env) => {
    expect(resolveGoogleEndpoints({ ENV: env, GOOGLE_STANDIN_URL: STANDIN })?.token).toBe(`${STANDIN}/token`);
    expect(resolveGoogleEndpoints({ ENV: env, GOOGLE_STANDIN_URL: 'http://localhost:4420/' })?.sheets).toBe('http://localhost:4420/v4/spreadsheets');
  });

  test.each([['development'], ['test'], [''], [undefined]])('ENV=%s without a stand-in is off, never Google', (env) => {
    expect(resolveGoogleEndpoints({ ENV: env })).toBeNull();
  });

  test.each([
    'https://sheets.googleapis.com',
    'https://oauth2.googleapis.com',
    'https://accounts.google.com',
    'https://www.googleapis.com',
    'http://127.0.0.1.nip.io',
    'http://127.0.0.1@sheets.googleapis.com',
    'http://localhost.evil.com',
    'http://[::1]:4420',
    'http://127.1:4420',
    'http://0x7f.1:4420',
    'http://LOCALHOST:4420',
    'ftp://127.0.0.1',
    'not a url',
  ])('non-loopback stand-in %s is refused', (url) => {
    expect(resolveGoogleEndpoints({ ENV: 'test', GOOGLE_STANDIN_URL: url })).toBeNull();
  });
});
