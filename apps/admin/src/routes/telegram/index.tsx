// Telegram order messages (TGS-4, artifacts/TGS/brief.md, D-022). Owner only (`telegram.settings`).
// The admin is the only source of the bot token, the chats and the ticked details. Rows in
// `settings` (keys in @hb/db/telegram-settings): `telegram` (TelegramSettings JSON) and
// `telegramBotTokenEnc` (sealed with COURIER_KEYS_KEY). The jobs Worker reads both at send time.
//
// The token is write-only: never prefilled, never echoed, shown at most as "····1234". It is never
// written to an audit row (markers set/change/remove only), a redirect, a flash or a log. Errors
// from the Telegram client carry a code only.
//
//   GET  /telegram                    status + forms
//   POST /telegram/token              check with getMe, seal and store     POST /telegram/token/remove
//   POST /telegram/chats/find         getUpdates → pending chats
//   POST /telegram/chats/confirm      POST /telegram/chats/ignore          POST /telegram/chats/remove
//   POST /telegram/details            ticked details + message language
//   POST /telegram/test               the preview to every confirmed chat
//   POST /telegram/enabled            on / off
import type { Context } from 'hono';
import { sealTelegramToken } from '@hb/db/telegram-settings';
import {
  confirmedTelegramChats,
  formatTelegramOrder,
  TELEGRAM_CHAT_ID_RE,
  TELEGRAM_CHAT_TITLE_MAX,
  TELEGRAM_FIELDS,
  TELEGRAM_MAX_CHATS,
  TELEGRAM_SAMPLE_ORDER,
  TELEGRAM_TOKEN_RE,
  telegramOneLine,
  type TelegramChat,
  type TelegramSettings,
} from '@hb/shared/telegram';
import { TelegramError, telegramGetMe, telegramGetUpdates, telegramSendMessage } from '@hb/shared/telegram-api';
import { noAudit } from '../../audit/audit.ts';
import { rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv } from '../../env.ts';
import { readForm } from '../../lib/forms.ts';
import { createRouter } from '../../lib/router.ts';
import { chatDeliveries, clientOptions, openClient, readTelegramState, telegramBase, telegramKey, writeTelegram, type TelegramState } from './data.ts';
import { tm as messages, type TmKey } from './messages.ts';
import { TelegramPage, type TelegramErrors, type TelegramPageProps, type TestResult } from './view.tsx';

type Ctx = Context<AppEnv>;

const r = createRouter({ roles: rolesFor('telegram.settings') });
const PERM = requirePerm('telegram.settings');

/** Pending chats kept at most (a busy group bot could otherwise grow the row without bound). */
const MAX_PENDING = 20;

const POSITIVE = new Set(['token_saved', 'token_changed_bot', 'token_removed', 'found', 'confirmed', 'ignored', 'removed', 'details_saved', 'enabled', 'disabled']);
const NEUTRAL = new Set(['none_found', 'unchanged', 'no_chat']);

const back = (c: Ctx, code: string, extra = ''): Response => c.redirect(`/telegram?r=${code}${extra}`, 303);

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

async function render(c: Ctx, state: TelegramState, extra: Pick<TelegramPageProps, 'errors' | 'notice' | 'testResults'> = {}) {
  const tm = messages(c.var.lang);
  return c.render(
    <TelegramPage
      tm={tm}
      settings={state.settings}
      status={state.status}
      hasToken={state.hasToken}
      keyOk={(await telegramKey(c.env)) !== null}
      reachable={telegramBase(c.env) !== null}
      deliveries={await chatDeliveries(c, state.settings)}
      {...extra}
    />,
    { title: tm('title') },
  );
}

/** Nothing written: says so to the audit guard and shows the page again with the problem. */
async function refuse(c: Ctx, status: 409 | 422 | 502, errors: TelegramErrors, reason: string) {
  noAudit(c, reason);
  c.status(status);
  return render(c, await readTelegramState(c), { errors });
}

