#!/usr/bin/env node
// Telegram Bot API stand-in (TGS-3). Node, no dependencies, loopback only: getMe, getUpdates and
// sendMessage with Telegram's real envelopes, and a /__control/ API for tests and walks.
// Holds no real token and contacts nothing. Any syntactically valid token is accepted unless
// /__control/settings names the one to accept.
//
//   node tools/standins/telegram/server.mjs --port 4430     (0 = ephemeral; prints the URL)
//
// Bot API (POST or GET, JSON or form body):
//   /bot<token>/getMe | /bot<token>/getUpdates | /bot<token>/sendMessage
//
// Control (JSON):
//   GET  /__control/state      {bot, down, mode, webhook, pending updates, rejected chats}
//   GET  /__control/sent       messages the "bot" sent: [{chat_id, text, at}]
//   GET  /__control/calls      every Bot API call: [{method, status, dropped, at}] (never the token)
//   POST /__control/reset
//   POST /__control/sent/clear
//   POST /__control/down       every Bot API call fails with a closed connection
//   POST /__control/up
//   POST /__control/mode       {mode: null|'401'|'429'|'500'|'slow', retryAfter?, ms?, times?}
//   POST /__control/update     queue one fake update. Shortcuts:
//                                {private: {id, first_name?, last_name?, username?}}   a user wrote to the bot
//                                {group: {id, title, type?}}                           the bot was added to a group
//                                {left: {id, title?}}                                  the bot was removed
//                                {raw: {...}}                                          any update object (update_id is set here)
//   POST /__control/chat       {id, reject: true|false}  sendMessage to this chat answers 403
//   POST /__control/settings   {token?: string|null, webhook?: boolean, bot?: {id?, username?, first_name?}}
import { createServer } from 'node:http';

const TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/;
const MAX_BODY = 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freshState() {
  return {
    bot: { id: 7000000001, is_bot: true, first_name: 'Stand-in Bot', username: 'standin_orders_bot' },
    token: null,
    webhook: false,
    down: false,
    mode: null,
    updates: [],
    nextUpdateId: 1000,
    sent: [],
    calls: [],
    rejected: new Set(),
    messageId: 0,
  };
}

const json = (status, body) => ({ status, text: JSON.stringify(body) });
const ok = (result) => json(200, { ok: true, result });
const fail = (status, description, parameters) => json(status, { ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) });

function send(res, r) {
  res.writeHead(r.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(r.text) });
  res.end(r.text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

function params(req, url, text) {
  const out = Object.fromEntries(url.searchParams);
  if (text === '') return out;
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    try {
      const body = JSON.parse(text);
      return body && typeof body === 'object' ? { ...out, ...body } : out;
    } catch {
      return null;
    }
  }
  return { ...out, ...Object.fromEntries(new URLSearchParams(text)) };
}

function botApi(state, method, p) {
  if (method === 'getMe') return ok({ ...state.bot, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false });
  if (method === 'getUpdates') {
    if (state.webhook) return fail(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first");
    const offset = p.offset === undefined ? null : Number(p.offset);
    // As Telegram does: an offset confirms (forgets) every update below it.
    if (offset !== null && Number.isFinite(offset)) state.updates = state.updates.filter((u) => u.update_id >= offset);
    const limit = Math.min(100, Math.max(1, Number(p.limit ?? 100) || 100));
    return ok(state.updates.slice(0, limit));
  }
  if (method === 'sendMessage') {
    const chatId = p.chat_id === undefined ? '' : String(p.chat_id);
    const text = typeof p.text === 'string' ? p.text : '';
    if (!/^-?\d+$/.test(chatId)) return fail(400, 'Bad Request: chat not found');
    if (text === '') return fail(400, 'Bad Request: message text is empty');
    if (text.length > 4096) return fail(400, 'Bad Request: message is too long');
    if (state.rejected.has(chatId)) return fail(403, chatId.startsWith('-') ? 'Forbidden: bot was kicked from the group chat' : 'Forbidden: bot was blocked by the user');
    state.messageId += 1;
    state.sent.push({ chat_id: chatId, text, at: Date.now() });
    return ok({ message_id: state.messageId, date: Math.floor(Date.now() / 1000), chat: { id: Number(chatId), type: chatId.startsWith('-') ? 'group' : 'private' }, text });
  }
  return fail(404, 'Not Found: method not found');
}

function queueUpdate(state, body) {
  const update_id = state.nextUpdateId++;
  const date = Math.floor(Date.now() / 1000);
  let update = null;
  if (body?.private && body.private.id !== undefined) {
    const u = body.private;
    const who = { id: Number(u.id), first_name: u.first_name ?? 'Client', ...(u.last_name ? { last_name: u.last_name } : {}), ...(u.username ? { username: u.username } : {}) };
    update = { update_id, message: { message_id: update_id, date, from: { ...who, is_bot: false }, chat: { ...who, type: 'private' }, text: u.text ?? '/start' } };
  } else if (body?.group && body.group.id !== undefined) {
    const g = body.group;
    update = { update_id, my_chat_member: { chat: { id: Number(g.id), title: g.title ?? 'Groupe', type: g.type ?? 'group' }, date, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } } };
  } else if (body?.left && body.left.id !== undefined) {
    update = { update_id, my_chat_member: { chat: { id: Number(body.left.id), title: body.left.title ?? 'Groupe', type: 'group' }, date, old_chat_member: { status: 'member' }, new_chat_member: { status: 'left' } } };
  } else if (body?.raw && typeof body.raw === 'object') {
    update = { ...body.raw, update_id };
  }
  if (!update) return json(400, { error: 'expected {private}, {group}, {left} or {raw}' });
  state.updates.push(update);
  return json(200, { ok: true, update_id });
}

