// Google endpoints, OAuth calls and the Drive/Sheets calls the sync makes. Shared by the admin
// (connect flow) and the jobs Worker. Every request goes through `guardedFetch`.
import { checkOutboundUrl, guardedFetch, type GuardedInit } from '@hb/couriers/http';
import { openSecret, sealSecret, type SecretBoxKey } from '@hb/db/secret-box';
import { classify, failure, GoogleError, type Surface } from './classify.ts';

export const SCOPE_DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
export const OAUTH_SCOPES = `openid email ${SCOPE_DRIVE_FILE}`;
export const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const CREATE_KEY_PROPERTY = 'hb_create_key';
const TOKEN_AAD = 'sheets.refresh_token';

export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  sheets: string;
  drive: string;
}

const PRODUCTION: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  sheets: 'https://sheets.googleapis.com/v4/spreadsheets',
  drive: 'https://www.googleapis.com/drive/v3/files',
};

const STANDIN_URL = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?\/?$/;

/**
 * The one place that decides where Google traffic goes, including the browser redirect. Outside
 * production only a literal loopback stand-in is accepted; anything else is null (feature off).
 */
export function resolveGoogleEndpoints(env: { ENV?: string | undefined; GOOGLE_STANDIN_URL?: string | undefined }): GoogleEndpoints | null {
  if (env.ENV === 'production') return PRODUCTION;
  const raw = env.GOOGLE_STANDIN_URL;
  if (raw === undefined || !STANDIN_URL.test(raw) || !checkOutboundUrl(raw, env.ENV).ok) return null;
  const base = raw.replace(/\/$/, '');
  return {
    auth: `${base}/o/oauth2/v2/auth`,
    token: `${base}/token`,
    revoke: `${base}/revoke`,
    sheets: `${base}/v4/spreadsheets`,
    drive: `${base}/drive/v3/files`,
  };
}

export interface GoogleContext {
  env: string | undefined;
  endpoints: GoogleEndpoints;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Runs before each request; throws when the run is out of time. */
  beforeCall?: () => void;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

// ---------------------------------------------------------------------------------------------
// Sealed refresh token: `<iv>.<cipher>`, both base64 (no dots in either).
// ---------------------------------------------------------------------------------------------

export async function sealRefreshToken(key: SecretBoxKey, token: string): Promise<string> {
  const sealed = await sealSecret(key, token, TOKEN_AAD);
  return `${sealed.iv}.${sealed.cipher}`;
}

/** Throws `SecretBoxOpenError` when the ciphertext is damaged or was sealed under another key. */
export async function openRefreshToken(key: SecretBoxKey, stored: string): Promise<string> {
  const dot = stored.indexOf('.');
  return openSecret(key, { iv: stored.slice(0, dot), cipher: stored.slice(dot + 1) }, TOKEN_AAD);
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

async function callRaw(ctx: GoogleContext, url: string, init: GuardedInit) {
  ctx.beforeCall?.();
  return guardedFetch(url, init, {
    env: ctx.env,
    ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }),
  });
}

async function callJson(ctx: GoogleContext, surface: Surface, url: string, init: GuardedInit): Promise<Record<string, unknown>> {
  const r = await callRaw(ctx, url, init);
  const f = classify(surface, r);
  if (f) throw new GoogleError(f);
  if (r.kind !== 'response') throw new GoogleError(failure('backoff', 'bad_response'));
  try {
    const value: unknown = JSON.parse(r.text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // reported below
  }
  throw new GoogleError(failure('backoff', 'bad_response'));
}

const form = (fields: Record<string, string>): GuardedInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

// ---------------------------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------------------------

export interface CodeExchange {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  scope: string;
}

/** Throws `GoogleError`. A 200 without an access token is `bad_response`. */
export async function exchangeCode(ctx: GoogleContext, client: OAuthClient, params: { code: string; verifier: string; redirectUri: string }): Promise<CodeExchange> {
  const body = await callJson(
    ctx,
    'token',
    ctx.endpoints.token,
    form({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    }),
  );
  if (typeof body['access_token'] !== 'string' || body['access_token'] === '') throw new GoogleError(failure('backoff', 'bad_response'));
  return {
    accessToken: body['access_token'],
    refreshToken: typeof body['refresh_token'] === 'string' && body['refresh_token'] !== '' ? body['refresh_token'] : null,
    idToken: typeof body['id_token'] === 'string' ? body['id_token'] : null,
    scope: typeof body['scope'] === 'string' ? body['scope'] : '',
  };
}

export async function refreshAccessToken(ctx: GoogleContext, client: OAuthClient, refreshToken: string): Promise<{ accessToken: string; newRefreshToken: string | null }> {
  const body = await callJson(
    ctx,
    'token',
    ctx.endpoints.token,
    form({ grant_type: 'refresh_token', client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken }),
  );
  if (typeof body['access_token'] !== 'string' || body['access_token'] === '') throw new GoogleError(failure('backoff', 'bad_response'));
  return { accessToken: body['access_token'], newRefreshToken: typeof body['refresh_token'] === 'string' && body['refresh_token'] !== '' ? body['refresh_token'] : null };
}

/** `done` when Google no longer holds the grant (200, or the token is already invalid). */
export async function revokeToken(ctx: GoogleContext, token: string): Promise<'done' | 'retry'> {
  const r = await callRaw(ctx, ctx.endpoints.revoke, form({ token }));
  if (r.kind !== 'response') return 'retry';
  if (r.status >= 200 && r.status < 300) return 'done';
  if (r.status === 400) {
    try {
      if ((JSON.parse(r.text) as { error?: unknown }).error === 'invalid_token') return 'done';
    } catch {
      return 'retry';
    }
  }
  return 'retry';
}

/** The claims of an id_token received directly from the token endpoint over TLS. Null if malformed. */
export function decodeIdToken(jwt: string): Record<string, unknown> | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0)));
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Drive and Sheets
// ---------------------------------------------------------------------------------------------