function notice(c: Ctx, state: TelegramState): TelegramPageProps['notice'] {
  const code = c.req.query('r');
  if (code === undefined || (!POSITIVE.has(code) && !NEUTRAL.has(code))) return undefined;
  const tm = messages(c.var.lang);
  const n = Number(c.req.query('n'));
  const params = { bot: state.settings.bot ? `@${state.settings.bot.username}` : '', count: Number.isInteger(n) && n > 0 && n <= 100 ? n : 1 };
  return { tone: POSITIVE.has(code) ? 'success' : 'warning', text: tm(`r.${code}` as TmKey, params) };
}

r.get('/', PERM, async (c) => {
  const state = await readTelegramState(c);
  return render(c, state, { notice: notice(c, state) });
});

// ---------------------------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------------------------

r.post('/token', PERM, async (c) => {
  const tm = messages(c.var.lang);
  const token = ((await readForm(c))['token'] ?? '').trim();
  // The token is never echoed back, valid or not.
  if (token === '') return refuse(c, 422, { token: tm('err.tokenRequired') }, 'telegram token empty, nothing written');
  if (!TELEGRAM_TOKEN_RE.test(token)) return refuse(c, 422, { token: tm('err.tokenInvalid') }, 'telegram token malformed, nothing written');
  const key = await telegramKey(c.env);
  if (key === null) return refuse(c, 409, { token: tm('noKey') }, 'telegram token refused: no encryption key, nothing written');
  const base = telegramBase(c.env);
  if (base === null) return refuse(c, 409, { token: tm('off') }, 'telegram token refused: no Telegram address, nothing written');
  let bot: { id: number; username: string; name: string };
  try {
    bot = await telegramGetMe(clientOptions(base, token));
  } catch (err) {
    if (!(err instanceof TelegramError)) throw new Error('telegram getMe failed');
    if (err.code === 'token_rejected') return refuse(c, 422, { token: tm('err.token_rejected') }, 'telegram rejected the token, nothing written');
    return refuse(c, 502, { token: tm('err.unreachable') }, 'telegram unreachable, nothing written');
  }
  const sealed = await sealTelegramToken(key, token);
  const state = await readTelegramState(c);
  const s = state.settings;
  const otherBot = s.bot !== null && s.bot.id !== bot.id;
  const next: TelegramSettings = { ...s, bot, tokenLast4: token.slice(-4), ...(otherBot ? { chats: [], updateOffset: null } : {}) };
  const marker = state.hasToken ? 'change' : 'set';
  await writeTelegram(
    c,
    next,
    { action: 'telegram.token', before: { marker: state.hasToken ? 'present' : 'absent', bot: s.bot?.username ?? null }, after: { marker, bot: bot.username, chatsCleared: otherBot } },
    sealed,
  );
  return back(c, otherBot ? 'token_changed_bot' : 'token_saved');
});

r.post('/token/remove', PERM, async (c) => {
  const state = await readTelegramState(c);
  const s = state.settings;
  if (!state.hasToken && s.bot === null) {
    noAudit(c, 'telegram token already absent: nothing written');
    return back(c, 'unchanged');
  }
  const next: TelegramSettings = { ...s, enabled: false, bot: null, tokenLast4: null, chats: [], updateOffset: null };
  await writeTelegram(c, next, { action: 'telegram.token', before: { marker: 'present', bot: s.bot?.username ?? null, enabled: s.enabled, chats: s.chats.length }, after: { marker: 'remove', enabled: false, chats: 0 } }, null);
  return back(c, 'token_removed');
});

// ---------------------------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------------------------

const chatSnapshot = (chat: TelegramChat) => ({ id: chat.id, title: chat.title, type: chat.type, status: chat.status });

