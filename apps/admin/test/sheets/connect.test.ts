// SHEET-3: the connect flow against the real stand-in and a real D1. Numbers in test names are the
// contract's checks (artifacts/SHEET-0/contract.md §4).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { importSecretBoxKey } from '@hb/db/secret-box';
import { openRefreshToken, resolveGoogleEndpoints, sealRefreshToken } from '../../../jobs/src/sheets/google.ts';
import { startStandin, type Standin } from '../../../jobs/test/sheets/standin-harness.ts';
import { runSheetsSync } from '../../../jobs/src/sheets/run.ts';
import { form, harness, postAs, USERS, type Harness } from '../helpers.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const REDIRECT = 'http://127.0.0.1:9/sheets/callback';
const OWNER = USERS.owner;

let h: Harness;
let s: Standin;

beforeAll(async () => {
  h = await harness();
  s = await startStandin();
});
afterAll(async () => {
  await s?.stop();
  await h?.close();
});

type Conn = Record<string, unknown>;
const conn = async () => (await h.db.prepare('SELECT * FROM sheets_connection WHERE id=1').first<Conn>())!;
const setConn = (set: string, ...binds: unknown[]) => h.db.prepare(`UPDATE sheets_connection SET ${set} WHERE id=1`).bind(...binds).run();
const revocations = async () => (await h.db.prepare('SELECT token_enc, google_sub FROM sheets_revocations ORDER BY id').all<{ token_enc: string; google_sub: string }>()).results;
const auditActions = async () => (await h.db.prepare("SELECT action, before, after FROM audit_log WHERE action LIKE 'sheets.%' ORDER BY id").all<{ action: string; before: string | null; after: string | null }>()).results;
const tokenCalls = async () => (await s.calls()).filter((c) => c.path === '/token');
const revokeCalls = async () => (await s.calls()).filter((c) => c.path === '/revoke');
const until = async (cond: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 20));
};

beforeEach(async () => {
  await s.reset();
  // audit_log is append-only, so the tests read only the newest rows.
  await h.db.batch([
    h.db.prepare('DELETE FROM sheets_revocations'),
    h.db.prepare(`UPDATE sheets_connection SET status='disconnected', google_email=NULL, google_sub=NULL, refresh_token_enc=NULL, create_key=NULL, spreadsheet_id=NULL, tab_id=NULL, lang=NULL, generation=1, lease_owner=NULL, lease_until=NULL, failure_count=0, next_attempt_at=NULL, last_error_code=NULL, last_error_at=NULL, layout_note=NULL, scan_fingerprint=NULL, last_scan_at=NULL`),
  ]);
  Object.assign(h.env, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REDIRECT_URI: REDIRECT, GOOGLE_STANDIN_URL: s.url, COURIER_KEYS_KEY: KEY, ENV: 'test' });
});

afterEach(() => vi.restoreAllMocks());

interface Flow {
  state: string;
  cookie: string;
  auth: URL;
  rawCookie: string;
}

async function begin(email: string = OWNER): Promise<Flow> {
  const res = await h.as(email, '/sheets/connect');
  expect(res.status).toBe(302);
  const auth = new URL(res.headers.get('location') ?? '');
  const raw = res.headers.get('set-cookie') ?? '';
  const nonce = /hb_sheets_oauth=([^;]+)/.exec(raw)?.[1] ?? '';
  return { state: auth.searchParams.get('state') ?? '', cookie: `hb_sheets_oauth=${nonce}`, auth, rawCookie: raw };
}

/** Sends the browser through the stand-in, returning the callback's query. */
async function consent(f: Flow, account: string): Promise<URLSearchParams> {
  await s.post('/consent', { email: account });
  const res = await fetch(f.auth, { redirect: 'manual' });
  return new URL(res.headers.get('location') ?? '').searchParams;
}

const callback = (query: URLSearchParams | string, cookie: string, email: string = OWNER) => h.as(email, `/sheets/callback?${query.toString()}`, { headers: { Cookie: cookie } });

async function connect(account: string = OWNER, email: string = OWNER): Promise<Response> {
  const f = await begin(email);
  return callback(await consent(f, account), f.cookie, email);
}

