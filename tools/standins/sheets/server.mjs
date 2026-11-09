#!/usr/bin/env node
// Google stand-in for the Sheets integration (SHEET-1, contract artifacts/SHEET-0/contract.md §1).
// Node, no dependencies, loopback only: OAuth, the Drive v3 and Sheets v4 subset the job uses, and
// a /__control/ API for tests and walks. Holds no real credentials and contacts nothing.
//
//   node tools/standins/sheets/server.mjs --port 4420     (0 = ephemeral; prints the URL)
//
// Control (JSON; row and column numbers are 1-based, as in the Sheets UI):
//   GET  /__control/state | /__control/calls | /__control/sheet?id=&tab=
//   POST /__control/reset | /__control/calls/clear | /__control/mode/clear
//   POST /__control/mode     {path, method?, mode, value?, retryAfter?, times?}
//        modes: down slow 401 429 403rate 500 404 nonJson truncatedJson applyThenDrop redirect
//               sheetsReason driveReason tokenError
//   POST /__control/consent  {email, decision?: grant|deny, dropScopes?, sticky?}
//   POST /__control/claims   {aud?, iss?, exp?, email?, email_verified?, sub?, remove?, omit?}
//   POST /__control/settings {dropFilesOnRevoke?, rotateRefresh?, clientSecret?}
//   POST /__control/action   {action, id?, tab?, ...args}  (see ACTIONS)
//   POST /__control/arm      {path, method?, action, ...args}  runs an action right after the next matching call
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
const DEFAULT_ROWS = 1000;
const DEFAULT_COLS = 26;
const MAX_BODY = 16 * 1024 * 1024;

const rand = (prefix) => `${prefix}${randomBytes(12).toString('hex')}`;
const b64url = (input) => Buffer.from(input).toString('base64url');
const subOf = (email) => `sub-${createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 21)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function freshState() {
  return {
    codes: new Map(),
    refreshIndex: new Map(),
    accessIndex: new Map(),
    files: new Map(),
    calls: [],
    modes: [],
    armed: [],
    consent: null,
    claims: null,
    settings: { dropFilesOnRevoke: false, rotateRefresh: false, clientSecret: null },
    seq: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Responses and error envelopes (each API's real shape)
// ---------------------------------------------------------------------------------------------

const json = (status, body, headers = {}) => ({ status, text: JSON.stringify(body), headers: { 'Content-Type': 'application/json; charset=UTF-8', ...headers } });
const html = (status, text) => ({ status, text, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

function sheetsError(code, status, message, reason) {
  const error = { code, message, status };
  if (reason) error.details = [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com' }];
  return json(code, { error });
}

function driveError(code, reason, message) {
  return json(code, { error: { code, message, errors: [{ domain: 'global', reason, message }] } });
}

const tokenError = (status, error, description) => json(status, { error, error_description: description ?? error });

class Bad extends Error {
  constructor(message) {
    super(message);
    this.message = message;
  }
}

const surfaceOf = (path) => (path.startsWith('/v4/') ? 'sheets' : path.startsWith('/drive/') ? 'drive' : 'token');

/** A mode-produced failure, in the error shape of the API that was called. */
function modeResponse(mode, surface) {
  const retry = mode.retryAfter === undefined ? {} : { 'Retry-After': String(mode.retryAfter) };
  const withRetry = (r) => ({ ...r, headers: { ...r.headers, ...retry } });
  switch (mode.mode) {
    case '401':
      if (surface === 'sheets') return sheetsError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
      if (surface === 'drive') return driveError(401, 'authError', 'Invalid Credentials');
      return tokenError(401, 'invalid_client');
    case '429':
      if (surface === 'sheets') return withRetry(sheetsError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.', 'RATE_LIMIT_EXCEEDED'));
      if (surface === 'drive') return withRetry(driveError(429, 'rateLimitExceeded', 'Rate limit exceeded'));
      return withRetry(tokenError(429, 'rate_limited'));
    case '403rate':
      if (surface === 'drive') return withRetry(driveError(403, mode.value ?? 'userRateLimitExceeded', 'User rate limit exceeded'));
      return withRetry(sheetsError(403, 'PERMISSION_DENIED', 'Rate limited.', 'RATE_LIMIT_EXCEEDED'));
    case '500':
      if (surface === 'sheets') return sheetsError(500, 'INTERNAL', 'Internal error encountered.');
      if (surface === 'drive') return driveError(500, 'internalError', 'Internal Error');
      return tokenError(500, 'internal_failure');
    case '404':
      if (surface === 'sheets') return sheetsError(404, 'NOT_FOUND', 'Requested entity was not found.');
      if (surface === 'drive') return driveError(404, 'notFound', 'File not found.');
      return html(404, 'Not Found');
    case 'nonJson':
      return html(502, '<html><body>502 Bad Gateway</body></html>');
    case 'truncatedJson':
      return { status: 200, text: '{"access_tok', headers: { 'Content-Type': 'application/json' } };
    case 'redirect':
      return { status: 302, text: '', headers: { Location: mode.value ?? 'https://sheets.googleapis.com/' } };
    case 'sheetsReason':
      return sheetsError(403, 'PERMISSION_DENIED', 'Denied.', mode.value);
    case 'driveReason':
      return driveError(403, mode.value, 'Denied.');
    case 'tokenError':
      return tokenError(mode.value === 'invalid_client' ? 401 : 400, mode.value);
    default:
      return null;
  }
}

function takeMode(state, method, path) {
  const i = state.modes.findIndex((m) => path.includes(m.path) && (!m.method || m.method === method));
  if (i < 0) return null;
  const mode = state.modes[i];
  if (mode.times !== undefined && --mode.times <= 0) state.modes.splice(i, 1);
  return mode;
}

// ---------------------------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------------------------

function consentRedirect(p, decision, email, dropScopes, state) {
  const target = new URL(p.get('redirect_uri'));
  const stateParam = p.get('state');
  if (stateParam !== null) target.searchParams.set('state', stateParam);
  if (decision === 'deny') {
    target.searchParams.set('error', 'access_denied');
    return { status: 302, text: '', headers: { Location: target.toString() } };
  }
  const dropped = new Set(dropScopes);
  const scopes = (p.get('scope') ?? '').split(/\s+/).filter((s) => s && !dropped.has(s));
  const code = rand('standin-code-');
  state.codes.set(code, {
    clientId: p.get('client_id'),
    redirectUri: p.get('redirect_uri'),
    scopes,
    email,
    offline: p.get('access_type') === 'offline',
    challenge: p.get('code_challenge'),
    challengeMethod: p.get('code_challenge_method'),
  });
  target.searchParams.set('code', code);
  return { status: 302, text: '', headers: { Location: target.toString() } };
}

function authorize(state, url, method, form) {
  if (method === 'POST') {
    const decision = form.get('decision') === 'deny' ? 'deny' : 'grant';
    const dropped = (form.get('scope') ?? '').split(/\s+/).filter((s) => s && form.get(`grant:${s}`) !== 'on');
    return consentRedirect(form, decision, form.get('email') ?? '', dropped, state);
  }
  const p = url.searchParams;
  for (const required of ['client_id', 'redirect_uri', 'scope']) {
    if (!p.get(required)) return html(400, `Error 400: missing ${esc(required)}`);
  }
  if (p.get('response_type') !== 'code') return html(400, 'Error 400: response_type must be code');
  try {
    new URL(p.get('redirect_uri'));
  } catch {
    return html(400, 'Error 400: invalid redirect_uri');
  }
  if (state.consent) {
    const c = state.consent;
    if (!c.sticky) state.consent = null;
    return consentRedirect(p, c.decision ?? 'grant', c.email, c.dropScopes ?? [], state);
  }
  const hidden = [...p.entries()].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const scopes = (p.get('scope') ?? '').split(/\s+/).filter(Boolean);
  const boxes = scopes
    .map((s) => `<p><label><input type="checkbox" name="grant:${esc(s)}" checked> ${esc(s)}</label></p>`)
    .join('');
  return html(
    200,
    `<!doctype html><meta charset="utf-8"><title>Google stand-in</title><h1>Google stand-in: consent</h1>