r.post('/chats/find', PERM, async (c) => {
  const tm = messages(c.var.lang);
  const state = await readTelegramState(c);
  const client = await openClient(c, state);
  if (!client.ok) {
    const status = client.reason === 'unreachable' ? 502 : 409;
    return refuse(c, status, { chats: tm(`err.find.${client.reason}`) }, `telegram chat search not possible (${client.reason}), nothing written`);
  }
  let found: Awaited<ReturnType<typeof telegramGetUpdates>>;
  try {
    found = await telegramGetUpdates(client.options, state.settings.updateOffset);
  } catch (err) {
    if (!(err instanceof TelegramError)) throw new Error('telegram getUpdates failed');
    const code = err.code === 'conflict' || err.code === 'token_rejected' ? err.code : 'unreachable';
    return refuse(c, code === 'unreachable' ? 502 : 409, { chats: tm(`err.find.${code}`) }, `telegram chat search failed (${err.code}), nothing written`);
  }
  // Read again after the network call: another tab may have confirmed or removed a chat meanwhile.
  const s = (await readTelegramState(c)).settings;
  const now = Date.now();
  const chats = s.chats.map((chat) => ({ ...chat }));
  const added: TelegramChat[] = [];
  let retitled = 0;
  for (const f of found.chats) {
    if (!TELEGRAM_CHAT_ID_RE.test(f.id)) continue;
    const title = telegramOneLine(f.title, TELEGRAM_CHAT_TITLE_MAX) || f.id;
    const known = chats.find((chat) => chat.id === f.id);
    if (known) {
      if (known.title !== title || known.type !== f.type) retitled += 1;
      known.title = title;
      known.type = f.type;
    } else if (chats.filter((chat) => chat.status === 'pending').length < MAX_PENDING) {
      const chat: TelegramChat = { id: f.id, title, type: f.type, status: 'pending', seenAt: now, confirmedAt: null };
      chats.push(chat);
      added.push(chat);
    }
  }
  const updateOffset = found.nextOffset ?? s.updateOffset;
  if (added.length === 0 && retitled === 0 && updateOffset === s.updateOffset) {
    noAudit(c, 'telegram chat search found nothing new: nothing written');
    return back(c, 'none_found');
  }
  await writeTelegram(c, { ...s, chats, updateOffset }, { action: 'telegram.chatsFound', before: { chats: s.chats.length }, after: { chats: chats.length, added: added.map(chatSnapshot), retitled } });
  return added.length > 0 ? back(c, 'found', `&n=${added.length}`) : back(c, 'none_found');
});

/** Reads the chat a per-chat button names; null when the id is not in the list. */
async function namedChat(c: Ctx): Promise<{ state: TelegramState; chat: TelegramChat | null }> {
  const id = ((await readForm(c))['chatId'] ?? '').trim();
  const state = await readTelegramState(c);
  return { state, chat: TELEGRAM_CHAT_ID_RE.test(id) ? (state.settings.chats.find((chat) => chat.id === id) ?? null) : null };
}

function gone(c: Ctx): Response {
  noAudit(c, 'telegram chat not in the list: nothing written');
  return back(c, 'no_chat');
}

r.post('/chats/confirm', PERM, async (c) => {
  const tm = messages(c.var.lang);
  const { state, chat } = await namedChat(c);
  if (chat === null) return gone(c);
  const s = state.settings;
  if (chat.status === 'confirmed') {
    noAudit(c, 'telegram chat already confirmed: nothing written');
    return back(c, 'confirmed');
  }
  if (confirmedTelegramChats(s).length >= TELEGRAM_MAX_CHATS) {
    return refuse(c, 409, { chats: tm('err.max', { max: TELEGRAM_MAX_CHATS }) }, 'telegram chat limit reached, nothing written');
  }
  const confirmed: TelegramChat = { ...chat, status: 'confirmed', confirmedAt: Date.now() };
  await writeTelegram(c, { ...s, chats: s.chats.map((x) => (x.id === chat.id ? confirmed : x)) }, { action: 'telegram.chatConfirm', before: chatSnapshot(chat), after: chatSnapshot(confirmed) });
  return back(c, 'confirmed');
});

function dropRoute(path: string, wanted: TelegramChat['status'], action: string, result: string) {
  r.post(path, PERM, async (c) => {
    const { state, chat } = await namedChat(c);
    if (chat === null || chat.status !== wanted) return gone(c);
    const s = state.settings;
    await writeTelegram(c, { ...s, chats: s.chats.filter((x) => x.id !== chat.id) }, { action, before: chatSnapshot(chat), after: null });
    return back(c, result);
  });
}

dropRoute('/chats/ignore', 'pending', 'telegram.chatIgnore', 'ignored');
dropRoute('/chats/remove', 'confirmed', 'telegram.chatRemove', 'removed');

