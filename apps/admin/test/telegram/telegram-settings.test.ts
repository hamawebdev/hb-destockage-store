// TGS-4: the owner-only Telegram settings page. A real D1, the real app, and a fake Bot API behind
// the route's fetch seam (no network, a stand-in token only).
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { importSecretBoxKey } from '@hb/db/secret-box';
import { openTelegramToken } from '@hb/db/telegram-settings';
import { formatTelegramOrder, TELEGRAM_SAMPLE_ORDER, type TelegramChat } from '@hb/shared/telegram';
import { setTelegramFetchForTests } from '../../src/routes/telegram/data.ts';
import { harness, postAs, USERS, type Harness } from '../helpers.ts';
import { auditSince, BASE, clearTelegram, fakeTelegram, KEY, lastAuditId, message, OTHER_KEY, pieces, putSetting, seedOrder, settingsRow, telegramRows, TOKEN, TOKEN_OTHER_BOT, wholeResponse, type FakeTelegram } from './support.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let h: Harness;
let tg: FakeTelegram;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => {
  setTelegramFetchForTests(undefined);
  await h?.close();
});
beforeEach(async () => {
  await clearTelegram(h);
  tg = fakeTelegram();
  setTelegramFetchForTests(tg.fetch);
  Object.assign(h.env, { COURIER_KEYS_KEY: KEY, TELEGRAM_STANDIN_URL: BASE, ENV: 'test' });
});

const OWNER = USERS.owner;
const html = async (email: string = OWNER, query = '') => (await h.as(email, `/telegram${query}`)).text();
const post = (path: string, data: Record<string, string> = {}, email: string = OWNER) => postAs(h, email, `/telegram${path}`, data);
const saveToken = (token: string = TOKEN) => post('/token', { token });
const chats = async () => ((await settingsRow(h))['chats'] ?? []) as TelegramChat[];
const ALL = { field_ref: '1', field_name: '1', field_phone: '1', field_place: '1', field_address: '1', field_items: '1', field_fee: '1', field_total: '1', field_note: '1' };

const GROUP = { id: -1001234567890, type: 'supergroup', title: 'Commandes Comptoir' };
const PERSON = { id: 4242, type: 'private', first_name: 'Karim', last_name: 'B.' };

/** Token saved, both chats found; `confirm` lists the chat ids to confirm. */
async function setup(confirm: string[] = []): Promise<void> {
  expect((await saveToken()).status).toBe(303);
  tg.updates = [message(10, GROUP), message(11, PERSON)];
  expect((await post('/chats/find')).headers.get('location')).toBe('/telegram?r=found&n=2');
  for (const chatId of confirm) expect((await post('/chats/confirm', { chatId })).headers.get('location')).toBe('/telegram?r=confirmed');
}

describe('owner only', () => {
  const POSTS = ['/token', '/token/remove', '/chats/find', '/chats/confirm', '/chats/ignore', '/chats/remove', '/details', '/test', '/enabled'];

  test.each([USERS.confirmer, USERS.logistics, USERS.content])('%s: 403 on the page and on every action, nothing written, nothing called', async (email) => {
    expect((await h.as(email, '/telegram')).status).toBe(403);
    for (const path of POSTS) expect((await post(path, { token: TOKEN, chatId: '1', enabled: 'on', lang: 'fr', ...ALL }, email)).status).toBe(403);
    expect(await telegramRows(h)).toEqual({});
    expect(tg.calls).toEqual([]);
  });

  test('signed out: 401; the nav shows Telegram to the owner only', async () => {
    expect((await h.as(null, '/telegram')).status).toBe(401);
    expect(await (await h.as(OWNER, '/dashboard')).text()).toContain('href="/telegram"');
    expect(await (await h.as(USERS.confirmer, '/dashboard')).text()).not.toContain('href="/telegram"');
  });

  test('the page is private, no-store, in French and in Arabic (right to left)', async () => {
    const res = await h.as(OWNER, '/telegram');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.text()).toContain('1. Jeton du bot');
    const ar = await html(USERS.ownerAr);
    expect(ar).toContain('dir="rtl"');
    expect(ar).toContain('رمز البوت');
    expect(ar).toContain('اسم الزبون');
  });
});