function control(state, reset, method, path, body) {
  const route = path.slice('/__control'.length);
  if (method === 'GET') {
    if (route === '/state') return json(200, { bot: state.bot, down: state.down, mode: state.mode, webhook: state.webhook, tokenPinned: state.token !== null, updates: state.updates, rejected: [...state.rejected], sent: state.sent.length });
    if (route === '/sent') return json(200, state.sent);
    if (route === '/calls') return json(200, state.calls);
    return json(404, { error: 'unknown control route' });
  }
  if (method !== 'POST') return json(405, { error: 'GET or POST' });
  switch (route) {
    case '/reset':
      reset();
      return json(200, { ok: true });
    case '/sent/clear':
      state.sent = [];
      state.calls = [];
      return json(200, { ok: true });
    case '/down':
      state.down = true;
      return json(200, { ok: true, down: true });
    case '/up':
      state.down = false;
      state.mode = null;
      return json(200, { ok: true, down: false });
    case '/mode': {
      const mode = body?.mode ?? null;
      if (mode !== null && !['401', '429', '500', 'slow'].includes(String(mode))) return json(400, { error: 'mode: null, 401, 429, 500 or slow' });
      state.mode = mode === null ? null : { mode: String(mode), retryAfter: Number(body?.retryAfter ?? 30), ms: Number(body?.ms ?? 30_000), times: body?.times === undefined ? null : Number(body.times) };
      return json(200, { ok: true, mode: state.mode });
    }
    case '/update':
      return queueUpdate(state, body);
    case '/chat': {
      if (body?.id === undefined) return json(400, { error: 'id required' });
      if (body.reject === false) state.rejected.delete(String(body.id));
      else state.rejected.add(String(body.id));
      return json(200, { ok: true, rejected: [...state.rejected] });
    }
    case '/settings': {
      if (body && 'token' in body) {
        if (body.token !== null && !TOKEN_RE.test(String(body.token))) return json(400, { error: 'token must look like a bot token' });
        state.token = body.token === null ? null : String(body.token);
      }
      if (body && typeof body.webhook === 'boolean') state.webhook = body.webhook;
      if (body?.bot && typeof body.bot === 'object') state.bot = { ...state.bot, ...body.bot, is_bot: true };
      return json(200, { ok: true });
    }
    default:
      return json(404, { error: 'unknown control route' });
  }
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
      if (buf === null) return send(res, json(413, { ok: false, error_code: 413, description: 'Request Entity Too Large' }));
      const text = buf.toString('utf8');

      if (path.startsWith('/__control/')) {
        let body = null;
        if (text !== '') {
          try {
            body = JSON.parse(text);
          } catch {
            return send(res, json(400, { error: 'invalid JSON' }));
          }
        }
        return send(res, control(state, reset, req.method, path, body));
      }

      const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(path);
      if (!m) return send(res, fail(404, 'Not Found'));
      const [, token, method] = m;
      // The token is never kept: calls record the method only.
      const entry = { at: Date.now(), method, status: null, dropped: false };
      state.calls.push(entry);
      const done = (r) => {
        entry.status = r.status;
        return send(res, r);
      };
      if (state.down) {
        entry.dropped = true;
        res.socket?.destroy();
        return undefined;
      }
      const mode = state.mode;
      if (mode) {
        if (mode.times !== null) {
          mode.times -= 1;
          if (mode.times <= 0) state.mode = null;
        }
        if (mode.mode === 'slow') await sleep(mode.ms);
        if (mode.mode === '401') return done(fail(401, 'Unauthorized'));
        if (mode.mode === '429') return done(fail(429, `Too Many Requests: retry after ${mode.retryAfter}`, { retry_after: mode.retryAfter }));
        if (mode.mode === '500') return done(fail(500, 'Internal Server Error'));
      }
      if (!TOKEN_RE.test(token)) return done(fail(404, 'Not Found'));
      if (state.token !== null && token !== state.token) return done(fail(401, 'Unauthorized'));
      const p = params(req, url, text);
      if (p === null) return done(fail(400, "Bad Request: can't parse JSON object"));
      return done(botApi(state, method, p));
    })().catch(() => {
      // Never print the error: its request path holds the token.
      console.error('telegram-standin: internal error');
      if (!res.headersSent) send(res, fail(500, 'Internal Server Error'));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const i = process.argv.indexOf('--port');
  const { port } = await startStandin(i >= 0 ? Number(process.argv[i + 1]) : 0);
  console.log(`telegram-standin listening on http://127.0.0.1:${port}`);
}