<form method="post" action="/o/oauth2/v2/auth">${hidden}
<p><label>Account email <input name="email" value="${esc(p.get('login_hint') ?? '')}" required></label></p>${boxes}
<p><button name="decision" value="grant">Allow</button> <button name="decision" value="deny">Cancel</button></p></form>`,
  );
}

const tokenScope = (scopes) => scopes.map((s) => (s === 'email' ? EMAIL_SCOPE : s)).join(' ');

function idToken(state, grant) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://accounts.google.com',
    azp: grant.clientId,
    aud: grant.clientId,
    sub: subOf(grant.email),
    email: grant.email,
    email_verified: true,
    iat: now,
    exp: now + 3600,
  };
  const override = state.claims ?? {};
  for (const [k, v] of Object.entries(override)) {
    if (k !== 'remove' && k !== 'omit') claims[k] = v;
  }
  for (const k of override.remove ?? []) delete claims[k];
  return `${b64url(JSON.stringify({ alg: 'RS256', kid: 'standin', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.${b64url('standin-signature')}`;
}

function issueAccess(state, grant) {
  const token = rand('standin-at-');
  state.accessIndex.set(token, grant);
  grant.tokens.add(token);
  return token;
}

function issueRefresh(state, grant) {
  const token = rand('standin-rt-');
  state.refreshIndex.set(token, grant);
  grant.tokens.add(token);
  return token;
}

function tokenEndpoint(state, form) {
  const clientId = form.get('client_id');
  const secret = form.get('client_secret');
  if (!clientId || !secret || (state.settings.clientSecret !== null && secret !== state.settings.clientSecret)) {
    return tokenError(401, 'invalid_client', 'The OAuth client was not found.');
  }
  const omit = new Set(state.claims?.omit ?? []);
  const grantType = form.get('grant_type');
  if (grantType === 'authorization_code') {
    const code = form.get('code');
    const pending = code ? state.codes.get(code) : undefined;
    if (!pending) return tokenError(400, 'invalid_grant', 'Malformed auth code.');
    state.codes.delete(code);
    if (pending.clientId !== clientId) return tokenError(400, 'invalid_grant', 'Code was issued to another client.');
    if (pending.redirectUri !== form.get('redirect_uri')) return tokenError(400, 'redirect_uri_mismatch', 'Bad Request');
    if (pending.challenge) {
      const verifier = form.get('code_verifier');
      const computed = verifier ? createHash('sha256').update(verifier).digest('base64url') : '';
      if (pending.challengeMethod !== 'S256' || computed !== pending.challenge) {
        return tokenError(400, 'invalid_grant', 'Invalid code verifier.');
      }
    }
    const grant = { clientId, email: pending.email, sub: subOf(pending.email), scopes: pending.scopes, tokens: new Set() };
    const body = { access_token: issueAccess(state, grant), expires_in: 3599, scope: tokenScope(pending.scopes), token_type: 'Bearer' };
    if (pending.offline) body.refresh_token = issueRefresh(state, grant);
    if (pending.scopes.includes('openid')) body.id_token = idToken(state, grant);
    for (const k of omit) delete body[k];
    state.claims = null;
    return json(200, body);
  }
  if (grantType === 'refresh_token') {
    const grant = state.refreshIndex.get(form.get('refresh_token') ?? '');
    if (!grant || grant.clientId !== clientId) return tokenError(400, 'invalid_grant', 'Token has been expired or revoked.');
    const body = { access_token: issueAccess(state, grant), expires_in: 3599, scope: tokenScope(grant.scopes), token_type: 'Bearer' };
    if (state.settings.rotateRefresh) body.refresh_token = issueRefresh(state, grant);
    for (const k of omit) delete body[k];
    return json(200, body);
  }
  return tokenError(400, 'unsupported_grant_type', 'Invalid grant_type.');
}

function dropFilesOf(state, sub) {
  for (const f of state.files.values()) {
    if (f.ownerSub === sub) f.visibleToApp = false;
  }
}

function killGrant(state, grant, dropFiles) {
  for (const t of grant.tokens) {
    state.refreshIndex.delete(t);
    state.accessIndex.delete(t);
  }
  grant.tokens.clear();
  if (dropFiles) dropFilesOf(state, grant.sub);
}

function revokeEndpoint(state, form) {
  const token = form.get('token') ?? '';
  const grant = state.refreshIndex.get(token) ?? state.accessIndex.get(token);
  if (!grant) return tokenError(400, 'invalid_token', 'Token expired or revoked');
  killGrant(state, grant, state.settings.dropFilesOnRevoke);
  return { status: 200, text: '', headers: {} };
}

// ---------------------------------------------------------------------------------------------
// Drive v3
// ---------------------------------------------------------------------------------------------

function grantFrom(state, req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return m ? state.accessIndex.get(m[1]) : undefined;
}

const hasFileScope = (grant) => grant.scopes.includes(DRIVE_FILE_SCOPE);

function visibleFile(state, grant, id) {
  const f = state.files.get(id);
  return f && f.ownerSub === grant.sub && f.visibleToApp ? f : null;
}

function splitFields(fields) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of fields) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out.map((f) => f.trim()).filter(Boolean);
}

function pick(obj, fields) {
  if (Array.isArray(obj)) return obj.map((o) => pick(o, fields));
  const out = {};
  for (const f of splitFields(fields)) {
    const m = /^([^(]+)\((.*)\)$/.exec(f);
    if (m && obj[m[1]] !== undefined) out[m[1]] = pick(obj[m[1]], m[2]);
    else if (obj[f] !== undefined) out[f] = obj[f];
  }
  return out;
}

function fileResource(f) {
  return {
    kind: 'drive#file',
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    trashed: f.trashed,
    createdTime: new Date(f.createdMs).toISOString(),
    appProperties: f.appProperties,
    webViewLink: `https://docs.google.com/spreadsheets/d/${f.id}/edit`,
  };
}

const DEFAULT_FILE_FIELDS = 'kind,id,name,mimeType';

function matchesDriveQuery(f, q) {
  let rest = q;
  const prop = /appProperties\s+has\s*\{\s*key\s*=\s*'([^']*)'\s+and\s+value\s*=\s*'([^']*)'\s*\}/g;
  let ok = true;
  rest = rest.replace(prop, (_all, key, value) => {
    if (f.appProperties[key] !== value) ok = false;
    return '';
  });
  rest = rest.replace(/trashed\s*=\s*(true|false)/g, (_all, value) => {
    if (f.trashed !== (value === 'true')) ok = false;
    return '';
  });
  if (rest.replace(/\band\b/g, '').trim() !== '') throw new Bad(`Invalid query: ${q}`);
  return ok;
}

function newSpreadsheet() {
  return { tabs: [{ sheetId: 0, title: 'Feuille 1', rowCount: DEFAULT_ROWS, columnCount: DEFAULT_COLS, frozenRowCount: 0, rightToLeft: false, cells: [], hiddenRows: [] }] };
}

function driveFiles(state, req, url, jsonBody, id) {
  const grant = grantFrom(state, req);
  if (!grant) return driveError(401, 'authError', 'Invalid Credentials');
  if (!hasFileScope(grant)) return driveError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.');
  const fields = url.searchParams.get('fields') ?? DEFAULT_FILE_FIELDS;
  if (req.method === 'POST' && !id) {
    const meta = jsonBody ?? {};
    const fileId = rand('standin-file-');
    const file = {
      id: fileId,
      name: meta.name ?? 'Untitled',
      mimeType: meta.mimeType ?? 'application/octet-stream',
      appProperties: meta.appProperties ?? {},
      createdMs: Date.now() + state.seq++,
      trashed: false,
      ownerSub: grant.sub,
      visibleToApp: true,
      spreadsheet: meta.mimeType === SPREADSHEET_MIME ? newSpreadsheet() : null,
    };
    state.files.set(fileId, file);
    return json(200, pick(fileResource(file), fields));
  }
  if (req.method === 'GET' && !id) {
    const q = url.searchParams.get('q') ?? '';
    const orderBy = url.searchParams.get('orderBy');
    let files = [...state.files.values()].filter((f) => f.ownerSub === grant.sub && f.visibleToApp);
    try {
      matchesDriveQuery({ appProperties: {}, trashed: false }, q); // reject a bad query even with no files
      files = files.filter((f) => matchesDriveQuery(f, q));
    } catch (e) {
      return driveError(400, 'invalid', e.message);
    }
    files.sort((a, b) => (orderBy === 'createdTime desc' ? b.createdMs - a.createdMs : a.createdMs - b.createdMs));
    const listFields = url.searchParams.get('fields') ?? `kind,incompleteSearch,files(${DEFAULT_FILE_FIELDS})`;
    return json(200, pick({ kind: 'drive#fileList', incompleteSearch: false, files: files.map(fileResource) }, listFields));
  }
  if (req.method === 'GET' && id) {
    const file = visibleFile(state, grant, id);
    if (!file) return driveError(404, 'notFound', `File not found: ${id}.`);
    return json(200, pick(fileResource(file), fields));
  }
  return driveError(405, 'methodNotAllowed', 'Method not allowed.');
}

// ---------------------------------------------------------------------------------------------
// Sheets v4
// ---------------------------------------------------------------------------------------------

const colIndex = (letters) => {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

const colLetters = (index) => {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

const quoteTitle = (t) => `'${t.replace(/'/g, "''")}'`;

function parseRange(ss, a1) {
  const m = /^(?:'((?:[^']|'')+)'|([^!']+))!(.+)$/.exec(a1);
  let tab;
  let rest = a1;
  if (m) {
    const title = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
    tab = ss.tabs.find((t) => t.title === title);
    if (!tab) throw new Bad(`Unable to parse range: ${a1}`);
    rest = m[3];
  } else {
    tab = ss.tabs.find((t) => t.title === a1);
    if (tab) rest = '';
    else [tab] = ss.tabs;
  }
  if (rest === '') return { tab, r0: 0, c0: 0, r1: tab.rowCount, c1: tab.columnCount, bounded: false };
  const p = /^([A-Za-z]+)?(\d+)?(?::([A-Za-z]+)?(\d+)?)?$/.exec(rest);
  if (!p || (p[1] === undefined && p[2] === undefined)) throw new Bad(`Unable to parse range: ${a1}`);
  const hasColon = rest.includes(':');
  const c0 = p[1] !== undefined ? colIndex(p[1]) : 0;
  const r0 = p[2] !== undefined ? Number(p[2]) - 1 : 0;
  if (r0 < 0 || c0 < 0) throw new Bad(`Unable to parse range: ${a1}`);
  if (!hasColon) {
    if (p[1] === undefined || p[2] === undefined) throw new Bad(`Unable to parse range: ${a1}`);
    return { tab, r0, c0, r1: r0 + 1, c1: c0 + 1, bounded: false };
  }
  const c1 = p[3] !== undefined ? colIndex(p[3]) + 1 : tab.columnCount;
  const r1 = p[4] !== undefined ? Number(p[4]) : tab.rowCount;
  if (r1 <= r0 || c1 <= c0) throw new Bad(`Unable to parse range: ${a1}`);
  return { tab, r0, c0, r1, c1, bounded: true };
}