describe('token', () => {
  test('happy path: checked with getMe, sealed, bot and last 4 stored, audited with a marker', async () => {
    const mark = await lastAuditId(h);
    const res = await saveToken(`  ${TOKEN}  `);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/telegram?r=token_saved');
    expect(tg.calls.map((c) => c.method)).toEqual(['getMe']);
    const rows = await telegramRows(h);
    const stored = JSON.parse(rows['telegramBotTokenEnc']!) as string;
    expect(stored).toMatch(/^[A-Za-z0-9+/=_-]+\.[A-Za-z0-9+/=_-]+$/);
    expect(await openTelegramToken(await importSecretBoxKey(KEY), stored)).toBe(TOKEN);
    expect(await settingsRow(h)).toMatchObject({ enabled: false, bot: { id: 123456, username: 'comptoir_test_bot' }, tokenLast4: '1VuE', chats: [] });
    const audits = await auditSince(h, mark);
    expect(audits.map((a) => a.action)).toEqual(['telegram.token']);
    expect(JSON.parse(audits[0]!.after!)).toEqual({ marker: 'set', bot: 'comptoir_test_bot', chatsCleared: false });
    const page = await html(OWNER, '?r=token_saved');
    expect(page).toContain('Jeton enregistré. Bot : @comptoir_test_bot.');
    expect(page).toContain('····1VuE');
    expect(page).toContain('href="https://t.me/comptoir_test_bot"');
  });

  test('the token never appears in a response, an audit row or a settings row in clear', async () => {
    const mark = await lastAuditId(h);
    const outs: string[] = [await wholeResponse(await saveToken())];
    await setup(['4242']);
    outs.push(await wholeResponse(await h.as(OWNER, '/telegram?r=token_saved')));
    outs.push(await wholeResponse(await post('/chats/find')));
    outs.push(await wholeResponse(await post('/test')));
    outs.push(await wholeResponse(await post('/details', { ...ALL, lang: 'ar' })));
    outs.push(await wholeResponse(await h.as(OWNER, '/settings')));
    // A malformed and a rejected token are not echoed either.
    const bad = `${TOKEN}!!`;
    outs.push(await wholeResponse(await saveToken(bad)));
    const rejected = '999999:TEST-rejectedRejectedRejectedRejected00';
    outs.push(await wholeResponse(await saveToken(rejected)));
    tg.down = true;
    outs.push(await wholeResponse(await saveToken(TOKEN_OTHER_BOT)));
    outs.push(await wholeResponse(await post('/chats/find')));
    outs.push(await wholeResponse(await post('/test')));
    const rows = await telegramRows(h);
    const blob = JSON.parse(rows['telegramBotTokenEnc']!) as string;
    const audits = JSON.stringify(await auditSince(h, mark));
    const secrets = [TOKEN.split(':')[1]!, rejected.split(':')[1]!, TOKEN_OTHER_BOT.split(':')[1]!];
    for (const out of [...outs, audits, rows['telegram']!]) {
      for (const secret of secrets) for (const p of pieces(secret, 8)) expect(out).not.toContain(p);
      for (const p of pieces(blob, 16)) expect(out).not.toContain(p);
    }
    for (const secret of secrets) for (const p of pieces(secret, 8)) expect(rows['telegramBotTokenEnc']).not.toContain(p);
    // The input is write-only.
    expect(outs[1]).toMatch(/<input[^>]*name="token"[^>]*type="password"[^>]*value=""/);
    expect(outs[1]).toMatch(/<input[^>]*name="token"[^>]*autocomplete="off"/);
  });

  test.each([
    ['empty', '', 'Collez le jeton du bot.'],
    ['not a token', 'bonjour', 'n’a pas la forme d’un jeton de bot Telegram'],
    ['too short', '123456:abc', 'n’a pas la forme d’un jeton de bot Telegram'],
  ])('malformed (%s): 422, Telegram not called, nothing written', async (_l, token, text) => {
    const res = await saveToken(token);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(text);
    expect(tg.calls).toEqual([]);
    expect(await telegramRows(h)).toEqual({});
  });

  test('rejected by Telegram: "Telegram refuse ce jeton", nothing written', async () => {
    const res = await saveToken('999999:TEST-rejectedRejectedRejectedRejected00');
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Telegram refuse ce jeton.');
    expect(await telegramRows(h)).toEqual({});
  });

  test('Telegram unreachable: says so, nothing written; a stored token stays as it was', async () => {
    await saveToken();
    const before = await telegramRows(h);
    tg.down = true;
    const res = await saveToken(TOKEN_OTHER_BOT);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Telegram ne répond pas pour le moment. Rien n’a été enregistré');
    expect(await telegramRows(h)).toEqual(before);
  });

  test('no Telegram address on this server (non-production, no stand-in): says so, nothing written', async () => {
    Object.assign(h.env, { TELEGRAM_STANDIN_URL: undefined });
    const res = await saveToken();
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Telegram n’est pas disponible sur ce serveur');
    Object.assign(h.env, { TELEGRAM_STANDIN_URL: 'https://example.com' });
    expect((await saveToken()).status).toBe(409);
    expect(tg.calls).toEqual([]);
    expect(await telegramRows(h)).toEqual({});
  });

  test('COURIER_KEYS_KEY unset: refuses to save and says so', async () => {
    Object.assign(h.env, { COURIER_KEYS_KEY: undefined });
    const res = await saveToken();
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('La clé de chiffrement (COURIER_KEYS_KEY) n’est pas configurée');
    expect(tg.calls).toEqual([]);
    expect(await telegramRows(h)).toEqual({});
  });

  test('same bot, new token: marker "change", chats kept. Another bot: chats and offset cleared', async () => {
    await setup(['4242']);
    tg.bots.set('123456:TEST-rotatedRotatedRotatedRotated0000AbCd', tg.bots.get(TOKEN)!);
    let mark = await lastAuditId(h);
    expect((await saveToken('123456:TEST-rotatedRotatedRotatedRotated0000AbCd')).headers.get('location')).toBe('/telegram?r=token_saved');
    expect(JSON.parse((await auditSince(h, mark))[0]!.after!)).toMatchObject({ marker: 'change', chatsCleared: false });
    expect(await settingsRow(h)).toMatchObject({ tokenLast4: 'AbCd', updateOffset: 12 });
    expect((await chats()).length).toBe(2);
    mark = await lastAuditId(h);
    expect((await saveToken(TOKEN_OTHER_BOT)).headers.get('location')).toBe('/telegram?r=token_changed_bot');
    expect(await settingsRow(h)).toMatchObject({ bot: { id: 654321, username: 'other_test_bot' }, chats: [], updateOffset: null });
    expect(JSON.parse((await auditSince(h, mark))[0]!.after!)).toMatchObject({ marker: 'change', chatsCleared: true });
  });

  test('remove: token row gone, bot and chats cleared, switched off, ticks kept, marker "remove"', async () => {
    await setup(['4242']);
    await post('/details', { field_ref: '1', field_total: '1', lang: 'ar' });
    expect((await post('/enabled', { enabled: 'on' })).status).toBe(303);
    const mark = await lastAuditId(h);
    const res = await post('/token/remove');
    expect(res.headers.get('location')).toBe('/telegram?r=token_removed');
    const rows = await telegramRows(h);
    expect(rows['telegramBotTokenEnc']).toBeUndefined();
    expect(await settingsRow(h)).toMatchObject({ enabled: false, bot: null, tokenLast4: null, chats: [], updateOffset: null, fields: ['ref', 'total'], lang: 'ar' });
    const audits = await auditSince(h, mark);
    expect(audits.map((a) => a.action)).toEqual(['telegram.token']);
    expect(JSON.parse(audits[0]!.after!)).toMatchObject({ marker: 'remove' });
    expect(await html()).not.toContain('/telegram/token/remove');
  });
});

