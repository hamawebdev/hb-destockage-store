// TGS-4: the "Réception des commandes" section on /settings (Telegram and Google Sheets cards) and the
// "last order written" line on /sheets. Real D1; no network (the cards only read).
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { harness, USERS, type Harness } from '../helpers.ts';
import { BASE, clearTelegram, KEY, putSetting, seedOrder } from './support.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let h: Harness;
let orderId: number;
beforeAll(async () => {
  h = await harness();
  orderId = await seedOrder(h);
}, 120_000);
afterAll(async () => h?.close());

const OWNER = USERS.owner;
const WRITTEN = 1794000300000;
const setConn = (set: string, ...binds: unknown[]) => h.db.prepare(`UPDATE sheets_connection SET ${set} WHERE id=1`).bind(...binds).run();
const connected = () => setConn("status='connected', google_email='owner@test.local', google_sub='sub-1', spreadsheet_id='sheet-abc', tab_id=7, generation=4");

beforeEach(async () => {
  await clearTelegram(h);
  await h.db.batch([
    h.db.prepare('DELETE FROM sheets_rows'),
    h.db.prepare(`UPDATE sheets_connection SET status='disconnected', google_email=NULL, google_sub=NULL, refresh_token_enc=NULL, create_key=NULL, spreadsheet_id=NULL, tab_id=NULL, lang=NULL, generation=1, failure_count=0, next_attempt_at=NULL, last_error_code=NULL, last_error_at=NULL, layout_note=NULL`),
  ]);
  Object.assign(h.env, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REDIRECT_URI: 'http://127.0.0.1:9/sheets/callback', GOOGLE_STANDIN_URL: 'http://127.0.0.1:4420', COURIER_KEYS_KEY: KEY, TELEGRAM_STANDIN_URL: BASE, ENV: 'test' });
});