const resultOf = (res: Response) => new URL(res.headers.get('location') ?? '', 'http://x').searchParams.get('r');

describe('connect', () => {
  test('happy path: 303 to /sheets, encrypted token, new create_key, audit, then the job creates the sheet', async () => {
    const res = await connect();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/sheets?r=connected');
    const c = await conn();
    expect(c).toMatchObject({ status: 'connected', google_email: OWNER, lang: 'fr', generation: 2, failure_count: 0, spreadsheet_id: null });
    expect(c['create_key']).toBeTruthy();
    expect(String(c['refresh_token_enc'])).not.toMatch(/standin-rt-/);
    const token = await openRefreshToken(await importSecretBoxKey(KEY), c['refresh_token_enc'] as string);
    expect(token).toMatch(/^standin-rt-/);
    const actions = await auditActions();
    expect(actions.at(-1)?.action).toBe('sheets.connect');
    expect(actions.at(-1)?.after).not.toContain(OWNER);
    await runSheetsSync({ DB: h.db, ENV: 'test', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_STANDIN_URL: s.url, COURIER_KEYS_KEY: KEY });
    expect((await conn())['spreadsheet_id']).toBeTruthy();
  });

  test('admin in Arabic gets an Arabic sheet; case-insensitive email match', async () => {
    const res = await connect('Owner-AR@test.LOCAL', USERS.ownerAr);
    expect(resultOf(res)).toBe('connected');
    expect((await conn())['lang']).toBe('ar');
  });

  test('the authorize URL carries the right parameters', async () => {
    const f = await begin();
    const p = f.auth.searchParams;
    expect(p.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive.file');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('login_hint')).toBe(OWNER);
    expect(p.get('redirect_uri')).toBe(REDIRECT);
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(f.auth.origin).toBe(s.url);
  });

  test('1: wrong account: refused, nothing stored, revoked, audit masked, cookie cleared', async () => {
    const res = await connect('someone.else@gmail.com');
    expect(res.status).toBe(303);
    expect(resultOf(res)).toBe('wrong_account');
    expect(res.headers.get('set-cookie')).toMatch(/hb_sheets_oauth=;/);
    expect(await conn()).toMatchObject({ status: 'disconnected', refresh_token_enc: null });
    await until(async () => (await revokeCalls()).length > 0);
    expect(await revokeCalls()).toHaveLength(1);
    const row = (await auditActions()).at(-1)!;
    expect(row.action).toBe('sheets.connectRefused');
    expect(row.after).toContain('s***@gmail.com');
    expect(row.after).not.toContain('someone.else');
  });

  test('1a: refused token whose account holds a pending revocation: no revoke', async () => {
    const f = await begin();
    const q = await consent(f, 'x@gmail.com');
    await h.db.prepare('INSERT INTO sheets_revocations (token_enc, google_sub, created_at) VALUES (?, ?, 1)').bind('enc', await subFor('x@gmail.com')).run();
    expect(resultOf(await callback(q, f.cookie))).toBe('wrong_account');
    await new Promise((r) => setTimeout(r, 100));
    expect(await revokeCalls()).toEqual([]);
  });

  test('1a: refused token (scope unticked) for the account already live in needs_reconnect: no revoke', async () => {
    await connect();
    await setConn(`status='needs_reconnect'`);
    const f = await begin();
    await s.post('/consent', { email: OWNER, dropScopes: ['https://www.googleapis.com/auth/drive.file'] });
    const q = new URL((await fetch(f.auth, { redirect: 'manual' })).headers.get('location') ?? '').searchParams;
    expect(resultOf(await callback(q, f.cookie))).toBe('scope_missing');
    await new Promise((r) => setTimeout(r, 100));
    expect(await revokeCalls()).toEqual([]);
    expect((await conn())['status']).toBe('needs_reconnect');
  });

  test('1b: callback while connected is refused with zero token calls', async () => {
    const f = await begin();
    const q = await consent(f, OWNER);
    await connect();
    await s.post('/calls/clear');
    expect(resultOf(await callback(q, f.cookie))).toBe('already_connected');
    expect(await tokenCalls()).toEqual([]);
  });

  test('/connect while connected refuses before any redirect', async () => {
    await connect();
    const res = await h.as(OWNER, '/sheets/connect');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/sheets?r=already_connected');
  });

  test('1c: two callbacks past the pre-check: one stores, the other is refused, no revoke for the same account', async () => {
    const f1 = await begin();
    const q1 = await consent(f1, OWNER);
    const f2 = await begin();
    const q2 = await consent(f2, OWNER);
    // Both token exchanges are held, so both callbacks are past the `connected` pre-check before
    // either stores: the loser is refused by the conditional UPDATE, not by the pre-check.
    await s.mode({ path: '/token', mode: 'slow', value: 700, times: 2 });
    await s.post('/calls/clear');
    const [a, b] = await Promise.all([callback(q1, f1.cookie), callback(q2, f2.cookie)]);
    const results = [resultOf(a), resultOf(b)].sort();
    expect(results).toEqual(['already_connected', 'connected']);
    expect(await tokenCalls()).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(await revokeCalls()).toEqual([]);
    expect((await conn())['status']).toBe('connected');
  });

  const refusals: [string, Record<string, unknown>, string][] = [
    ['email_verified false', { email_verified: false }, 'unverified'],
    ['email_verified absent', { remove: ['email_verified'] }, 'unverified'],
    ['email_verified "false"', { email_verified: 'false' }, 'unverified'],
    ['email absent', { remove: ['email'] }, 'bad_token'],
    ['sub absent', { remove: ['sub'] }, 'bad_token'],
    ['bad aud', { aud: 'other' }, 'bad_token'],
    ['bad iss', { iss: 'https://evil.example' }, 'bad_token'],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 10 }, 'bad_token'],
    ['no id_token', { omit: ['id_token'] }, 'bad_token'],
    ['no refresh token', { omit: ['refresh_token'] }, 'no_refresh'],
  ];
  test.each(refusals)('2: %s is refused, nothing stored', async (_n, claims, code) => {
    await s.post('/claims', claims);
    expect(resultOf(await connect())).toBe(code);
    expect(await conn()).toMatchObject({ status: 'disconnected', refresh_token_enc: null });
  });

  test('2: drive.file unticked and denied consent are refused', async () => {
    const f = await begin();
    await s.post('/consent', { email: OWNER, dropScopes: ['https://www.googleapis.com/auth/drive.file'] });
    const q = new URL((await fetch(f.auth, { redirect: 'manual' })).headers.get('location') ?? '').searchParams;
    expect(resultOf(await callback(q, f.cookie))).toBe('scope_missing');
    const f2 = await begin();
    await s.post('/consent', { email: OWNER, decision: 'deny' });
    const q2 = new URL((await fetch(f2.auth, { redirect: 'manual' })).headers.get('location') ?? '').searchParams;
    expect(resultOf(await callback(q2, f2.cookie))).toBe('denied');
    expect(await tokenCalls()).toHaveLength(1);
  });

  test('2: truncated token JSON and Google down give a friendly failure', async () => {
    await s.mode({ path: '/token', mode: 'truncatedJson', times: 1 });
    expect(resultOf(await connect())).toBe('google_unreachable');
    await s.mode({ path: '/token', mode: 'down', times: 1 });
    expect(resultOf(await connect())).toBe('google_unreachable');
    expect((await conn())['status']).toBe('disconnected');
  });

  test.each([
    ['boolean true', { email_verified: true }],
    ['string "true"', { email_verified: 'true' }],
    ['iss without scheme', { iss: 'accounts.google.com' }],
  ])('2a: %s is accepted', async (_n, claims) => {
    await s.post('/claims', claims);
    expect(resultOf(await connect())).toBe('connected');
  });

  test('3: tampered, missing, foreign, expired state: refused before any token call', async () => {
    const f = await begin();
    const q = await consent(f, OWNER);
    const code = q.get('code') ?? '';
    const tampered = new URLSearchParams({ code, state: `${f.state}x` });
    expect(resultOf(await callback(tampered, f.cookie))).toBe('invalid_state');
    expect(resultOf(await callback(new URLSearchParams({ code }), f.cookie))).toBe('invalid_state');
    const noCookie = await h.as(OWNER, `/sheets/callback?${q}`);
    expect(resultOf(noCookie)).toBe('invalid_state');
    const other = await begin();
    expect(resultOf(await callback(q, other.cookie))).toBe('invalid_state');
    const secondOwner = await h.as(USERS.ownerAr, `/sheets/callback?${q}`, { headers: { Cookie: f.cookie } });
    expect(resultOf(secondOwner)).toBe('invalid_state');
    vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ['Date'] });
    expect(resultOf(await callback(q, f.cookie))).toBe('invalid_state');
    vi.useRealTimers();
    expect(await tokenCalls()).toEqual([]);
  });

  test('3a: a hostile error_description is never rendered', async () => {
    const f = await begin();
    const q = new URLSearchParams({ state: f.state, error: '<script>alert(1)</script>', error_description: '<img src=x>' });
    const res = await callback(q, f.cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/sheets?r=google_error');
    const page = await (await h.as(OWNER, '/sheets?r=google_error')).text();
    expect(page).not.toContain('<script>alert');
    expect(page).not.toContain('<img src=x>');
    const unknown = await (await h.as(OWNER, '/sheets?r=<script>x')).text();
    expect(unknown).not.toContain('<script>x');
  });

  test('4: non-owners get 403 on every route, POSTs without CSRF refused', async () => {
    const routes: [string, 'GET' | 'POST'][] = [['/sheets', 'GET'], ['/sheets/connect', 'GET'], ['/sheets/callback', 'GET'], ['/sheets/resync', 'POST'], ['/sheets/new-sheet', 'POST'], ['/sheets/disconnect', 'POST']];
    for (const email of [USERS.confirmer, USERS.logistics, USERS.content]) {
      for (const [path, method] of routes) {
        const res = method === 'GET' ? await h.as(email, path) : await postAs(h, email, path, {});
        expect(res.status, `${email} ${method} ${path}`).toBe(403);
      }
    }
    await connect();
    const noCsrf = await h.as(OWNER, '/sheets/disconnect', form({}));
    expect(noCsrf.status).toBe(403);
    expect((await conn())['status']).toBe('connected');
  });

  test('4a: cookie attributes, and the verifier never in the URL', async () => {
    Object.assign(h.env, { ENV: 'development' });
    const dev = await begin();
    expect(dev.rawCookie).toMatch(/hb_sheets_oauth=[^;]+/);
    expect(dev.rawCookie).toMatch(/HttpOnly/i);
    expect(dev.rawCookie).toMatch(/SameSite=Lax/i);
    expect(dev.rawCookie).toMatch(/Path=\/sheets/i);
    expect(dev.rawCookie).toMatch(/Max-Age=600/i);
    expect(dev.rawCookie).not.toMatch(/Secure/i);
    const nonce = dev.cookie.split('=')[1]!;
    expect(dev.auth.searchParams.get('code_verifier')).toBeNull();
    expect(dev.auth.searchParams.get('code_challenge')).not.toBe(nonce);
    expect(dev.state).toContain(nonce); // the nonce alone derives nothing without CSRF_SECRET
    Object.assign(h.env, { ENV: 'test' });
    const cleared = await connect();
    expect(cleared.headers.get('set-cookie')).toMatch(/hb_sheets_oauth=;/);
  });

  test('4a: Secure in production', async () => {
    Object.assign(h.env, { ENV: 'production', GOOGLE_REDIRECT_URI: 'https://admin.example/sheets/callback', ACCESS_TEAM_DOMAIN: 'https://t.cloudflareaccess.com' });
    const res = await h.as(OWNER, '/sheets/connect');
    const raw = res.headers.get('set-cookie') ?? '';
    Object.assign(h.env, { ENV: 'test', GOOGLE_REDIRECT_URI: REDIRECT });
    expect(res.status).toBe(302);
    expect(raw).toMatch(/Secure/i);
    expect(new URL(res.headers.get('location') ?? '').origin).toBe('https://accounts.google.com');
  });

  test('5: secrets appear in no response, HTML, console line, audit row or error', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const bodies: string[] = [];
    const keep = async (r: Response) => {
      bodies.push(r.headers.get('location') ?? '', r.headers.get('set-cookie') ?? '', await r.clone().text());
      return r;
    };
    await keep(await connect());
    await keep(await h.as(OWNER, '/sheets'));
    await runSheetsSync({ DB: h.db, ENV: 'test', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_STANDIN_URL: s.url, COURIER_KEYS_KEY: KEY });
    await setConn(`status='needs_reconnect'`);
    await keep(await connect());
    await keep(await h.as(OWNER, '/sheets'));
    await keep(await postAs(h, OWNER, '/sheets/disconnect', {}));
    await keep(await h.as(OWNER, '/sheets'));
    const secrets = await s.issuedSecrets();
    expect(secrets.length).toBeGreaterThanOrEqual(4);
    const audit = JSON.stringify(await auditActions());
    const everything = [...lines, ...bodies, audit].join('\n');
    for (const secret of secrets) {
      // A secret value (or the code in the URL we 303 away from) must not be echoed anywhere.
      expect(everything.includes(secret), `leaked ${secret.slice(0, 16)}`).toBe(false);
    }
  });

  test('6: not connected: /sheets offers connect, makes no Google call', async () => {
    const page = await (await h.as(OWNER, '/sheets')).text();
    expect(page).toContain('href="/sheets/connect"');
    expect((await s.calls())).toEqual([]);
  });

  test.each([
    ['client id', { GOOGLE_CLIENT_ID: '' }],
    ['client secret', { GOOGLE_CLIENT_SECRET: '' }],
    ['redirect uri', { GOOGLE_REDIRECT_URI: '' }],
    ['key', { COURIER_KEYS_KEY: '' }],
    ['non-loopback stand-in', { GOOGLE_STANDIN_URL: 'https://sheets.googleapis.com' }],
    ['no stand-in', { GOOGLE_STANDIN_URL: '' }],
  ])('6a: off when %s is missing: page shows off, connect does not redirect to Google', async (_n, over) => {
    Object.assign(h.env, over);
    const page = await h.as(OWNER, '/sheets');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain('href="/sheets/connect"');
    const res = await h.as(OWNER, '/sheets/connect');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/sheets?r=off');
    expect((await s.calls())).toEqual([]);
  });

  test('6a: a redirect URI that is not the callback, or not loopback outside production, is off', async () => {
    Object.assign(h.env, { GOOGLE_REDIRECT_URI: 'https://evil.example/sheets/callback' });
    expect((await h.as(OWNER, '/sheets/connect')).headers.get('location')).toBe('/sheets?r=off');
    Object.assign(h.env, { GOOGLE_REDIRECT_URI: 'http://127.0.0.1:9/other' });
    expect((await h.as(OWNER, '/sheets/connect')).headers.get('location')).toBe('/sheets?r=off');
  });

  test('6b: redirect_uri or PKCE mismatch at /token is refused', async () => {
    const f = await begin();
    const q = await consent(f, OWNER);
    Object.assign(h.env, { GOOGLE_REDIRECT_URI: 'http://127.0.0.1:10/sheets/callback' });
    expect(resultOf(await callback(q, f.cookie))).toBe('google_unreachable');
    Object.assign(h.env, { GOOGLE_REDIRECT_URI: REDIRECT });
    expect((await conn())['status']).toBe('disconnected');
    const body = (await tokenCalls())[0]!.body as string;
    expect(new URLSearchParams(body).get('code_verifier')).toBeTruthy();
    expect(resolveGoogleEndpoints({ ENV: 'test', GOOGLE_STANDIN_URL: s.url })?.token).toBe(`${s.url}/token`);
  });

  test('25: /sheets renders from D1 while the stand-in is down', async () => {
    await connect();
    await setConn(`last_error_code='network', last_error_at=?`, Date.now());
    await s.mode({ path: '', mode: 'down' });
    await s.post('/calls/clear');
    const res = await h.as(OWNER, '/sheets');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('injoignable');
    expect(await s.calls()).toEqual([]);
  });

  test.each([
    ['internal_error', 'Erreur interne pendant la synchronisation'],
    ['revoke_abandoned', 'depuis votre compte Google'],
  ])('/sheets explains %s in its own words', async (code, text) => {
    await connect();
    await setConn(`last_error_code=?, last_error_at=?, last_success_at=?`, code, Date.now(), Date.now());
    const html = await (await h.as(OWNER, '/sheets')).text();
    expect(html).toContain(text);
    expect(html).not.toContain(`(${code})`);
  });
});

