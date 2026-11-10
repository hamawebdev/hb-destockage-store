// Google Sheets connection (SHEET-3, contract artifacts/SHEET-0/contract.md §2). Owner only.
// Only the callback's code exchange talks to Google in a request; everything else is D1.
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { checkOutboundUrl } from '@hb/couriers/http';
import { sheetsConnection, sheetsRevocations, type SheetsConnection } from '@hb/db';
import { importSecretBoxKey, type SecretBoxKey } from '@hb/db/secret-box';
import { GoogleError } from '../../../../jobs/src/sheets/classify.ts';
import { decodeIdToken, exchangeCode, OAUTH_SCOPES, resolveGoogleEndpoints, revokeToken, SCOPE_DRIVE_FILE, sealRefreshToken, type GoogleContext, type GoogleEndpoints, type OAuthClient } from '../../../../jobs/src/sheets/google.ts';
import { audit, noAudit } from '../../audit/audit.ts';
import { rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv, Env } from '../../env.ts';
import { b64url, hmacSign, hmacVerify } from '../../lib/crypto.ts';
import { createRouter } from '../../lib/router.ts';
import { StatusBadge, type Tone } from '../../ui/badge.tsx';
import { Form, Submit } from '../../ui/form.tsx';
import { Bdi, DateTime, Num } from '../../ui/format.tsx';
import { m } from './messages.ts';

type Ctx = Context<AppEnv>;
type Tr = ReturnType<typeof m>;
type MessageKey = Parameters<Tr>[0];

const COOKIE = 'hb_sheets_oauth';
const COOKIE_PATH = '/sheets';
const FLOW_TTL_S = 600;
const STATE_PREFIX = 'sheets-oauth|';
const PKCE_PREFIX = 'sheets-pkce|';
const EXCHANGE_TIMEOUT_MS = 8_000;
const REVOKE_TIMEOUT_MS = 5_000;
const CHANGED_ONE_ROW = sql`changes() = 1`;

const r = createRouter({ roles: rolesFor('sheets.settings') });

// ---------------------------------------------------------------------------------------------
// Configuration and helpers
// ---------------------------------------------------------------------------------------------

interface AdminConfig {
  endpoints: GoogleEndpoints;
  client: OAuthClient;
  redirectUri: string;
  key: SecretBoxKey;
}

async function adminConfig(env: Env): Promise<AdminConfig | null> {
  const endpoints = resolveGoogleEndpoints(env);
  if (!endpoints || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) return null;
  const uri = checkOutboundUrl(env.GOOGLE_REDIRECT_URI, env.ENV);
  if (!uri.ok || uri.url.pathname !== '/sheets/callback') return null;
  try {
    const key = await importSecretBoxKey(env.COURIER_KEYS_KEY);
    return { endpoints, client: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }, redirectUri: env.GOOGLE_REDIRECT_URI, key };
  } catch {
    return null;
  }
}

const readConnection = async (c: Ctx): Promise<SheetsConnection> => {
  const [row] = await c.var.db.select().from(sheetsConnection).where(eq(sheetsConnection.id, 1)).limit(1);
  if (!row) throw new Error('sheets_connection singleton row is missing');
  return row;
};

const googleContext = (c: Ctx, cfg: AdminConfig, timeoutMs: number): GoogleContext => ({ env: c.env.ENV, endpoints: cfg.endpoints, timeoutMs });