const page = async (email: string = OWNER, path = '/settings') => (await h.as(email, path)).text();
/** The HTML of one card. */
const card = (html: string, which: 'telegram' | 'sheets') => new RegExp(`<div data-reception="${which}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';
const stateOf = (html: string, which: 'telegram' | 'sheets') => new RegExp(`data-reception="${which}" data-state="([a-z_]+)"`).exec(html)?.[1];

describe('the section', () => {
  test('owner, French and Arabic: title and both cards, outside the store form', async () => {
    const fr = await page();
    expect(fr).toContain('Réception des commandes');
    expect(card(fr, 'telegram')).toContain('<a class="btn btn--primary" href="/telegram">Gérer Telegram</a>');
    expect(card(fr, 'sheets')).not.toBe('');
    // The store form closes before the section starts.
    expect(fr.indexOf('id="reception"')).toBeGreaterThan(fr.indexOf('</form>'));
    const ar = await page(USERS.ownerAr);
    expect(ar).toContain('استقبال الطلبات');
    expect(card(ar, 'telegram')).toContain('إدارة تيليغرام');
    expect(card(ar, 'sheets')).toContain('ربط Google Sheets');
  });

  test('other roles cannot open the store settings at all', async () => {
    for (const email of [USERS.confirmer, USERS.logistics, USERS.content]) expect((await h.as(email, '/settings')).status).toBe(403);
  });
});

describe('Telegram card', () => {
  test('nothing set up: off, no bot, 0 chats, every detail, no message yet, no problem line', async () => {
    const c = card(await page(), 'telegram');
    expect(stateOf(c, 'telegram')).toBe('off');
    expect(c).toContain('>Désactivé</span>');
    expect(c).toContain('aucun bot enregistré');
    expect(c).toContain('Référence, Nom du client, Téléphone, Wilaya et commune, Adresse, Produits (variante et quantité), Frais de livraison, Total, Note');
    expect(c).toContain('aucun pour l’instant');
    expect(c).not.toContain('data-reception-problem');
  });

  test('on: bot, confirmed chats only, chosen details, last message, plain-words problem', async () => {
    await putSetting(h, 'telegram', {
      enabled: true,
      enabledAt: 5,
      lang: 'fr',
      fields: ['ref', 'total'],
      bot: { id: 123456, username: 'comptoir_test_bot', name: 'Comptoir' },
      tokenLast4: '1VuE',
      updateOffset: 3,
      chats: [
        { id: '1', title: 'A', type: 'group', status: 'confirmed', seenAt: 1, confirmedAt: 2 },
        { id: '2', title: 'B', type: 'private', status: 'confirmed', seenAt: 1, confirmedAt: 2 },
        { id: '3', title: 'C', type: 'private', status: 'pending', seenAt: 1, confirmedAt: null },
      ],
    });
    await putSetting(h, 'jobs.telegram_status', { lastOkAt: WRITTEN, lastErrorCode: 'unreachable', lastErrorAt: WRITTEN + 1000 });
    const c = card(await page(), 'telegram');
    expect(stateOf(c, 'telegram')).toBe('on');
    expect(c).toContain('>Activé</span>');
    expect(c).toContain('@comptoir_test_bot');
    expect(c).toMatch(/Discussions confirmées<\/dt><dd><span class="num">2<\/span>/);
    expect(c).toContain('<dd>Référence, Total</dd>');
    expect(c).toContain(`<time datetime="${new Date(WRITTEN).toISOString()}">`);
    expect(c).toContain('data-reception-problem="unreachable"');
    expect(c).toContain('Telegram ne répond pas. Les commandes en attente partiront dès son retour.');
  });

  test.each([
    ['token_rejected', 'Telegram refuse le jeton du bot.'],
    ['rate_limited', 'Telegram demande de ralentir.'],
    ['key_missing', 'Le serveur ne peut pas lire le jeton enregistré'],
    ['chat_rejected', 'Telegram refuse d’écrire dans une discussion.'],
  ])('problem %s in plain words', async (code, text) => {
    await putSetting(h, 'jobs.telegram_status', { lastOkAt: null, lastErrorCode: code, lastErrorAt: WRITTEN });
    expect(card(await page(), 'telegram')).toContain(text);
  });
});

describe('Google Sheets card', () => {
  test('not configured (no Google client on the server): says so, no button', async () => {
    Object.assign(h.env, { GOOGLE_CLIENT_ID: undefined });
    const c = card(await page(), 'sheets');
    expect(stateOf(c, 'sheets')).toBe('off');
    expect(c).toContain('Google Sheets n’est pas configuré sur ce serveur');
    expect(c).not.toContain('/sheets/connect');
    expect(c).not.toContain('class="btn');
  });

  test('not connected: what it does, the connect button, and the same-e-mail hint', async () => {
    const c = card(await page(), 'sheets');
    expect(stateOf(c, 'sheets')).toBe('disconnected');
    expect(c).toContain('Chaque commande devient une ligne dans une feuille Google de votre propre compte');
    expect(c).toContain('<a class="btn btn--primary" href="/sheets/connect">Connecter Google Sheets</a>');
    expect(c).toContain('Connectez-vous à Google avec la même adresse e-mail que votre compte admin : owner@test.local.');
  });

  test('connected, nothing written yet: account, "aucune pour l’instant", orders waiting, link to the sheet', async () => {
    await connected();
    const c = card(await page(), 'sheets');
    expect(stateOf(c, 'sheets')).toBe('connected');
    expect(c).toContain('>Connecté</span>');
    expect(c).toContain('<bdi dir="ltr">owner@test.local</bdi>');
    expect(c).toMatch(/Dernière commande écrite<\/dt><dd data-sheets-last-written[^>]*>aucune pour l’instant/);
    expect(c).toMatch(/Commandes en attente d’écriture<\/dt><dd><span class="num">1<\/span>/);
    expect(c).toContain('href="http://127.0.0.1:4420/__control/sheet?id=sheet-abc"');
    expect(c).toContain('Ouvrir la feuille');
    expect(c).not.toContain('data-reception-problem');
    expect(c).not.toContain('/sheets/connect');
  });

  test('connected, rows written: the date is the newest row of the current generation only', async () => {
    await connected();
    await h.db.prepare("INSERT INTO sheets_rows (order_id, generation, source_version, shipment_stamp, row_hash, synced_at) VALUES (?1, 3, 1, NULL, 'h', ?2)").bind(orderId, WRITTEN + 999_000).run();
    expect(card(await page(), 'sheets')).toContain('aucune pour l’instant');
    await h.db.prepare('UPDATE sheets_rows SET generation = 4, synced_at = ?1').bind(WRITTEN).run();
    const html = await page();
    expect(card(html, 'sheets')).toContain(`<time datetime="${new Date(WRITTEN).toISOString()}">`);
    // The /sheets page carries the same line.
    const sheets = await page(OWNER, '/sheets');
    expect(sheets).toMatch(new RegExp(`Dernière commande écrite</dt><dd data-sheets-last-written[^>]*><time datetime="${new Date(WRITTEN).toISOString()}">`));
  });

  test('/sheets: "aucune pour l’instant" when connected with no row; no line when disconnected', async () => {
    expect(await page(OWNER, '/sheets')).not.toContain('Dernière commande écrite');
    await connected();
    expect(await page(OWNER, '/sheets')).toMatch(/Dernière commande écrite<\/dt><dd data-sheets-last-written[^>]*>aucune pour l’instant/);
    expect(await page(USERS.ownerAr, '/sheets')).toContain('آخر طلب كُتب في الجدول');
  });

  test('needs_reconnect: what happened, reconnect with the same account, the button', async () => {
    await connected();
    await setConn("status='needs_reconnect'");
    const c = card(await page(), 'sheets');
    expect(stateOf(c, 'sheets')).toBe('needs_reconnect');
    expect(c).toContain('>Arrêté</span>');
    expect(c).toContain('Google a retiré l’accès à votre compte');
    expect(c).toContain('Reconnectez le même compte Google (owner@test.local)');
    expect(c).toContain('<a class="btn btn--primary" href="/sheets/connect">Reconnecter Google Sheets</a>');
    expect(c).not.toContain('Ouvrir la feuille');
  });

  test('sheet_lost: restore from Drive’s bin or make a new sheet, with the buttons that do it', async () => {
    await connected();
    await setConn("status='sheet_lost'");
    const c = card(await page(), 'sheets');
    expect(stateOf(c, 'sheets')).toBe('sheet_lost');
    expect(c).toContain('Restaurez-la depuis la corbeille de Google Drive');
    expect(c).toContain('action="/sheets/resync"');
    expect(c).toContain('action="/sheets/new-sheet"');
    expect(c).toContain('name="_csrf"');
    expect(c).toContain('<a class="btn btn--secondary" href="/sheets">Gérer Google Sheets</a>');
  });

  test('layout_changed: put the columns back or make a new sheet', async () => {
    await connected();
    await setConn("status='layout_changed'");
    const c = card(await page(), 'sheets');
    expect(stateOf(c, 'sheets')).toBe('layout_changed');
    expect(c).toContain('Remettez les colonnes en place');
    expect(c).toContain('action="/sheets/resync"');
    expect(c).toContain('action="/sheets/new-sheet"');
  });

  test('connected with a last error: the problem in plain words and a link to /sheets', async () => {
    await connected();
    await setConn("last_error_code='drive_full', last_error_at=?1", WRITTEN);
    const c = card(await page(), 'sheets');
    expect(c).toContain('data-reception-problem="last_error"');
    expect(c).toContain('La dernière écriture a échoué : Votre espace Google Drive est plein.');
    expect(c).toContain('<a href="/sheets">Voir le détail</a>');
  });

  test('a stopped connection on a server without a Google client: not configured, no dead button', async () => {
    await connected();
    await setConn("status='needs_reconnect'");
    Object.assign(h.env, { GOOGLE_CLIENT_SECRET: undefined });
    const c = card(await page(), 'sheets');
    expect(stateOf(c, 'sheets')).toBe('off');
    expect(c).not.toContain('/sheets/connect');
  });
});