// ---------------------------------------------------------------------------------------------
// Details, on/off
// ---------------------------------------------------------------------------------------------

r.post('/details', PERM, async (c) => {
  const tm = messages(c.var.lang);
  const raw = await readForm(c);
  const fields = TELEGRAM_FIELDS.filter((f) => raw[`field_${f}`] === '1');
  const lang = raw['lang'];
  if (fields.length === 0) return refuse(c, 422, { fields: tm('err.fieldsRequired') }, 'telegram details: no field ticked, nothing written');
  if (lang !== 'fr' && lang !== 'ar') return refuse(c, 422, { lang: tm('err.lang') }, 'telegram details: bad language, nothing written');
  const state = await readTelegramState(c);
  const s = state.settings;
  if (state.exists && s.lang === lang && s.fields.join() === fields.join()) {
    noAudit(c, 'telegram details unchanged: nothing written');
    return back(c, 'details_saved');
  }
  await writeTelegram(c, { ...s, fields, lang }, { action: 'telegram.details', before: { fields: s.fields, lang: s.lang }, after: { fields, lang } });
  return back(c, 'details_saved');
});

r.post('/enabled', PERM, async (c) => {
  const tm = messages(c.var.lang);
  const want = (await readForm(c))['enabled'];
  if (want !== 'on' && want !== 'off') return refuse(c, 422, { enabled: tm('err.enabledValue') }, 'telegram on/off: bad value, nothing written');
  const state = await readTelegramState(c);
  const s = state.settings;
  const on = want === 'on';
  if (s.enabled === on) {
    noAudit(c, 'telegram on/off unchanged: nothing written');
    return back(c, on ? 'enabled' : 'disabled');
  }
  if (on && (!state.hasToken || s.bot === null || confirmedTelegramChats(s).length === 0)) {
    return refuse(c, 409, { enabled: tm('err.enableNeeds') }, 'telegram cannot be enabled without a token and a confirmed chat, nothing written');
  }
  // enabledAt moves only on off → on: orders created while it was off are never sent later.
  const next: TelegramSettings = on ? { ...s, enabled: true, enabledAt: Date.now() } : { ...s, enabled: false };
  await writeTelegram(c, next, { action: on ? 'telegram.enable' : 'telegram.disable', before: { enabled: s.enabled }, after: { enabled: on } });
  return back(c, on ? 'enabled' : 'disabled');
});

// ---------------------------------------------------------------------------------------------
// Test message
// ---------------------------------------------------------------------------------------------

r.post('/test', PERM, async (c) => {
  const tm = messages(c.var.lang);
  const state = await readTelegramState(c);
  const s = state.settings;
  const chats = confirmedTelegramChats(s);
  if (chats.length === 0) return refuse(c, 409, { test: tm('test.needs') }, 'telegram test: no confirmed chat, nothing sent');
  const client = await openClient(c, state);
  if (!client.ok) {
    return refuse(c, client.reason === 'unreachable' ? 502 : 409, { test: tm(`err.find.${client.reason}`) }, `telegram test not possible (${client.reason}), nothing sent`);
  }
  const text = `[TEST]\n${formatTelegramOrder(TELEGRAM_SAMPLE_ORDER, s.fields, s.lang)}`;
  const results: TestResult[] = await Promise.all(
    chats.map(async (chat): Promise<TestResult> => {
      try {
        await telegramSendMessage(client.options, chat.id, text);
        return { chat, ok: true, problem: null };
      } catch (err) {
        const code = err instanceof TelegramError ? err.code : 'unreachable';
        const key: TmKey = code === 'chat_rejected' ? 'chatProblem.chat_rejected' : code === 'token_rejected' ? 'problem.token_rejected' : code === 'rate_limited' ? 'problem.rate_limited' : 'err.find.unreachable';
        return { chat, ok: false, problem: tm(key) };
      }
    }),
  );
  // Nothing in D1 changes: the sample text goes out, no order, no delivery row.
  noAudit(c, 'telegram test message: sends the sample order to the confirmed chats, no stored state changes');
  return render(c, state, { testResults: results });
});

export default r;