const rangeLabel = (rng) => `${quoteTitle(rng.tab.title)}!${colLetters(rng.c0)}${rng.r0 + 1}:${colLetters(Math.min(rng.c1, rng.tab.columnCount) - 1)}${Math.min(rng.r1, rng.tab.rowCount)}`;

function getCell(tab, r, c) {
  return tab.cells[r]?.[c];
}

function setCell(tab, r, c, value) {
  while (tab.cells.length <= r) tab.cells.push([]);
  if (value === undefined) delete tab.cells[r][c];
  else tab.cells[r][c] = value;
}

function formatted(cell, render) {
  if (cell === undefined) return '';
  if (typeof cell === 'object') return cell.formula;
  if (render === 'UNFORMATTED_VALUE') return cell;
  return typeof cell === 'string' ? cell : String(cell);
}

function readRange(rng, render) {
  const rows = [];
  const lastRow = Math.min(rng.r1, rng.tab.rowCount);
  const lastCol = Math.min(rng.c1, rng.tab.columnCount);
  for (let r = rng.r0; r < lastRow; r++) {
    const row = [];
    for (let c = rng.c0; c < lastCol; c++) row.push(formatted(getCell(rng.tab, r, c), render));
    while (row.length > 0 && row[row.length - 1] === '') row.pop();
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

function cook(value, inputOption) {
  if (value === '') return undefined;
  if (inputOption === 'RAW' || typeof value !== 'string') return value;
  if (value.startsWith('=')) return { formula: value };
  const asNumber = Number(value);
  return Number.isFinite(asNumber) && value.trim() !== '' ? asNumber : value;
}

function checkWrite(rng, values) {
  for (const [ri, row] of values.entries()) {
    if (!Array.isArray(row)) throw new Bad('Invalid value at data.values: expected an array of rows.');
    for (const [ci, value] of row.entries()) {
      if (value === null) continue;
      if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Bad('Invalid value in data.values.');
      const r = rng.r0 + ri;
      const c = rng.c0 + ci;
      if (r >= rng.tab.rowCount || c >= rng.tab.columnCount) {
        throw new Bad(`Range (${rng.tab.title}!${colLetters(c)}${r + 1}) exceeds grid limits. Max rows: ${rng.tab.rowCount}, max columns: ${rng.tab.columnCount}`);
      }
      if (rng.bounded && (r >= rng.r1 || c >= rng.c1)) throw new Bad('Requested writing outside the range.');
    }
  }
}

function valuesBatchUpdate(file, body) {
  const inputOption = body?.valueInputOption;
  if (inputOption !== 'RAW' && inputOption !== 'USER_ENTERED') throw new Bad("Invalid valueInputOption: must be 'RAW' or 'USER_ENTERED'.");
  const ss = file.spreadsheet;
  const planned = (body.data ?? []).map((d) => ({ rng: parseRange(ss, d.range), values: d.values ?? [], range: d.range }));
  for (const p of planned) checkWrite(p.rng, p.values);
  const responses = [];
  let cells = 0;
  for (const p of planned) {
    let updated = 0;
    p.values.forEach((row, ri) => {
      row.forEach((value, ci) => {
        if (value === null) return;
        setCell(p.rng.tab, p.rng.r0 + ri, p.rng.c0 + ci, cook(value, inputOption));
        updated++;
      });
    });
    cells += updated;
    responses.push({ spreadsheetId: file.id, updatedRange: p.range, updatedRows: p.values.length, updatedCells: updated });
  }
  return json(200, { spreadsheetId: file.id, totalUpdatedRows: planned.reduce((n, p) => n + p.values.length, 0), totalUpdatedCells: cells, totalUpdatedSheets: new Set(planned.map((p) => p.rng.tab.sheetId)).size, responses });
}

function valuesBatchGet(file, url) {
  const ranges = url.searchParams.getAll('ranges');
  if (ranges.length === 0) throw new Bad('Must specify at least one range.');
  const render = url.searchParams.get('valueRenderOption') ?? 'FORMATTED_VALUE';
  const valueRanges = ranges.map((a1) => {
    const rng = parseRange(file.spreadsheet, a1);
    const values = readRange(rng, render);
    const vr = { range: rangeLabel(rng), majorDimension: 'ROWS' };
    if (values.length > 0) vr.values = values;
    return vr;
  });
  return json(200, { spreadsheetId: file.id, valueRanges });
}

const tabProps = (tab, index) => ({
  sheetId: tab.sheetId,
  title: tab.title,
  index,
  sheetType: 'GRID',
  gridProperties: { rowCount: tab.rowCount, columnCount: tab.columnCount, frozenRowCount: tab.frozenRowCount },
  rightToLeft: tab.rightToLeft,
});

function spreadsheetGet(file) {
  return json(200, {
    spreadsheetId: file.id,
    properties: { title: file.name, locale: 'fr_FR' },
    sheets: file.spreadsheet.tabs.map((t, i) => ({ properties: tabProps(t, i) })),
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${file.id}/edit`,
  });
}

function applyUpdateProperties(tabs, u) {
  const tab = tabs.find((t) => t.sheetId === u.properties?.sheetId);
  if (!tab) throw new Bad(`No grid with id: ${u.properties?.sheetId}`);
  for (const field of String(u.fields ?? '').split(',').map((f) => f.trim()).filter(Boolean)) {
    if (field === 'title') {
      if (tabs.some((t) => t !== tab && t.title === u.properties.title)) throw new Bad(`A sheet with the name "${u.properties.title}" already exists.`);
      tab.title = u.properties.title;
    } else if (field === 'gridProperties.frozenRowCount') tab.frozenRowCount = u.properties.gridProperties?.frozenRowCount ?? 0;
    else if (field === 'rightToLeft') tab.rightToLeft = Boolean(u.properties.rightToLeft);
    else throw new Bad(`Unsupported field in the stand-in: ${field}`);
  }
}

function applyAddSheet(tabs, add) {
  const p = add.properties ?? {};
  const title = p.title ?? `Feuille ${tabs.length + 1}`;
  if (tabs.some((t) => t.title === title)) throw new Bad(`A sheet with the name "${title}" already exists.`);
  const tab = {
    sheetId: p.sheetId ?? randomBytes(3).readUIntBE(0, 3),
    title,
    rowCount: p.gridProperties?.rowCount ?? DEFAULT_ROWS,
    columnCount: p.gridProperties?.columnCount ?? DEFAULT_COLS,
    frozenRowCount: p.gridProperties?.frozenRowCount ?? 0,
    rightToLeft: Boolean(p.rightToLeft),
    cells: [],
    hiddenRows: [],
  };
  tabs.push(tab);
  return { addSheet: { properties: tabProps(tab, tabs.length - 1) } };
}

function applyInsertDimension(tabs, ins) {
  const { range, inheritFromBefore } = ins;
  const tab = tabs.find((t) => t.sheetId === range?.sheetId);
  if (!tab) throw new Bad(`No grid with id: ${range?.sheetId}`);
  const { startIndex: start, endIndex: end, dimension } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || start < 0) throw new Bad('Invalid dimension range.');
  const size = dimension === 'ROWS' ? tab.rowCount : tab.columnCount;
  if (start > size) throw new Bad('Invalid dimension range: start index past the end of the grid.');
  if (inheritFromBefore === true && start === 0) throw new Bad('Cannot inherit from before at the start of the grid.');
  if (inheritFromBefore !== true && start === size) throw new Bad('Cannot inherit from after at the end of the grid: set inheritFromBefore.');
  const count = end - start;
  if (dimension === 'ROWS') {
    while (tab.cells.length < start) tab.cells.push([]);
    tab.cells.splice(start, 0, ...Array.from({ length: count }, () => []));
    tab.rowCount += count;
  } else if (dimension === 'COLUMNS') {
    for (const row of tab.cells) {
      if (row.length > start) row.splice(start, 0, ...new Array(count));
    }
    tab.columnCount += count;
  } else throw new Bad('Invalid dimension.');
}

function spreadsheetBatchUpdate(file, body) {
  const requests = body?.requests;
  if (!Array.isArray(requests) || requests.length === 0) throw new Bad('Must specify at least one request.');
  const tabs = structuredClone(file.spreadsheet.tabs);
  const replies = requests.map((req) => {
    if (req.updateSheetProperties) {
      applyUpdateProperties(tabs, req.updateSheetProperties);
      return {};
    }
    if (req.addSheet) return applyAddSheet(tabs, req.addSheet);
    if (req.insertDimension) {
      applyInsertDimension(tabs, req.insertDimension);
      return {};
    }
    throw new Bad(`Unsupported request in the stand-in: ${Object.keys(req).join(',')}`);
  });
  file.spreadsheet.tabs = tabs;
  return json(200, { spreadsheetId: file.id, replies });
}

function sheetsRoute(state, req, url, jsonBody, id, op) {
  const grant = grantFrom(state, req);
  if (!grant) return sheetsError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
  if (!hasFileScope(grant)) return sheetsError(403, 'PERMISSION_DENIED', 'Request had insufficient authentication scopes.', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT');
  const file = visibleFile(state, grant, id);
  if (!file || !file.spreadsheet) return sheetsError(404, 'NOT_FOUND', 'Requested entity was not found.');
  try {
    if (op === 'get' && req.method === 'GET') return spreadsheetGet(file);
    if (op === 'batchUpdate' && req.method === 'POST') return spreadsheetBatchUpdate(file, jsonBody);
    if (op === 'values:batchUpdate' && req.method === 'POST') return valuesBatchUpdate(file, jsonBody);
    if (op === 'values:batchGet' && req.method === 'GET') return valuesBatchGet(file, url);
  } catch (e) {
    if (e instanceof Bad) return sheetsError(400, 'INVALID_ARGUMENT', e.message);
    throw e;
  }
  return sheetsError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
}

// ---------------------------------------------------------------------------------------------
// Control: what a person does by hand in the spreadsheet, and scenario switches
// ---------------------------------------------------------------------------------------------

function targetFile(state, id) {
  const file = id ? state.files.get(id) : [...state.files.values()].at(-1);
  if (!file) throw new Bad('no such file');
  return file;
}

function targetTab(file, tabTitle) {
  const tab = tabTitle ? file.spreadsheet.tabs.find((t) => t.title === tabTitle) : file.spreadsheet.tabs[0];
  if (!tab) throw new Bad('no such tab');
  return tab;
}

function usedRows(tab) {
  let last = tab.cells.length;
  while (last > 0 && !tab.cells[last - 1]?.some((c) => c !== undefined)) last--;
  return last;
}

function compareCells(a, b) {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return String(typeof a === 'object' ? a.formula : a).localeCompare(String(typeof b === 'object' ? b.formula : b));
}

const insertBlankColumn = (tab, at) => {
  for (const row of tab.cells) {
    if (row.length > at) row.splice(at, 0, undefined);
  }
  tab.columnCount++;
};

const removeColumn = (tab, at) => {
  for (const row of tab.cells) {
    if (row.length > at) row.splice(at, 1);
  }
  tab.columnCount--;
};

const ACTIONS = {
  sort(file, tab, a) {
    const col = a.column - 1;
    const start = tab.frozenRowCount || 1;
    const body = tab.cells.slice(start, usedRows(tab));
    body.sort((x, y) => compareCells(x[col], y[col]) * (a.desc ? -1 : 1));
    tab.cells.splice(start, body.length, ...body);
  },
  hide(file, tab, a) {
    tab.hiddenRows.push(a.row);
  },
  filter(file, tab, a) {
    for (let r = 1; r < usedRows(tab); r++) {
      if (String(getCell(tab, r, a.column - 1) ?? '') !== a.equals) tab.hiddenRows.push(r + 1);
    }
  },
  edit(file, tab, a) {
    if (a.formula) setCell(tab, a.row - 1, a.column - 1, { formula: a.value });
    else setCell(tab, a.row - 1, a.column - 1, a.value === null || a.value === '' ? undefined : a.value);
  },
  deleteRow(file, tab, a) {
    if (tab.rowCount <= 1) throw new Bad('cannot delete the only row');
    tab.cells.splice(a.row - 1, 1);
    tab.rowCount--;
  },
  duplicateRow(file, tab, a) {
    const copy = [...(tab.cells[a.row - 1] ?? [])];
    const to = (a.to ?? a.row + 1) - 1;
    while (tab.cells.length < to) tab.cells.push([]);
    tab.cells.splice(to, 0, copy);
    tab.rowCount++;
  },
  insertRowAbove(file, tab, a) {
    while (tab.cells.length < a.row - 1) tab.cells.push([]);
    tab.cells.splice(a.row - 1, 0, []);
    tab.rowCount++;
  },
  insertColumn(file, tab, a) {
    insertBlankColumn(tab, a.at - 1);
    if (a.header !== undefined) setCell(tab, 0, a.at - 1, a.header);
  },
  deleteColumn(file, tab, a) {
    removeColumn(tab, a.at - 1);
  },
  moveColumn(file, tab, a) {
    for (const row of tab.cells) {
      while (row.length < Math.max(a.from, a.to)) row.push(undefined);
      const [cell] = row.splice(a.from - 1, 1);
      row.splice(a.to - 1, 0, cell);
    }
  },
  renameHeader(file, tab, a) {
    setCell(tab, 0, a.column - 1, a.to);
  },
  duplicateHeader(file, tab, a) {
    setCell(tab, 0, a.to - 1, getCell(tab, 0, a.column - 1));
  },
  renameTab(file, tab, a) {
    if (file.spreadsheet.tabs.some((t) => t !== tab && t.title === a.to)) throw new Bad('title taken');
    tab.title = a.to;
  },
  deleteTab(file, tab) {
    if (file.spreadsheet.tabs.length === 1) throw new Bad("You can't remove all the sheets in a document.");
    file.spreadsheet.tabs = file.spreadsheet.tabs.filter((t) => t !== tab);
  },
  addTab(file, tab, a) {
    applyAddSheet(file.spreadsheet.tabs, { properties: { title: a.title } });
  },
  trash(file) {
    file.trashed = true;
  },
  restore(file) {
    file.trashed = false;
  },
};

function runAction(state, a) {
  const file = targetFile(state, a.id);
  const fn = ACTIONS[a.action];
  if (!fn || !Object.hasOwn(ACTIONS, a.action)) throw new Bad(`unknown action: ${a.action}`);
  const tab = file.spreadsheet ? targetTab(file, a.tab) : null;
  fn(file, tab, a);
}

function runArmed(state, method, path) {
  const i = state.armed.findIndex((a) => path.includes(a.path) && (!a.method || a.method === method));
  if (i < 0) return;
  const [a] = state.armed.splice(i, 1);
  runAction(state, a);
}

function revokeAccount(state, email, dropFiles) {
  const sub = subOf(email);
  const grants = new Set([...state.refreshIndex.values(), ...state.accessIndex.values()].filter((g) => g.sub === sub));
  for (const g of grants) killGrant(state, g, false);
  if (dropFiles) dropFilesOf(state, sub);
  return grants.size;
}

function sheetDump(file, tab) {
  return {
    id: file.id,
    name: file.name,
    trashed: file.trashed,
    tab: tab.title,
    sheetId: tab.sheetId,
    rowCount: tab.rowCount,
    columnCount: tab.columnCount,
    frozenRowCount: tab.frozenRowCount,
    rightToLeft: tab.rightToLeft,
    hiddenRows: tab.hiddenRows,
    rows: Array.from({ length: usedRows(tab) }, (_, r) => Array.from({ length: tab.cells[r]?.length ?? 0 }, (_v, c) => tab.cells[r][c] ?? null)),
  };
}

function control(state, reset, method, path, url, body) {
  const route = path.slice('/__control'.length);
  try {
    if (method === 'GET' && route === '/health') return json(200, { ok: true });
    if (method === 'GET' && route === '/calls') return json(200, { calls: state.calls });
    if (method === 'GET' && route === '/state') {
      return json(200, {
        files: [...state.files.values()].map((f) => ({ id: f.id, name: f.name, trashed: f.trashed, visibleToApp: f.visibleToApp, appProperties: f.appProperties, tabs: f.spreadsheet?.tabs.map((t) => t.title) ?? [] })),
        liveRefreshTokens: state.refreshIndex.size,
        modes: state.modes,
        armed: state.armed,
      });
    }
    if (method === 'GET' && route === '/sheet') {
      const file = targetFile(state, url.searchParams.get('id'));
      return json(200, sheetDump(file, targetTab(file, url.searchParams.get('tab'))));
    }
    if (method !== 'POST') return json(405, { error: 'method' });
    if (route === '/reset') {
      reset();
      return json(200, { ok: true });
    }
    if (route === '/calls/clear') {
      state.calls.length = 0;
      return json(200, { ok: true });
    }
    if (route === '/mode/clear') {
      state.modes.length = 0;
      state.armed.length = 0;
      return json(200, { ok: true });
    }
    if (route === '/mode') {
      if (typeof body?.mode !== 'string') throw new Bad('mode required');
      state.modes.push({ path: body.path ?? '', ...body });
      return json(200, { ok: true });
    }
    if (route === '/consent') {
      state.consent = body;
      return json(200, { ok: true });
    }
    if (route === '/claims') {
      state.claims = body;
      return json(200, { ok: true });
    }
    if (route === '/settings') {
      Object.assign(state.settings, body);
      return json(200, { ok: true });
    }
    if (route === '/action') {
      runAction(state, body ?? {});
      return json(200, { ok: true });
    }
    if (route === '/arm') {
      state.armed.push({ path: body.path ?? '', ...body });
      return json(200, { ok: true });
    }
    if (route === '/revoke') return json(200, { revoked: revokeAccount(state, body.email, Boolean(body.dropFiles)) });
    return json(404, { error: 'unknown control route' });
  } catch (e) {
    if (e instanceof Bad) return json(400, { error: e.message });
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function route(state, req, url, path, text, jsonBody) {
  const form = new URLSearchParams(text);
  if (path === '/o/oauth2/v2/auth') return authorize(state, url, req.method, form);
  if (path === '/token' && req.method === 'POST') return tokenEndpoint(state, form);
  if (path === '/revoke' && req.method === 'POST') return revokeEndpoint(state, form);
  if (path === '/drive/v3/files') return driveFiles(state, req, url, jsonBody, null);
  const driveId = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
  if (driveId) return driveFiles(state, req, url, jsonBody, driveId[1]);
  const values = /^\/v4\/spreadsheets\/([^/:]+)\/values:(batchGet|batchUpdate)$/.exec(path);
  if (values) return sheetsRoute(state, req, url, jsonBody, values[1], `values:${values[2]}`);
  const batch = /^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/.exec(path);
  if (batch) return sheetsRoute(state, req, url, jsonBody, batch[1], 'batchUpdate');
  const get = /^\/v4\/spreadsheets\/([^/:]+)$/.exec(path);
  if (get) return sheetsRoute(state, req, url, jsonBody, get[1], 'get');
  return html(404, 'Not Found');
}

function send(res, r) {
  res.writeHead(r.status, { 'Content-Length': Buffer.byteLength(r.text), ...r.headers });
  res.end(r.text);
}

export function startStandin(port = 0) {
  let state = freshState();
  const reset = () => {
    state = freshState();
  };
  const server = createServer((req, res) => {
    (async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;
      const buf = await readBody(req);
      if (buf === null) return send(res, html(413, 'Payload too large'));
      const text = buf.toString('utf8');
      let jsonBody = null;
      if ((req.headers['content-type'] ?? '').includes('application/json') && text !== '') {
        try {
          jsonBody = JSON.parse(text);
        } catch {
          return send(res, json(400, { error: { code: 400, message: 'Invalid JSON payload received.', status: 'INVALID_ARGUMENT' } }));
        }
      }
      if (path.startsWith('/__control/')) return send(res, control(state, reset, req.method, path, url, jsonBody));

      const entry = { at: Date.now(), method: req.method, path, query: url.search, body: jsonBody ?? (text === '' ? null : text), status: null, dropped: false };
      state.calls.push(entry);
      const mode = takeMode(state, req.method, path);
      if (mode?.mode === 'down') {
        entry.dropped = true;
        res.socket?.destroy();
        return undefined;
      }
      if (mode?.mode === 'slow') await sleep(Number(mode.value ?? 30_000));
      const failure = mode ? modeResponse(mode, surfaceOf(path)) : null;
      if (failure) {
        entry.status = failure.status;
        return send(res, failure);
      }
      const result = route(state, req, url, path, text, jsonBody);
      entry.status = result.status;
      runArmed(state, req.method, path);
      if (mode?.mode === 'applyThenDrop') {
        entry.dropped = true;
        res.socket?.destroy();
        return undefined;
      }
      return send(res, result);
    })().catch((e) => {
      console.error('standin error', e);
      if (!res.headersSent) send(res, json(500, { error: { code: 500, message: 'stand-in bug', status: 'INTERNAL' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const i = process.argv.indexOf('--port');
  const { port } = await startStandin(i >= 0 ? Number(process.argv[i + 1]) : 0);
  console.log(`sheets-standin listening on http://127.0.0.1:${port}`);
}