async function subFor(email: string): Promise<string> {
  // The stand-in's `sub` is derived from the email; read it back from a throwaway id_token claim.
  await s.post('/consent', { email });
  const auth = new URLSearchParams({ client_id: 'probe', redirect_uri: REDIRECT, response_type: 'code', scope: 'openid email', access_type: 'offline', prompt: 'consent', state: 's' });
  const code = new URL((await fetch(`${s.url}/o/oauth2/v2/auth?${auth}`, { redirect: 'manual' })).headers.get('location') ?? '').searchParams.get('code') ?? '';
  const r = await fetch(`${s.url}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'probe', client_secret: 'x', grant_type: 'authorization_code', code, redirect_uri: REDIRECT }) });
  const idToken = ((await r.json()) as { id_token: string }).id_token;
  await s.post('/calls/clear');
  return (JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString()) as { sub: string }).sub;
}

describe('status × action (16c)', () => {
  const seal = async (t: string) => sealRefreshToken(await importSecretBoxKey(KEY), t);
  const set = (status: string, extra = '') => setConn(`status='${status}', failure_count=3, next_attempt_at=9999999999999, spreadsheet_id='sheet-1', tab_id=0, create_key='key-1', google_sub='sub-a', refresh_token_enc='enc-a'${extra}`);
  const post = (path: string) => postAs(h, OWNER, path, {});

  test('disconnected: resync, new-sheet and disconnect are not allowed', async () => {
    for (const p of ['/sheets/resync', '/sheets/new-sheet', '/sheets/disconnect']) {
      expect(resultOf(await post(p))).toBe('not_allowed');
    }
    expect((await conn())['status']).toBe('disconnected');
  });

  test.each([['connected'], ['sheet_lost'], ['layout_changed']])('%s: resync: connected, generation + 1, counters reset, sheet kept', async (status) => {
    await set(status);
    const g = (await conn())['generation'] as number;
    expect(resultOf(await post('/sheets/resync'))).toBe('resync');
    expect(await conn()).toMatchObject({ status: 'connected', generation: g + 1, failure_count: 0, next_attempt_at: null, spreadsheet_id: 'sheet-1', create_key: 'key-1' });
  });

  test.each([['connected'], ['sheet_lost'], ['layout_changed']])('%s: new-sheet: connected, new key, sheet cleared, lang from the admin', async (status) => {
    await set(status);
    const g = (await conn())['generation'] as number;
    expect(resultOf(await post('/sheets/new-sheet'))).toBe('new_sheet');
    const c = await conn();
    expect(c).toMatchObject({ status: 'connected', generation: g + 1, spreadsheet_id: null, tab_id: null, failure_count: 0, next_attempt_at: null, lang: 'fr' });
    expect(c['create_key']).not.toBe('key-1');
  });

  test('needs_reconnect: resync and new-sheet are not allowed', async () => {
    await set('needs_reconnect');
    expect(resultOf(await post('/sheets/resync'))).toBe('not_allowed');
    expect(resultOf(await post('/sheets/new-sheet'))).toBe('not_allowed');
    expect((await conn())['status']).toBe('needs_reconnect');
  });

  test.each([['needs_reconnect'], ['sheet_lost'], ['layout_changed']])('%s: connect, same account keeps sheet, key and generation, resets counters, keeps lang', async (status) => {
    const sub = await subFor(OWNER);
    await setConn(`status='${status}', failure_count=2, next_attempt_at=9999999999999, spreadsheet_id='sheet-1', tab_id=0, create_key='key-1', google_sub=?, google_email=?, refresh_token_enc='enc', lang='ar'`, sub, OWNER);
    const g = (await conn())['generation'] as number;
    expect(resultOf(await connect())).toBe('reconnected');
    expect(await conn()).toMatchObject({ status: 'connected', spreadsheet_id: 'sheet-1', tab_id: 0, create_key: 'key-1', generation: g, failure_count: 0, next_attempt_at: null, lang: 'ar' });
    expect(await revocations()).toEqual([]);
  });

  test.each([['needs_reconnect'], ['sheet_lost'], ['layout_changed']])('19b: %s: connect another account: new sheet and the old grant queued for revocation', async (status) => {
    const enc = await seal('old-token');
    await setConn(`status='${status}', spreadsheet_id='sheet-1', tab_id=0, create_key='key-1', google_sub='sub-other', google_email='old@gmail.com', refresh_token_enc=?, lang='ar', failure_count=1`, enc);
    const g = (await conn())['generation'] as number;
    expect(resultOf(await connect())).toBe('reconnected');
    const c = await conn();
    expect(c).toMatchObject({ status: 'connected', spreadsheet_id: null, tab_id: null, generation: g + 1, lang: 'fr', failure_count: 0 });
    expect(c['create_key']).not.toBe('key-1');
    expect(await revocations()).toEqual([{ token_enc: enc, google_sub: 'sub-other' }]);
  });

  test('disconnected: connect always starts a new sheet', async () => {
    const sub = await subFor(OWNER);
    await setConn(`google_sub=?, spreadsheet_id='sheet-1', create_key='key-1'`, sub);
    const g = (await conn())['generation'] as number;
    expect(resultOf(await connect())).toBe('connected');
    const c = await conn();
    expect(c).toMatchObject({ spreadsheet_id: null, generation: g + 1 });
    expect(c['create_key']).not.toBe('key-1');
  });

  test.each([['connected'], ['needs_reconnect'], ['sheet_lost'], ['layout_changed']])('%s: disconnect moves the token to a revocation', async (status) => {
    await set(status);
    const enc = (await conn())['refresh_token_enc'];
    const g = (await conn())['generation'] as number;
    expect(resultOf(await post('/sheets/disconnect'))).toBe('disconnected');
    expect(await conn()).toMatchObject({ status: 'disconnected', refresh_token_enc: null, google_sub: null, spreadsheet_id: null, generation: g + 1 });
    expect(await revocations()).toEqual([{ token_enc: enc, google_sub: 'sub-a' }]);
    expect((await auditActions()).at(-1)?.action).toBe('sheets.disconnect');
  });
});

describe('disconnect and revocation (17, 18)', () => {
  test('17: disconnect with the stand-in down returns at once; no Google call in the request', async () => {
    await connect();
    await s.mode({ path: '', mode: 'down' });
    await s.post('/calls/clear');
    const res = await postAs(h, OWNER, '/sheets/disconnect', {});
    expect(resultOf(res)).toBe('disconnected');
    expect((await conn())['refresh_token_enc']).toBeNull();
    expect(await revocations()).toHaveLength(1);
    expect(await s.calls()).toEqual([]);
  });

  test('18: disconnect, then connect the same account, revocation pending: revocation deleted, new token works', async () => {
    await connect();
    await postAs(h, OWNER, '/sheets/disconnect', {});
    expect(await revocations()).toHaveLength(1);
    expect(resultOf(await connect())).toBe('connected');
    expect(await revocations()).toEqual([]);
    await s.post('/calls/clear');
    await runSheetsSync({ DB: h.db, ENV: 'test', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_STANDIN_URL: s.url, COURIER_KEYS_KEY: KEY });
    expect((await s.calls()).some((c) => c.path === '/revoke')).toBe(false);
    expect((await conn())['spreadsheet_id']).toBeTruthy();
  });

  test('18a: disconnect A, connect B, disconnect B: two revocations; a live connection to another account stays', async () => {
    await connect();
    await postAs(h, OWNER, '/sheets/disconnect', {});
    await connect(USERS.ownerAr, USERS.ownerAr);
    expect(await revocations()).toHaveLength(1);
    await postAs(h, USERS.ownerAr, '/sheets/disconnect', {});
    expect(await revocations()).toHaveLength(2);
  });

  test('19a: needs_reconnect then disconnect', async () => {
    await connect();
    await setConn(`status='needs_reconnect'`);
    await s.post('/revoke', { email: OWNER });
    expect(resultOf(await postAs(h, OWNER, '/sheets/disconnect', {}))).toBe('disconnected');
    await s.post('/calls/clear');
    await runSheetsSync({ DB: h.db, ENV: 'test', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_STANDIN_URL: s.url, COURIER_KEYS_KEY: KEY });
    expect(await revokeCalls()).toHaveLength(1);
    expect(await revocations()).toEqual([]);
  });
});