describe('chats', () => {
  test('find: new chats arrive as pending, the offset is stored, nothing is confirmed by itself', async () => {
    await saveToken();
    tg.updates = [message(10, GROUP), message(11, PERSON), message(12, GROUP)];
    const mark = await lastAuditId(h);
    const res = await post('/chats/find');
    expect(res.headers.get('location')).toBe('/telegram?r=found&n=2');
    expect(await chats()).toMatchObject([
      { id: '-1001234567890', title: 'Commandes Comptoir', type: 'supergroup', status: 'pending', confirmedAt: null },
      { id: '4242', title: 'Karim B.', type: 'private', status: 'pending', confirmedAt: null },
    ]);
    expect((await settingsRow(h))['updateOffset']).toBe(13);
    expect((await auditSince(h, mark)).map((a) => a.action)).toEqual(['telegram.chatsFound']);
    const page = await html(OWNER, '?r=found&n=2');
    expect(page).toContain('2 nouvelles discussions trouvées');
    expect(page).toContain('<bdi>Commandes Comptoir</bdi>');
    expect(page).toContain('<bdi>Karim B.</bdi>');
    expect(page).toContain('action="/telegram/chats/confirm"');
    expect(page).not.toContain('action="/telegram/chats/remove"');
  });

  test('find again: no duplicates, confirmed chats stay confirmed, titles refresh, the next call uses the stored offset', async () => {
    await setup(['4242']);
    tg.updates = [message(12, { ...GROUP, title: 'Commandes (nouveau nom)' }), message(13, { ...PERSON, first_name: 'Karim', last_name: 'Benali' })];
    expect((await post('/chats/find')).headers.get('location')).toBe('/telegram?r=none_found');
    expect(tg.calls.at(-1)).toMatchObject({ method: 'getUpdates', body: { offset: 12 } });
    const list = await chats();
    expect(list.map((c) => [c.id, c.title, c.status])).toEqual([
      ['-1001234567890', 'Commandes (nouveau nom)', 'pending'],
      ['4242', 'Karim Benali', 'confirmed'],
    ]);
    // Nothing new at all: nothing written.
    const mark = await lastAuditId(h);
    tg.updates = [];
    expect((await post('/chats/find')).headers.get('location')).toBe('/telegram?r=none_found');
    expect(await auditSince(h, mark)).toEqual([]);
  });

  test('a hostile chat title is escaped and capped at 80 characters', async () => {
    await saveToken();
    tg.updates = [message(1, { id: -77, type: 'group', title: `<script>alert(1)</script>"><img src=x> ${'x'.repeat(200)}` })];
    await post('/chats/find');
    const [chat] = await chats();
    expect(chat!.title.length).toBeLessThanOrEqual(80);
    const page = await html();
    expect(page).not.toContain('<script>alert(1)');
    expect(page).not.toContain('<img src=x>');
    expect(page).toContain('&lt;script&gt;alert(1)');
  });

  test('a bot with a webhook (409): plain message, nothing written; unreachable: plain message', async () => {
    await saveToken();
    const before = await telegramRows(h);
    tg.webhook = true;
    let res = await post('/chats/find');
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Ce bot est déjà relié à un autre service');
    tg.webhook = false;
    tg.down = true;
    res = await post('/chats/find');
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Telegram ne répond pas pour le moment. Recommencez dans un instant.');
    expect(await telegramRows(h)).toEqual(before);
  });

  test('the stored token cannot be opened (key changed): says so, Telegram not called', async () => {
    await saveToken();
    Object.assign(h.env, { COURIER_KEYS_KEY: OTHER_KEY });
    tg.calls.length = 0;
    const res = await post('/chats/find');
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Le jeton enregistré ne peut pas être lu');
    expect(tg.calls).toEqual([]);
  });

  test('confirm sets confirmedAt now; ignore drops a pending chat; remove drops a confirmed one; each audited', async () => {
    await setup();
    const mark = await lastAuditId(h);
    const t0 = Date.now();
    expect((await post('/chats/confirm', { chatId: '4242' })).headers.get('location')).toBe('/telegram?r=confirmed');
    const person = (await chats()).find((c) => c.id === '4242')!;
    expect(person.status).toBe('confirmed');
    expect(person.confirmedAt).toBeGreaterThanOrEqual(t0);
    expect((await post('/chats/ignore', { chatId: '-1001234567890' })).headers.get('location')).toBe('/telegram?r=ignored');
    expect((await chats()).map((c) => c.id)).toEqual(['4242']);
    let page = await html();
    expect(page).toContain('action="/telegram/chats/remove"');
    expect(page).toContain('aucun message pour l’instant');
    // Ignore does not remove a confirmed chat; an unknown id changes nothing.
    expect((await post('/chats/ignore', { chatId: '4242' })).headers.get('location')).toBe('/telegram?r=no_chat');
    expect((await post('/chats/remove', { chatId: '999' })).headers.get('location')).toBe('/telegram?r=no_chat');
    expect((await post('/chats/confirm', { chatId: '1; DROP' })).headers.get('location')).toBe('/telegram?r=no_chat');
    expect((await chats()).length).toBe(1);
    expect((await post('/chats/remove', { chatId: '4242' })).headers.get('location')).toBe('/telegram?r=removed');
    expect(await chats()).toEqual([]);
    const audits = await auditSince(h, mark);
    expect(audits.map((a) => a.action)).toEqual(['telegram.chatConfirm', 'telegram.chatIgnore', 'telegram.chatRemove']);
    expect(JSON.parse(audits[0]!.after!)).toEqual({ id: '4242', title: 'Karim B.', type: 'private', status: 'confirmed' });
    page = await html();
    expect(page).toContain('Aucune discussion pour l’instant.');
  });

  test('at most 10 confirmed chats', async () => {
    await saveToken();
    const row = await settingsRow(h);
    const many: TelegramChat[] = Array.from({ length: 10 }, (_, i) => ({ id: String(100 + i), title: `Groupe ${i}`, type: 'group', status: 'confirmed', seenAt: 1, confirmedAt: 2 }));
    await putSetting(h, 'telegram', { ...row, chats: [...many, { id: '555', title: 'Onzième', type: 'group', status: 'pending', seenAt: 1, confirmedAt: null }] });
    const res = await post('/chats/confirm', { chatId: '555' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Vous avez déjà 10 discussions confirmées');
    expect((await chats()).find((c) => c.id === '555')!.status).toBe('pending');
  });

  test('a confirmed chat shows its last message and its last problem', async () => {
    await setup(['4242', '-1001234567890']);
    const orderId = await seedOrder(h);
    await h.db.batch([
      h.db.prepare('DELETE FROM notification_deliveries WHERE order_id = ?1').bind(orderId),
      h.db.prepare("INSERT INTO notification_deliveries (order_id, channel, status, attempts, sent_at) VALUES (?1, 'telegram:4242', 'sent', 1, 1794000100000)").bind(orderId),
      h.db.prepare("INSERT INTO notification_deliveries (order_id, channel, status, attempts, last_error) VALUES (?1, 'telegram:-1001234567890', 'sending', 3, 'chat_rejected')").bind(orderId),
    ]);
    const page = await html();
    expect(page).toContain(`<time datetime="${new Date(1794000100000).toISOString()}">`);
    expect(page).toContain('Telegram refuse d’écrire ici.');
    await h.db.prepare('DELETE FROM notification_deliveries WHERE order_id = ?1').bind(orderId).run();
  });
});

describe('details and preview', () => {
  test('default: everything ticked, French preview of the sample order', async () => {
    const page = await html();
    for (const f of ['ref', 'name', 'phone', 'place', 'address', 'items', 'fee', 'total', 'note']) expect(page).toMatch(new RegExp(`name="field_${f}" value="1" checked=""`));
    for (const label of ['Référence', 'Nom du client', 'Téléphone', 'Wilaya et commune', 'Adresse', 'Produits (variante et quantité)', 'Frais de livraison', 'Total', 'Note']) expect(page).toContain(`>${label}</label>`);
    expect(page).toMatch(/<pre class="tg-preview" dir="auto"[^>]*>Nouvelle commande HB-TEST1/);
  });

  test('ticks and language are saved in field order, audited, and the preview follows exactly', async () => {
    const mark = await lastAuditId(h);
    const res = await post('/details', { field_total: '1', field_ref: '1', field_phone: '1', lang: 'ar' });
    expect(res.headers.get('location')).toBe('/telegram?r=details_saved');
    expect(await settingsRow(h)).toMatchObject({ fields: ['ref', 'phone', 'total'], lang: 'ar', enabled: false });
    const audits = await auditSince(h, mark);
    expect(audits.map((a) => a.action)).toEqual(['telegram.details']);
    expect(JSON.parse(audits[0]!.after!)).toEqual({ fields: ['ref', 'phone', 'total'], lang: 'ar' });
    const page = await html();
    expect(page).toMatch(/name="field_ref" value="1" checked=""/);
    expect(page).toMatch(/name="field_name" value="1"(?! checked)/);
    expect(page).toMatch(/<option value="ar" selected="">/);
    const expected = formatTelegramOrder(TELEGRAM_SAMPLE_ORDER, ['ref', 'phone', 'total'], 'ar');
    const shown = /<pre class="tg-preview"[^>]*>([\s\S]*?)<\/pre>/.exec(page)![1]!;
    expect(shown).toBe(expected);
    expect(shown).toContain('طلب جديد');
    expect(shown).not.toContain(TELEGRAM_SAMPLE_ORDER.name);
    expect(shown).not.toContain('Cité Exemple');
  });

  test('no tick: 422 "Cochez au moins un détail", nothing written; a bad language: 422', async () => {
    let res = await post('/details', { lang: 'fr' });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Cochez au moins un détail.');
    res = await post('/details', { field_ref: '1', lang: 'en' });
    expect(res.status).toBe(422);
    expect(await telegramRows(h)).toEqual({});
  });
});

describe('test message', () => {
  test('goes to exactly the confirmed chats, with exactly the ticked lines, even while switched off', async () => {
    await setup(['4242']);
    await post('/details', { field_ref: '1', field_items: '1', field_total: '1', lang: 'fr' });
    const before = await telegramRows(h);
    tg.sent.length = 0;
    const res = await post('/test');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Résultat du test');
    expect(body).toContain('message envoyé');
    expect(tg.sent).toEqual([{ chatId: '4242', text: `[TEST]\n${formatTelegramOrder(TELEGRAM_SAMPLE_ORDER, ['ref', 'items', 'total'], 'fr')}` }]);
    const text = tg.sent[0]!.text;
    expect(text).toContain('HB-TEST1');
    expect(text).toContain('2 × Produit exemple (Noir / L)');
    for (const absent of ['Client Exemple', '0550000000', 'Alger', 'Cité Exemple', 'Livraison']) expect(text).not.toContain(absent);
    expect((await settingsRow(h))['enabled']).toBe(false);
    expect(await telegramRows(h)).toEqual(before);
  });

  test('two confirmed chats: per-chat result, one refused by Telegram', async () => {
    await setup(['4242', '-1001234567890']);
    tg.rejectChats.add('-1001234567890');
    tg.sent.length = 0;
    const body = await (await post('/test')).text();
    expect(tg.sent.map((s) => s.chatId)).toEqual(['4242']);
    expect(body).toContain('message envoyé');
    expect(body).toContain('Telegram refuse d’écrire ici.');
  });

  test('no confirmed chat: refused, nothing sent; Telegram down: per-chat problem in plain words', async () => {
    await setup();
    let res = await post('/test');
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Il faut un jeton et au moins une discussion confirmée.');
    expect(tg.sent).toEqual([]);
    await post('/chats/confirm', { chatId: '4242' });
    tg.down = true;
    res = await post('/test');
    expect(await res.text()).toContain('Telegram ne répond pas pour le moment.');
    expect(tg.sent).toEqual([]);
  });
});

describe('on / off', () => {
  test('turning on needs a token and a confirmed chat', async () => {
    let res = await post('/enabled', { enabled: 'on' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Impossible d’activer : il faut un jeton et au moins une discussion confirmée.');
    await setup();
    expect((await post('/enabled', { enabled: 'on' })).status).toBe(409);
    expect((await settingsRow(h))['enabled']).toBe(false);
    expect((await post('/enabled', { enabled: 'maybe' })).status).toBe(422);
  });

  test('on sets enabledAt = now; off keeps token, chats and ticks; on again moves enabledAt; audited', async () => {
    await setup(['4242']);
    await post('/details', { field_ref: '1', field_name: '1', lang: 'ar' });
    const mark = await lastAuditId(h);
    const t0 = Date.now();
    expect((await post('/enabled', { enabled: 'on' })).headers.get('location')).toBe('/telegram?r=enabled');
    const on = await settingsRow(h);
    expect(on['enabled']).toBe(true);
    expect(on['enabledAt']).toBeGreaterThanOrEqual(t0);
    expect(await html()).toContain('>Activé</span>');
    const tokenRow = (await telegramRows(h))['telegramBotTokenEnc'];
    expect((await post('/enabled', { enabled: 'off' })).headers.get('location')).toBe('/telegram?r=disabled');
    const off = await settingsRow(h);
    expect(off).toMatchObject({ enabled: false, enabledAt: on['enabledAt'], fields: ['ref', 'name'], lang: 'ar', tokenLast4: '1VuE', bot: { username: 'comptoir_test_bot' } });
    expect((off['chats'] as TelegramChat[]).map((c) => [c.id, c.status])).toEqual([['-1001234567890', 'pending'], ['4242', 'confirmed']]);
    expect((await telegramRows(h))['telegramBotTokenEnc']).toBe(tokenRow);
    await new Promise((r) => setTimeout(r, 5));
    await post('/enabled', { enabled: 'on' });
    expect((await settingsRow(h))['enabledAt']).toBeGreaterThan(on['enabledAt'] as number);
    expect((await auditSince(h, mark)).map((a) => a.action)).toEqual(['telegram.enable', 'telegram.disable', 'telegram.enable']);
  });

  test('the jobs status is shown in plain words', async () => {
    await putSetting(h, 'jobs.telegram_status', { lastOkAt: 1794000000000, lastErrorCode: 'token_rejected', lastErrorAt: 1794000200000 });
    const page = await html();
    expect(page).toContain(`<time datetime="${new Date(1794000000000).toISOString()}">`);
    expect(page).toContain('Telegram refuse le jeton du bot.');
  });
});
