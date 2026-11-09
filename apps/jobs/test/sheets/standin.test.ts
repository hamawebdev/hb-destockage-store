// SHEET-1: the stand-in behaves like the Google endpoints the integration depends on.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startStandin, type Standin } from './standin-harness.ts';

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const MIME = 'application/vnd.google-apps.spreadsheet';
const REDIRECT = 'http://127.0.0.1:9/sheets/callback';
const VERIFIER = 'verifier-verifier-verifier-verifier-verifier-1234';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

let s: Standin;

beforeAll(async () => {
  s = await startStandin();
});
afterAll(async () => s.stop());
beforeEach(async () => s.reset());

function authUrl(extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({
    client_id: 'cid',
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: `openid email ${DRIVE_FILE}`,
    access_type: 'offline',
    prompt: 'consent',
    state: 'st',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...extra,
  });
  return `${s.url}/o/oauth2/v2/auth?${p}`;
}

async function getCode(email = 'owner@gmail.com', dropScopes: string[] = []): Promise<string> {
  await s.post('/consent', { email, dropScopes });
  const r = await fetch(authUrl(), { redirect: 'manual' });
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get('location') ?? '');
  expect(loc.searchParams.get('state')).toBe('st');
  return loc.searchParams.get('code') ?? '';
}

function token(fields: Record<string, string>): Promise<Response> {
  return fetch(`${s.url}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'cid', client_secret: 'sec', ...fields }) });
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  scope: string;
}

async function exchange(code: string): Promise<Tokens> {
  const r = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER });
  expect(r.status).toBe(200);
  return (await r.json()) as Tokens;
}

async function login(email = 'owner@gmail.com'): Promise<Tokens> {
  return exchange(await getCode(email));
}

const claimsOf = (idToken: string): Record<string, unknown> => JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

function api(at: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${s.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${at}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createSheet(at: string, key = 'k1'): Promise<string> {
  const r = await api(at, 'POST', '/drive/v3/files?fields=id', { name: 'Commandes', mimeType: MIME, appProperties: { hb_create_key: key } });
  expect(r.status).toBe(200);
  return ((await r.json()) as { id: string }).id;
}

const write = (at: string, id: string, data: unknown[], valueInputOption = 'RAW'): Promise<Response> => api(at, 'POST', `/v4/spreadsheets/${id}/values:batchUpdate`, { valueInputOption, data });

async function read(at: string, id: string, ...ranges: string[]): Promise<{ range: string; values?: string[][] }[]> {
  const q = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const r = await api(at, 'GET', `/v4/spreadsheets/${id}/values:batchGet?${q}`);
  expect(r.status).toBe(200);
  return ((await r.json()) as { valueRanges: { range: string; values?: string[][] }[] }).valueRanges;
}

describe('OAuth', () => {
  test('code flow returns tokens and an id_token with the account claims', async () => {
    const t = await login();
    expect(t.refresh_token).toMatch(/^standin-rt-/);
    expect(t.scope).toContain(DRIVE_FILE);
    const claims = claimsOf(t.id_token);
    expect(claims).toMatchObject({ iss: 'https://accounts.google.com', aud: 'cid', email: 'owner@gmail.com', email_verified: true });
    expect(typeof claims['sub']).toBe('string');
  });

  test('deny redirects with access_denied and state', async () => {
    await s.post('/consent', { email: 'x@gmail.com', decision: 'deny' });
    const r = await fetch(authUrl(), { redirect: 'manual' });
    const loc = new URL(r.headers.get('location') ?? '');
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st');
    expect(loc.searchParams.has('code')).toBe(false);
  });

  test('unticked scope is absent, and without it the APIs say insufficient scope in each envelope', async () => {
    const t = await exchange(await getCode('o@gmail.com', [DRIVE_FILE]));
    expect(t.scope).not.toContain(DRIVE_FILE);
    const drive = (await (await api(t.access_token, 'POST', '/drive/v3/files', { name: 'x', mimeType: MIME })).json()) as { error: { errors: { reason: string }[] } };
    expect(drive.error.errors[0]?.reason).toBe('insufficientPermissions');
    const sheets = (await (await api(t.access_token, 'GET', '/v4/spreadsheets/nope')).json()) as { error: { status: string; details: { reason: string }[] } };
    expect(sheets.error.status).toBe('PERMISSION_DENIED');
    expect(sheets.error.details[0]?.reason).toBe('ACCESS_TOKEN_SCOPE_INSUFFICIENT');
  });

  test('code is one-time; wrong redirect_uri or PKCE verifier are rejected', async () => {
    const code = await getCode();
    expect((await token({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:9/other', code_verifier: VERIFIER })).status).toBe(400);
    expect((await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER })).status).toBe(400); // spent
    const code2 = await getCode();
    const bad = await token({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, code_verifier: 'wrong' });
    expect(await bad.json()).toMatchObject({ error: 'invalid_grant' });
    const code3 = await getCode();
    const mismatch = await token({ grant_type: 'authorization_code', code: code3, redirect_uri: 'http://127.0.0.1:9/other', code_verifier: VERIFIER });
    expect(await mismatch.json()).toMatchObject({ error: 'redirect_uri_mismatch' });
  });

  test('claims override and omit apply to the next issue only', async () => {
    await s.post('/claims', { email_verified: 'true', iss: 'accounts.google.com', remove: ['sub'], omit: ['refresh_token'] });
    const t = (await exchange(await getCode())) as Partial<Tokens> & Tokens;
    expect(t.refresh_token).toBeUndefined();
    expect(claimsOf(t.id_token)).toMatchObject({ email_verified: 'true', iss: 'accounts.google.com' });
    expect(claimsOf(t.id_token)['sub']).toBeUndefined();
    expect(claimsOf((await login()).id_token)['email_verified']).toBe(true);
  });

  test('refresh, rotation, and revoke of the whole grant', async () => {
    const t = await login();
    const r1 = (await (await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).json()) as Tokens;
    expect(r1.access_token).toMatch(/^standin-at-/);
    expect(r1.refresh_token).toBeUndefined();
    await s.post('/settings', { rotateRefresh: true });
    const r2 = (await (await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).json()) as Tokens;
    expect(r2.refresh_token).toMatch(/^standin-rt-/);

    const form = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
    expect((await fetch(`${s.url}/revoke`, { ...form, body: new URLSearchParams({ token: t.refresh_token }) })).status).toBe(200);
    expect(await (await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).json()).toMatchObject({ error: 'invalid_grant' });
    expect(await (await token({ grant_type: 'refresh_token', refresh_token: r2.refresh_token })).json()).toMatchObject({ error: 'invalid_grant' });
    expect((await api(r2.access_token, 'GET', '/drive/v3/files?q=')).status).toBe(401);
    const again = await fetch(`${s.url}/revoke`, { ...form, body: new URLSearchParams({ token: t.refresh_token }) });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_token' });
  });

  test('invalid_client', async () => {
    await s.post('/settings', { clientSecret: 'right' });
    const r = await token({ grant_type: 'refresh_token', refresh_token: 'x' });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: 'invalid_client' });
  });

  test('consent page escapes hostile parameters and posts a usable form', async () => {
    const html = await (await fetch(authUrl({ login_hint: '"><script>alert(1)</script>' }))).text();
    expect(html).not.toContain('<script>alert');
    const form = new URLSearchParams({ client_id: 'cid', redirect_uri: REDIRECT, scope: 'openid', state: 'st', decision: 'grant', email: 'a@gmail.com', 'grant:openid': 'on' });
    const r = await fetch(`${s.url}/o/oauth2/v2/auth`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy();
  });
});

describe('Drive', () => {
  test('create, adopt by appProperties oldest first, get trashed', async () => {
    const { access_token: at } = await login();
    const first = await createSheet(at, 'k1');
    await createSheet(at, 'other');
    const second = await createSheet(at, 'k1');
    const q = encodeURIComponent("appProperties has { key='hb_create_key' and value='k1' } and trashed=false");
    const list = (await (await api(at, 'GET', `/drive/v3/files?q=${q}&orderBy=createdTime&fields=${encodeURIComponent('files(id,createdTime)')}`)).json()) as { files: { id: string }[] };
    expect(list.files.map((f) => f.id)).toEqual([first, second]);
    await s.action({ action: 'trash', id: first });
    const after = (await (await api(at, 'GET', `/drive/v3/files?q=${q}`)).json()) as { files: { id: string }[] };
    expect(after.files.map((f) => f.id)).toEqual([second]);
    expect(await (await api(at, 'GET', `/drive/v3/files/${first}?fields=trashed`)).json()).toEqual({ trashed: true });
  });

  test('unknown file 404 in the Drive envelope, unsupported query 400', async () => {
    const { access_token: at } = await login();
    const r = (await (await api(at, 'GET', '/drive/v3/files/none')).json()) as { error: { code: number; errors: { reason: string }[] } };
    expect(r.error.code).toBe(404);
    expect(r.error.errors[0]?.reason).toBe('notFound');
    expect((await api(at, 'GET', `/drive/v3/files?q=${encodeURIComponent("name contains 'x'")}`)).status).toBe(400);
  });

  test('another account cannot see the file', async () => {
    const a = await login('a@gmail.com');
    const id = await createSheet(a.access_token);
    const b = await login('b@gmail.com');
    expect((await api(b.access_token, 'GET', `/v4/spreadsheets/${id}`)).status).toBe(404);
  });
});

describe('Sheets', () => {
  let at: string;
  let id: string;
  beforeEach(async () => {
    ({ access_token: at } = await login());
    id = await createSheet(at);
  });

  test('default tab has a locale-dependent title and grid properties', async () => {
    const body = (await (await api(at, 'GET', `/v4/spreadsheets/${id}`)).json()) as { sheets: { properties: { sheetId: number; title: string; gridProperties: { rowCount: number } } }[] };
    expect(body.sheets[0]?.properties).toMatchObject({ sheetId: 0, title: 'Feuille 1', gridProperties: { rowCount: 1000 } });
  });

  test('empty range omits values; trailing blanks trimmed; middle blanks stay', async () => {
    const [empty] = await read(at, id, "'Feuille 1'!1:1");
    expect(empty).not.toHaveProperty('values');
    expect((await write(at, id, [{ range: "'Feuille 1'!A1", values: [['R', '', 'x', '']] }, { range: "'Feuille 1'!A3", values: [['HB-2']] }])).status).toBe(200);
    const [row, col] = await read(at, id, "'Feuille 1'!1:1", "'Feuille 1'!A:A");
    expect(row?.values).toEqual([['R', '', 'x']]);
    expect(col?.values).toEqual([['R'], [], ['HB-2']]);
  });

  test('null skips, empty string clears', async () => {
    await write(at, id, [{ range: "'Feuille 1'!A2", values: [['a', 'b', 'c']] }]);
    await write(at, id, [{ range: "'Feuille 1'!A2", values: [[null, '', 'z']] }]);
    expect((await read(at, id, "'Feuille 1'!2:2"))[0]?.values).toEqual([['a', '', 'z']]);
  });

  test('RAW keeps formulas and phone text; USER_ENTERED evaluates', async () => {
    await write(at, id, [{ range: "'Feuille 1'!A1", values: [['=IMPORTXML("http://x","//a")', '+213560417403', '0560417403']] }]);
    expect((await s.sheet()).rows[0]).toEqual(['=IMPORTXML("http://x","//a")', '+213560417403', '0560417403']);
    await write(at, id, [{ range: "'Feuille 1'!A2", values: [['=1+1']] }], 'USER_ENTERED');
    expect((await s.sheet()).rows[1]?.[0]).toEqual({ formula: '=1+1' });
    expect((await api(at, 'POST', `/v4/spreadsheets/${id}/values:batchUpdate`, { data: [] })).status).toBe(400);
  });

  test('write past the grid is a 400 and applies nothing', async () => {
    const r = await write(at, id, [
      { range: "'Feuille 1'!A1", values: [['ok']] },
      { range: "'Feuille 1'!A1001", values: [['beyond']] },
    ]);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { status: string } }).error.status).toBe('INVALID_ARGUMENT');
    expect((await s.sheet()).rows).toEqual([]);
    expect((await write(at, id, [{ range: "'Feuille 1'!AA1", values: [['x']] }])).status).toBe(400);
    expect((await write(at, id, [{ range: "'Nope'!A1", values: [['x']] }])).status).toBe(400);
  });

  test('insertDimension pushes rows below down, grows the grid, and validates inherit', async () => {
    await write(at, id, [{ range: "'Feuille 1'!A1", values: [['Ref'], ['HB-1'], ['total', 'x']] }]);
    const ins = (start: number, end: number, inheritFromBefore?: boolean): Promise<Response> =>
      api(at, 'POST', `/v4/spreadsheets/${id}:batchUpdate`, { requests: [{ insertDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: start, endIndex: end }, ...(inheritFromBefore === undefined ? {} : { inheritFromBefore }) } }] });
    expect((await ins(2, 3, true)).status).toBe(200);
    const d = await s.sheet();
    expect(d.rowCount).toBe(1001);
    expect(d.rows[3]).toEqual(['total', 'x']);
    expect((await ins(0, 1, true)).status).toBe(400);
    expect((await ins(1001, 1002)).status).toBe(400);
    expect((await ins(1001, 1002, true)).status).toBe(200);
  });

  test('batchUpdate: rename, freeze, RTL, addSheet duplicate 400, unknown request 400, atomic', async () => {
    const r = await api(at, 'POST', `/v4/spreadsheets/${id}:batchUpdate`, { requests: [{ updateSheetProperties: { properties: { sheetId: 0, title: 'الطلبات', gridProperties: { frozenRowCount: 1 }, rightToLeft: true }, fields: 'title,gridProperties.frozenRowCount,rightToLeft' } }, { addSheet: { properties: { title: 'Commandes', gridProperties: { frozenRowCount: 1 } } } }] });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { replies: [unknown, { addSheet: { properties: { sheetId: number; title: string } } }] };
    expect(body.replies[1].addSheet.properties.title).toBe('Commandes');
    expect(await s.sheet()).toMatchObject({ tab: 'الطلبات', frozenRowCount: 1, rightToLeft: true });
    const dup = await api(at, 'POST', `/v4/spreadsheets/${id}:batchUpdate`, { requests: [{ updateSheetProperties: { properties: { sheetId: 0, title: 'Z' }, fields: 'title' } }, { addSheet: { properties: { title: 'Commandes' } } }] });
    expect(dup.status).toBe(400);
    expect((await s.sheet()).tab).toBe('الطلبات');
    expect((await api(at, 'POST', `/v4/spreadsheets/${id}:batchUpdate`, { requests: [{ deleteSheet: {} }] })).status).toBe(400);
  });

  test('quoted titles with apostrophes', async () => {
    await s.action({ action: 'renameTab', to: "L'année" });
    expect((await write(at, id, [{ range: "'L''année'!A1", values: [['x']] }])).status).toBe(200);
    expect((await read(at, id, "'L''année'!A1:A1"))[0]?.values).toEqual([['x']]);
  });
});

describe('manual actions', () => {
  let at: string;
  let id: string;
  beforeEach(async () => {
    ({ access_token: at } = await login());
    id = await createSheet(at);
    await write(at, id, [{ range: "'Feuille 1'!A1", values: [['Ref', 'Nom'], ['HB-3', 'c'], ['HB-1', 'a'], ['HB-2', 'b']] }]);
  });
  const col = async (): Promise<unknown[]> => (await s.sheet()).rows.map((r) => r[0]);

  test('sort keeps the header', async () => {
    await s.action({ action: 'sort', column: 1 });
    expect(await col()).toEqual(['Ref', 'HB-1', 'HB-2', 'HB-3']);
    await s.action({ action: 'sort', column: 1, desc: true });
    expect(await col()).toEqual(['Ref', 'HB-3', 'HB-2', 'HB-1']);
  });

  test('delete, duplicate and insert rows', async () => {
    await s.action({ action: 'deleteRow', row: 2 });
    expect(await col()).toEqual(['Ref', 'HB-1', 'HB-2']);
    await s.action({ action: 'duplicateRow', row: 2 });
    expect(await col()).toEqual(['Ref', 'HB-1', 'HB-1', 'HB-2']);
    await s.action({ action: 'insertRowAbove', row: 1 });
    expect((await s.sheet()).rows[0]).toEqual([]);
    expect((await s.sheet()).rowCount).toBe(1001);
  });

  test('columns: insert before ours, move, delete, rename, duplicate header', async () => {
    await s.action({ action: 'insertColumn', at: 1, header: 'Notes' });
    expect((await s.sheet()).rows[0]).toEqual(['Notes', 'Ref', 'Nom']);
    await s.action({ action: 'moveColumn', from: 3, to: 1 });
    expect((await s.sheet()).rows[0]).toEqual(['Nom', 'Notes', 'Ref']);
    await s.action({ action: 'deleteColumn', at: 2 });
    expect((await s.sheet()).rows[0]).toEqual(['Nom', 'Ref']);
    expect((await s.sheet()).columnCount).toBe(26);
    await s.action({ action: 'renameHeader', column: 2, to: 'Code' });
    await s.action({ action: 'duplicateHeader', column: 2, to: 3 });
    expect((await s.sheet()).rows[0]).toEqual(['Nom', 'Code', 'Code']);
  });

  test('hide and filter leave cells alone', async () => {
    await s.action({ action: 'hide', row: 3 });
    await s.action({ action: 'filter', column: 2, equals: 'c' });
    const d = await s.sheet();
    expect(d.hiddenRows).toEqual(expect.arrayContaining([3, 4]));
    expect(d.rows).toHaveLength(4);
  });

  test('tabs: last tab cannot be deleted; add then delete works', async () => {
    expect((await s.post('/action', { action: 'deleteTab' })).status).toBe(400);
    await s.action({ action: 'addTab', title: 'Autre' });
    await s.action({ action: 'deleteTab', tab: 'Feuille 1' });
    expect((await s.sheet()).tab).toBe('Autre');
  });

  test('trash and restore', async () => {
    await s.action({ action: 'trash', id });
    expect((await s.state()).files[0]?.trashed).toBe(true);
    await s.action({ action: 'restore', id });
    expect((await s.state()).files[0]?.trashed).toBe(false);
  });

  test('revoke control, with and without dropFiles', async () => {
    await s.post('/revoke', { email: 'owner@gmail.com' });
    expect((await api(at, 'GET', `/v4/spreadsheets/${id}`)).status).toBe(401);
    expect((await s.state()).files[0]?.visibleToApp).toBe(true);
    const fresh = (await login()).access_token;
    expect((await api(fresh, 'GET', `/v4/spreadsheets/${id}`)).status).toBe(200);
    await s.post('/revoke', { email: 'owner@gmail.com', dropFiles: true });
    const after = (await login()).access_token;
    const r = await api(after, 'GET', `/v4/spreadsheets/${id}`);
    expect(r.status).toBe(404);
    expect((await api(after, 'GET', `/drive/v3/files/${id}`)).status).toBe(404);
  });

  test('dropFilesOnRevoke applies to the /revoke endpoint', async () => {
    await s.post('/settings', { dropFilesOnRevoke: true });
    const t = await login();
    await fetch(`${s.url}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refresh_token }) });
    expect((await s.state()).files[0]?.visibleToApp).toBe(false);
  });

  test('arm runs an action right after the matching call', async () => {
    await s.post('/arm', { path: 'values:batchGet', action: 'sort', column: 1 });
    const [first] = await read(at, id, "'Feuille 1'!A:A");
    expect(first?.values?.[1]).toEqual(['HB-3']); // the call itself saw the old order
    const [second] = await read(at, id, "'Feuille 1'!A:A");
    expect(second?.values?.[1]).toEqual(['HB-1']);
  });
});