/** `w***@example.com`: enough for an audit trail, without the address. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  return at <= 0 ? '***' : `${email[0]}***${email.slice(at)}`;
}

const back = (c: Ctx, code: string): Response => c.redirect(`/sheets?r=${code}`, 303);

function cookieOptions(c: Ctx) {
  return { path: COOKIE_PATH, httpOnly: true, sameSite: 'Lax', secure: c.env.ENV === 'production' } as const;
}

const pkceVerifier = (secret: string, nonce: string): Promise<string> => hmacSign(secret, `${PKCE_PREFIX}${nonce}`);

async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

const stateBody = (nonce: string, userId: number, expiresAt: number): string => `${nonce}.${userId}.${expiresAt}`;

async function signState(secret: string, nonce: string, userId: number, expiresAt: number): Promise<string> {
  const body = stateBody(nonce, userId, expiresAt);
  return `${body}.${await hmacSign(secret, `${STATE_PREFIX}${body}`)}`;
}

async function verifyState(secret: string, state: string | undefined, nonce: string | undefined, userId: number, now: number): Promise<string | null> {
  if (!state || !nonce) return null;
  const parts = state.split('.');
  if (parts.length !== 4) return null;
  const [stateNonce, id, expires, signature] = parts as [string, string, string, string];
  if (stateNonce !== nonce || Number(id) !== userId || !/^\d+$/.test(expires) || Number(expires) < now) return null;
  return (await hmacVerify(secret, `${STATE_PREFIX}${stateBody(stateNonce, userId, Number(expires))}`, signature)) ? stateNonce : null;
}

function inBackground(c: Ctx, work: Promise<unknown>): void {
  const quiet = work.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(quiet);
  } catch {
    // No ExecutionContext (tests): the promise still runs.
  }
}

// ---------------------------------------------------------------------------------------------
// The connect flow
// ---------------------------------------------------------------------------------------------

r.get('/connect', requirePerm('sheets.settings'), async (c) => {
  const cfg = await adminConfig(c.env);
  if (!cfg) return back(c, 'off');
  if ((await readConnection(c)).status === 'connected') return back(c, 'already_connected');
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const secret = c.env.CSRF_SECRET;
  const state = await signState(secret, nonce, c.var.user.id, Date.now() + FLOW_TTL_S * 1000);
  setCookie(c, COOKIE, nonce, { ...cookieOptions(c), maxAge: FLOW_TTL_S });
  const url = new URL(cfg.endpoints.auth);
  const params = {
    client_id: cfg.client.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    login_hint: c.var.user.email,
    state,
    code_challenge: await pkceChallenge(await pkceVerifier(secret, nonce)),
    code_challenge_method: 'S256',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return c.redirect(url.toString(), 302);
});

type Claims = { email: string; sub: string };
type ClaimCheck = { ok: true; claims: Claims } | { ok: false; code: string; email: string | null; sub: string | null };

function checkClaims(idToken: string | null, clientId: string, now: number, adminEmail: string): ClaimCheck {
  const claims = idToken ? decodeIdToken(idToken) : null;
  if (!claims) return { ok: false, code: 'bad_token', email: null, sub: null };
  const email = typeof claims['email'] === 'string' && claims['email'] !== '' ? claims['email'] : null;
  const sub = typeof claims['sub'] === 'string' && claims['sub'] !== '' ? claims['sub'] : null;
  const fail = (code: string): ClaimCheck => ({ ok: false, code, email, sub });
  const iss = claims['iss'];
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') return fail('bad_token');
  if (claims['aud'] !== clientId) return fail('bad_token');
  if (typeof claims['exp'] !== 'number' || claims['exp'] * 1000 < now) return fail('bad_token');
  if (email === null || sub === null) return fail('bad_token');
  if (claims['email_verified'] !== true && claims['email_verified'] !== 'true') return fail('unverified');
  if (email.trim().toLowerCase() !== adminEmail.trim().toLowerCase()) return fail('wrong_account');
  return { ok: true, claims: { email, sub } };
}

r.get('/callback', requirePerm('sheets.settings'), async (c) => {
  const nonceCookie = getCookie(c, COOKIE);
  deleteCookie(c, COOKIE, cookieOptions(c));
  const cfg = await adminConfig(c.env);
  if (!cfg) return back(c, 'off');
  const user = c.var.user;
  const now = Date.now();
  const nonce = await verifyState(c.env.CSRF_SECRET, c.req.query('state'), nonceCookie, user.id, now);
  if (nonce === null) return back(c, 'invalid_state');
  const googleError = c.req.query('error');
  if (googleError !== undefined) return back(c, googleError === 'access_denied' ? 'denied' : 'google_error');
  const code = c.req.query('code');
  if (!code) return back(c, 'invalid_state');
  const before = await readConnection(c);
  if (before.status === 'connected') return back(c, 'already_connected');

  let tokens;
  try {
    tokens = await exchangeCode(googleContext(c, cfg, EXCHANGE_TIMEOUT_MS), cfg.client, { code, verifier: await pkceVerifier(c.env.CSRF_SECRET, nonce), redirectUri: cfg.redirectUri });
  } catch (e) {
    if (e instanceof GoogleError) return back(c, 'google_unreachable');
    throw e;
  }

  const refuse = async (reason: string, email: string | null, sub: string | null): Promise<Response> => {
    const db = c.var.db;
    await db.batch([audit(c, { action: 'sheets.connectRefused', entity: 'sheets_connection', entityId: 1, after: { reason, email: email === null ? null : maskEmail(email) } })]);
    const issued = tokens.refreshToken ?? tokens.accessToken;
    if (sub !== null) {
      // Revoking removes the whole grant, so never for an account that holds a live or pending one.
      // Read now, not `before`: a concurrent callback may have just stored this account's grant (1c).
      const pending = await db.$count(sheetsRevocations, eq(sheetsRevocations.googleSub, sub));
      const current = await readConnection(c);
      const live = current.status !== 'disconnected' && current.googleSub === sub;
      if (pending === 0 && !live) inBackground(c, revokeToken(googleContext(c, cfg, REVOKE_TIMEOUT_MS), issued));
    }
    return back(c, reason);
  };

  const check = checkClaims(tokens.idToken, cfg.client.clientId, now, user.email);
  if (!check.ok) return refuse(check.code, check.email, check.sub);
  const { email, sub } = check.claims;
  if (!tokens.scope.split(/\s+/).includes(SCOPE_DRIVE_FILE)) return refuse('scope_missing', email, sub);
  if (tokens.refreshToken === null) return refuse('no_refresh', email, sub);

  const sealed = await sealRefreshToken(cfg.key, tokens.refreshToken);
  const db = c.var.db;
  const t = sheetsConnection;
  const sameAccount = sql`(${t.status} <> 'disconnected' AND ${t.googleSub} = ${sub})`;
  const newCreateKey = crypto.randomUUID();
  const results = await db.batch([
    // A different account's still-live grant must stay revocable once its token is overwritten.
    db.insert(sheetsRevocations).select(sql`select null, refresh_token_enc, google_sub, 0, null, ${now} from sheets_connection where id = 1 and status <> 'connected' and refresh_token_enc is not null and google_sub is not null and google_sub <> ${sub}`),
    db
      .update(t)
      .set({
        status: 'connected',
        googleEmail: email,
        googleSub: sub,
        connectedBy: user.id,
        refreshTokenEnc: sealed,
        createKey: sql`case when ${sameAccount} then ${t.createKey} else ${newCreateKey} end`,
        spreadsheetId: sql`case when ${sameAccount} then ${t.spreadsheetId} else null end`,
        tabId: sql`case when ${sameAccount} then ${t.tabId} else null end`,
        lang: sql`case when ${sameAccount} then ${t.lang} else ${user.uiLang} end`,
        generation: sql`case when ${sameAccount} then ${t.generation} else ${t.generation} + 1 end`,
        failureCount: 0,
        nextAttemptAt: null,
        lastErrorCode: null,
        lastErrorAt: null,
        layoutNote: null,
        scanFingerprint: null,
        lastScanAt: null,
        connectedAt: now,
        updatedAt: now,
      })
      .where(and(eq(t.id, 1), ne(t.status, 'connected'))),
    audit(c, { action: 'sheets.connect', entity: 'sheets_connection', entityId: 1, before: { status: before.status }, after: { status: 'connected', email: maskEmail(email) } }, { when: CHANGED_ONE_ROW }),
    // Same account: a pending revocation would kill the grant just stored.
    db.delete(sheetsRevocations).where(and(eq(sheetsRevocations.googleSub, sub), sql`exists (select 1 from sheets_connection where id = 1 and status = 'connected' and google_sub = ${sub} and connected_at = ${now})`)),
  ]);
  const changes = (results[1] as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changes !== 1) return refuse('already_connected', email, sub);
  return back(c, before.status === 'disconnected' ? 'connected' : 'reconnected');
});

// ---------------------------------------------------------------------------------------------
// Actions (status × action table)
// ---------------------------------------------------------------------------------------------

const RESET = { failureCount: 0, nextAttemptAt: null, lastErrorCode: null, lastErrorAt: null, layoutNote: null, scanFingerprint: null, lastScanAt: null };

async function applyAction(c: Ctx, action: string, allowed: readonly SheetsConnection['status'][], set: Partial<typeof sheetsConnection.$inferInsert>, success: string): Promise<Response> {
  const db = c.var.db;
  const t = sheetsConnection;
  const before = await readConnection(c);
  if (!allowed.includes(before.status)) {
    noAudit(c, 'status does not allow this action');
    return back(c, 'not_allowed');
  }
  const now = Date.now();
  const results = await db.batch([
    db
      .update(t)
      .set({ ...RESET, generation: sql`${t.generation} + 1`, status: 'connected', updatedAt: now, ...set })
      .where(and(eq(t.id, 1), eq(t.status, before.status), eq(t.generation, before.generation))),
    audit(c, { action, entity: 'sheets_connection', entityId: 1, before: { status: before.status }, after: { status: set.status ?? 'connected' } }, { when: CHANGED_ONE_ROW }),
  ]);
  if (((results[0] as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) return back(c, 'not_allowed');
  return back(c, success);
}

const LIVE: readonly SheetsConnection['status'][] = ['connected', 'sheet_lost', 'layout_changed'];

r.post('/resync', requirePerm('sheets.settings'), (c) => applyAction(c, 'sheets.resync', LIVE, {}, 'resync'));

r.post('/new-sheet', requirePerm('sheets.settings'), (c) => applyAction(c, 'sheets.newSheet', LIVE, { createKey: crypto.randomUUID(), spreadsheetId: null, tabId: null, lang: c.var.user.uiLang }, 'new_sheet'));

r.post('/disconnect', requirePerm('sheets.settings'), async (c) => {
  const db = c.var.db;
  const t = sheetsConnection;
  const before = await readConnection(c);
  if (before.status === 'disconnected') {
    noAudit(c, 'already disconnected');
    return back(c, 'not_allowed');
  }
  const now = Date.now();
  await db.batch([
    db.insert(sheetsRevocations).select(sql`select null, refresh_token_enc, google_sub, 0, null, ${now} from sheets_connection where id = 1 and status <> 'disconnected' and refresh_token_enc is not null and google_sub is not null`),
    audit(c, { action: 'sheets.disconnect', entity: 'sheets_connection', entityId: 1, before: { status: before.status }, after: { status: 'disconnected' } }, { when: sql`exists (select 1 from sheets_connection where id = 1 and status <> 'disconnected')` }),
    db
      .update(t)
      .set({ ...RESET, status: 'disconnected', googleEmail: null, googleSub: null, refreshTokenEnc: null, createKey: null, spreadsheetId: null, tabId: null, generation: sql`${t.generation} + 1`, updatedAt: now })
      .where(and(eq(t.id, 1), ne(t.status, 'disconnected'))),
  ]);
  return back(c, 'disconnected');
});

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

const RESULT_CODES = new Set(['connected', 'reconnected', 'disconnected', 'resync', 'new_sheet', 'not_allowed', 'off', 'already_connected', 'invalid_state', 'denied', 'google_error', 'google_unreachable', 'wrong_account', 'unverified', 'scope_missing', 'no_refresh', 'bad_token']);
const POSITIVE = new Set(['connected', 'reconnected', 'disconnected', 'resync', 'new_sheet']);
const KNOWN_ERRORS = new Set(['config_missing', 'revoke_abandoned', 'drive_full', 'rate_limited', 'timeout', 'network', 'server_error', 'google_client_config', 'google_config', 'internal_error']);
const STATUS_TONE: Readonly<Record<string, Tone>> = { disconnected: 'neutral', connected: 'success', creating: 'info', needs_reconnect: 'danger', sheet_lost: 'danger', layout_changed: 'warning' };

async function pendingCount(c: Ctx, generation: number): Promise<number> {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM orders o
     LEFT JOIN sheets_rows r ON r.order_id = o.id AND r.generation = ?1
     LEFT JOIN shipments s ON s.id = (SELECT MAX(x.id) FROM shipments x WHERE x.order_id = o.id)
     WHERE r.order_id IS NULL OR r.source_version <> o.version OR r.shipment_stamp IS NOT s.updated_at`,
  )
    .bind(generation)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function sheetLink(env: Env, id: string): string {
  return env.ENV === 'production' || !env.GOOGLE_STANDIN_URL
    ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`
    : `${env.GOOGLE_STANDIN_URL.replace(/\/$/, '')}/__control/sheet?id=${encodeURIComponent(id)}`;
}

function errorText(t: Tr, code: string): string {
  return KNOWN_ERRORS.has(code) ? t(`error.${code}` as MessageKey) : t('error.other', { code });
}

r.get('/', requirePerm('sheets.settings'), async (c) => {
  const t = m(c.var.lang);
  const conn = await readConnection(c);
  const configured = (await adminConfig(c.env)) !== null;
  const creating = conn.status === 'connected' && conn.tabId === null;
  const statusKey = creating ? 'creating' : conn.status;
  const pending = conn.status === 'connected' ? await pendingCount(c, conn.generation) : null;
  const resultParam = c.req.query('r');
  const result = resultParam !== undefined && RESULT_CODES.has(resultParam) ? resultParam : null;
  const canConnect = configured && conn.status !== 'connected';
  const live = conn.status === 'connected' || conn.status === 'sheet_lost' || conn.status === 'layout_changed';
  const help = conn.status === 'needs_reconnect' || conn.status === 'sheet_lost' || conn.status === 'layout_changed' ? t(`help.${conn.status}`) : null;
  return c.render(
    <>
      <p>{t('intro')}</p>
      {result ? (
        <div class={`callout ${POSITIVE.has(result) ? 'callout--success' : 'callout--warning'}`} role="status">
          {t(`r.${result}` as MessageKey, { email: c.var.user.email })}
        </div>
      ) : null}
      {configured ? null : <div class="callout callout--warning">{t('off')}</div>}
      {help ? <div class="callout callout--warning">{help}</div> : null}
      <dl class="meta">
        <dt>{t('field.status')}</dt>
        <dd>
          <StatusBadge tone={STATUS_TONE[statusKey] ?? 'neutral'} label={t(`status.${statusKey}` as MessageKey)} />
        </dd>
        {conn.googleEmail ? (
          <>
            <dt>{t('field.email')}</dt>
            <dd>
              <Bdi>{conn.googleEmail}</Bdi>
            </dd>
          </>
        ) : null}
        {conn.spreadsheetId ? (
          <>
            <dt>{t('field.sheet')}</dt>
            <dd>
              <a href={sheetLink(c.env, conn.spreadsheetId)} rel="noopener noreferrer" target="_blank">
                {t('link.open')}
              </a>
            </dd>
          </>
        ) : null}
        {conn.lang ? (
          <>
            <dt>{t('field.lang')}</dt>
            <dd>{t(`lang.${conn.lang}`)}</dd>
          </>
        ) : null}
        {conn.status === 'disconnected' ? null : (
          <>
            <dt>{t('field.lastSuccess')}</dt>
            <dd>{conn.lastSuccessAt ? <DateTime ms={conn.lastSuccessAt} /> : t('never')}</dd>
          </>
        )}
        {pending !== null ? (
          <>
            <dt>{t('field.pending')}</dt>
            <dd>
              <Num value={pending} />
            </dd>
          </>
        ) : null}
        {conn.lastErrorCode ? (
          <>
            <dt>{t('field.lastError')}</dt>
            <dd>
              {errorText(t, conn.lastErrorCode)}
              {conn.lastErrorAt ? (
                <>
                  {' '}
                  (<DateTime ms={conn.lastErrorAt} />)
                </>
              ) : null}
            </dd>
          </>
        ) : null}
        {conn.layoutNote ? (
          <>
            <dt>{t('field.missingColumns')}</dt>
            <dd>{conn.layoutNote}</dd>
          </>
        ) : null}
      </dl>
      {canConnect ? <p class="field__hint">{t('help.connect', { email: c.var.user.email })}</p> : null}
      <div class="form-actions">
        {canConnect ? (
          <a class="btn btn--primary" href="/sheets/connect">
            {conn.status === 'disconnected' ? t('action.connect') : t('action.reconnect')}
          </a>
        ) : null}
        {live ? (
          <Form action="/sheets/resync">
            <Submit variant="secondary">{t('action.resync')}</Submit>
          </Form>
        ) : null}
        {live ? (
          <Form action="/sheets/new-sheet" confirm={t('confirm.newSheet')}>
            <Submit variant="secondary">{t('action.newSheet')}</Submit>
          </Form>
        ) : null}
        {conn.status === 'disconnected' ? null : (
          <Form action="/sheets/disconnect" confirm={t('confirm.disconnect')}>
            <Submit variant="danger">{t('action.disconnect')}</Submit>
          </Form>
        )}
      </div>
    </>,
    { title: t('title') },
  );
});

export default r;