export interface TabProperties {
  sheetId: number;
  title: string;
  rightToLeft?: boolean;
  gridProperties?: { rowCount?: number; columnCount?: number; frozenRowCount?: number };
}

export interface ValueRange {
  range?: string;
  values?: string[][];
}

export class GoogleApi {
  private readonly ctx: GoogleContext;
  private readonly bearer: Record<string, string>;

  constructor(ctx: GoogleContext, accessToken: string) {
    this.ctx = ctx;
    this.bearer = { Authorization: `Bearer ${accessToken}` };
  }

  private post(surface: Surface, url: string, body: unknown): Promise<Record<string, unknown>> {
    return callJson(this.ctx, surface, url, { method: 'POST', headers: { ...this.bearer, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  private get(surface: Surface, url: string): Promise<Record<string, unknown>> {
    return callJson(this.ctx, surface, url, { method: 'GET', headers: this.bearer });
  }

  /** Files carrying `createKey`, not trashed, oldest first. */
  async findByCreateKey(createKey: string): Promise<{ id: string }[]> {
    const q = `appProperties has { key='${CREATE_KEY_PROPERTY}' and value='${createKey}' } and trashed=false`;
    const url = `${this.ctx.endpoints.drive}?${new URLSearchParams({ q, orderBy: 'createdTime', fields: 'files(id,createdTime)', spaces: 'drive' })}`;
    const body = await this.get('drive', url);
    return Array.isArray(body['files']) ? (body['files'] as { id: string }[]).filter((f) => typeof f?.id === 'string') : [];
  }

  async createSpreadsheet(name: string, createKey: string): Promise<string> {
    const body = await this.post('drive', `${this.ctx.endpoints.drive}?fields=id`, { name, mimeType: SPREADSHEET_MIME, appProperties: { [CREATE_KEY_PROPERTY]: createKey } });
    if (typeof body['id'] !== 'string') throw new GoogleError(failure('backoff', 'bad_response'));
    return body['id'];
  }

  async isTrashed(fileId: string): Promise<boolean> {
    const body = await this.get('drive', `${this.ctx.endpoints.drive}/${encodeURIComponent(fileId)}?fields=id,trashed`);
    return body['trashed'] === true;
  }

  async tabs(spreadsheetId: string): Promise<TabProperties[]> {
    const fields = 'sheets(properties(sheetId,title,rightToLeft,gridProperties(rowCount,columnCount,frozenRowCount)))';
    const body = await this.get('sheets', `${this.ctx.endpoints.sheets}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`);
    const sheets = Array.isArray(body['sheets']) ? (body['sheets'] as { properties?: TabProperties }[]) : null;
    if (!sheets) throw new GoogleError(failure('backoff', 'bad_response'));
    return sheets.map((s) => s.properties).filter((p): p is TabProperties => typeof p?.sheetId === 'number' && typeof p.title === 'string');
  }

  batchUpdate(spreadsheetId: string, requests: unknown[]): Promise<Record<string, unknown>> {
    return this.post('sheets', `${this.ctx.endpoints.sheets}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, { requests });
  }

  async read(spreadsheetId: string, ranges: string[]): Promise<ValueRange[]> {
    const query = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
    const body = await this.get('sheets', `${this.ctx.endpoints.sheets}/${encodeURIComponent(spreadsheetId)}/values:batchGet?${query}`);
    if (!Array.isArray(body['valueRanges'])) throw new GoogleError(failure('backoff', 'bad_response'));
    return body['valueRanges'] as ValueRange[];
  }

  /** Always `RAW`: a customer's text is never evaluated as a formula. */
  write(spreadsheetId: string, data: { range: string; values: (string | number | null)[][] }[]): Promise<Record<string, unknown>> {
    return this.post('sheets', `${this.ctx.endpoints.sheets}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, { valueInputOption: 'RAW', data });
  }
}