describe('failure modes', () => {
  let at: string;
  let id: string;
  beforeEach(async () => {
    ({ access_token: at } = await login());
    id = await createSheet(at);
    await s.post('/calls/clear');
  });

  test('down closes the connection and is logged as dropped', async () => {
    await s.mode({ path: '/v4/', mode: 'down', times: 1 });
    await expect(api(at, 'GET', `/v4/spreadsheets/${id}`)).rejects.toThrow();
    expect((await api(at, 'GET', `/v4/spreadsheets/${id}`)).status).toBe(200);
    expect((await s.calls())[0]).toMatchObject({ dropped: true });
  });

  test('applyThenDrop applies the write and drops the response', async () => {
    await s.mode({ path: 'values:batchUpdate', mode: 'applyThenDrop', times: 1 });
    await expect(write(at, id, [{ range: "'Feuille 1'!A1", values: [['applied']] }])).rejects.toThrow();
    expect((await s.sheet()).rows[0]).toEqual(['applied']);
  });

  test('applyThenDrop on Drive create leaves the file', async () => {
    await s.mode({ path: '/drive/v3/files', method: 'POST', mode: 'applyThenDrop', times: 1 });
    await expect(api(at, 'POST', '/drive/v3/files', { name: 'x', mimeType: MIME, appProperties: { hb_create_key: 'drop' } })).rejects.toThrow();
    expect((await s.state()).files.map((f) => f.appProperties['hb_create_key'])).toContain('drop');
  });

  test('slow delays and then answers', async () => {
    await s.mode({ path: '/v4/', mode: 'slow', value: 150, times: 1 });
    const t0 = Date.now();
    expect((await api(at, 'GET', `/v4/spreadsheets/${id}`)).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });

  test('429 carries a raw Retry-After and each API envelope', async () => {
    await s.mode({ path: '/v4/', mode: '429', retryAfter: 'garbage', times: 1 });
    const r = await api(at, 'GET', `/v4/spreadsheets/${id}`);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('garbage');
    expect(((await r.json()) as { error: { status: string } }).error.status).toBe('RESOURCE_EXHAUSTED');
    await s.mode({ path: '/drive/', mode: '403rate', times: 1 });
    const d = (await (await api(at, 'GET', `/drive/v3/files/${id}`)).json()) as { error: { code: number; errors: { reason: string }[] } };
    expect(d.error).toMatchObject({ code: 403 });
    expect(d.error.errors[0]?.reason).toBe('userRateLimitExceeded');
  });

  test('reasons, 404, 401 and 500 in each envelope', async () => {
    await s.mode({ path: '/drive/', mode: 'driveReason', value: 'storageQuotaExceeded', times: 1 });
    const d = (await (await api(at, 'POST', '/drive/v3/files', { name: 'x' })).json()) as { error: { errors: { reason: string }[] } };
    expect(d.error.errors[0]?.reason).toBe('storageQuotaExceeded');
    await s.mode({ path: '/v4/', mode: 'sheetsReason', value: 'SERVICE_DISABLED', times: 1 });
    const sr = (await (await api(at, 'GET', `/v4/spreadsheets/${id}`)).json()) as { error: { status: string; details: { reason: string }[] } };
    expect(sr.error.details[0]?.reason).toBe('SERVICE_DISABLED');
    for (const [mode, status] of [['404', 404], ['401', 401], ['500', 500]] as const) {
      await s.mode({ path: '/v4/', mode, times: 1 });
      expect((await api(at, 'GET', `/v4/spreadsheets/${id}`)).status).toBe(status);
    }
  });

  test('non-JSON, truncated JSON, redirect, token errors', async () => {
    await s.mode({ path: '/token', mode: 'nonJson', times: 1 });
    expect((await token({ grant_type: 'refresh_token', refresh_token: 'x' })).status).toBe(502);
    await s.mode({ path: '/token', mode: 'truncatedJson', times: 1 });
    await expect((await token({ grant_type: 'refresh_token', refresh_token: 'x' })).json()).rejects.toThrow();
    await s.mode({ path: '/v4/', mode: 'redirect', value: 'https://sheets.googleapis.com/x', times: 1 });
    const r = await fetch(`${s.url}/v4/spreadsheets/${id}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://sheets.googleapis.com/x');
    await s.mode({ path: '/token', mode: 'tokenError', value: 'invalid_client', times: 1 });
    expect((await token({ grant_type: 'refresh_token', refresh_token: 'x' })).status).toBe(401);
  });

  test('call log records method, path, body and status', async () => {
    await write(at, id, [{ range: "'Feuille 1'!A1", values: [['x']] }]);
    const calls = await s.calls();
    expect(calls[0]).toMatchObject({ method: 'POST', path: `/v4/spreadsheets/${id}/values:batchUpdate`, status: 200 });
    expect((calls[0]?.body as { valueInputOption: string }).valueInputOption).toBe('RAW');
  });

  test('unknown routes are not silently accepted', async () => {
    expect((await api(at, 'GET', `/v4/spreadsheets/${id}/values/A1`)).status).toBe(404);
  });
});
