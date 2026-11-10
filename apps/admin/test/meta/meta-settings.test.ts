// MSET-2: the owner-only Meta settings screen. Ledger M-2 (add/change/remove), M-3 (the token never
// shown back or sent to the browser), M-4 (other roles refused), M-5 (audit rows carry no secret).
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { importSettingsKey, openMetaToken } from '@hb/db/meta-settings';
import { harness, postAs, USERS, type Harness } from '../helpers.ts';
import { auditSince, clearMeta, KEY, lastAuditId, META_KEYS, metaRows, OTHER_KEY, pieces, PIXEL, SENTINEL, wholeResponse } from './support.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let h: Harness;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => h?.close());
beforeEach(async () => {
  await clearMeta(h);
  Object.assign(h.env, { SETTINGS_ENCRYPTION_KEY: KEY, ENV: 'test' });
});

const OWNER = USERS.owner;
const html = async (email: string = OWNER) => (await h.as(email, '/meta')).text();
const saveToken = (token: string, email: string = OWNER) => postAs(h, email, '/meta/token', { token });
const savePixel = (pixelId: string, consent = 'required', email: string = OWNER) => postAs(h, email, '/meta/pixel', { pixelId, consent });

describe('M-2: the owner adds, changes and removes every Meta setting', () => {
  test('empty state: everything off, no token, no remove buttons', async () => {
    const page = await html();
    expect(page).toContain('Meta (Facebook)');
    expect(page).toContain('Désactivés : aucun ID de Pixel');
    expect(page).not.toContain('/meta/pixel/remove');
    expect(page).not.toContain('/meta/token/remove');
    expect(page).not.toContain('/meta/test-code/remove');
    expect(page).toMatch(/name="consent" value="required" checked/);
  });

  test('Pixel ID: set, change, consent off, remove', async () => {
    let res = await savePixel(PIXEL);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/meta?m=saved');
    expect(await metaRows(h)).toEqual({ metaConsentRequired: 'true', metaPixelId: `"${PIXEL}"` });
    res = await savePixel('1234567890123456', 'off');
    expect(res.status).toBe(303);
    expect(await metaRows(h)).toEqual({ metaConsentRequired: 'false', metaPixelId: '"1234567890123456"' });
    const page = await html();
    expect(page).toContain('value="1234567890123456"');
    expect(page).toMatch(/name="consent" value="off" checked/);
    expect(page).toContain('Actif sur le site à partir de la prochaine publication');
    res = await postAs(h, OWNER, '/meta/pixel/remove');
    expect(res.headers.get('location')).toBe('/meta?m=deleted');
    expect(await metaRows(h)).toEqual({ metaConsentRequired: 'false' });
  });

  test('Eastern Arabic digits are accepted for the Pixel ID', async () => {
    expect((await savePixel('١٠٠٠٠٠٠٠٠٠٠٠٠٠١')).status).toBe(303);
    expect((await metaRows(h))['metaPixelId']).toBe(`"${PIXEL}"`);
  });

  test.each([
    ['empty', '', 'Saisissez l’ID du Pixel'],
    ['14 digits', '10000000000001', '15 ou 16 chiffres'],
    ['17 digits', '10000000000000001', '15 ou 16 chiffres'],
    ['letters', '10000000000000a', '15 ou 16 chiffres'],
    ['all zeros', '000000000000000', '15 ou 16 chiffres'],
  ])('invalid Pixel ID (%s): 422, nothing written', async (_label, pixelId, message) => {
    const res = await savePixel(pixelId);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(message);
    expect(await metaRows(h)).toEqual({});
  });

  test('a consent value other than the two options: 422, nothing written', async () => {
    expect((await savePixel(PIXEL, 'maybe')).status).toBe(422);
    expect(await metaRows(h)).toEqual({});
  });

  test('server status follows the stored values', async () => {
    await savePixel(PIXEL);
    expect(await html()).toContain('Désactivés : aucun jeton d’accès');
    await saveToken(SENTINEL);
    expect(await html()).toContain('Actifs maintenant');
    Object.assign(h.env, { SETTINGS_ENCRYPTION_KEY: OTHER_KEY });
    expect(await html()).toContain('ne peut pas être lu avec la clé actuelle');
    Object.assign(h.env, { SETTINGS_ENCRYPTION_KEY: undefined });
    expect(await html()).toContain('la clé de chiffrement (SETTINGS_ENCRYPTION_KEY) n’est pas configurée');
  });

  test('token: set, change, remove; the stored value opens to the latest token', async () => {
    expect((await saveToken(SENTINEL)).status).toBe(303);
    const key = await importSettingsKey(KEY);
    expect(await openMetaToken(key, JSON.parse((await metaRows(h))['metaAccessTokenEnc']!))).toBe(SENTINEL);
    const second = `${SENTINEL.slice(0, -4)}9999`;
    expect((await saveToken(second)).status).toBe(303);
    expect(await openMetaToken(key, JSON.parse((await metaRows(h))['metaAccessTokenEnc']!))).toBe(second);
    expect(await html()).toContain('····9999');
    expect((await postAs(h, OWNER, '/meta/token/remove')).status).toBe(303);
    expect(await metaRows(h)).toEqual({});
  });

  test('test event code: set, warning shown, change, remove', async () => {
    expect((await postAs(h, OWNER, '/meta/test-code', { testEventCode: 'TEST1234' })).status).toBe(303);
    let page = await html();
    expect(page).toContain('Un code d’événement de test est enregistré');
    expect(page).toContain('value="TEST1234"');
    await postAs(h, OWNER, '/meta/test-code', { testEventCode: 'TEST5678' });
    expect((await metaRows(h))['metaTestEventCode']).toBe('"TEST5678"');
    await postAs(h, OWNER, '/meta/test-code/remove');
    page = await html();
    expect(page).not.toContain('Un code d’événement de test est enregistré');
    expect(await metaRows(h)).toEqual({});
  });

  test.each(['a b c d', 'abc', 'x'.repeat(65), 'TEST<1>'])('invalid test code %j: 422, nothing written', async (code) => {
    expect((await postAs(h, OWNER, '/meta/test-code', { testEventCode: code })).status).toBe(422);
    expect(await metaRows(h)).toEqual({});
  });

  test('Arabic UI renders the screen in Arabic, right to left', async () => {
    const page = await html(USERS.ownerAr);
    expect(page).toContain('dir="rtl"');
    expect(page).toContain('معرّف البيكسل');
  });
});

describe('M-3: the token is never shown back in full nor sent to the browser', () => {
  test('after saving: the page shows the last 4 characters only, never the token or its stored value', async () => {
    const res = await saveToken(SENTINEL);
    const post = await wholeResponse(res);
    expect(res.status).toBe(303);
    const stored = (await metaRows(h))['metaAccessTokenEnc']!;
    const blob = JSON.parse(stored) as string;
    const page = await wholeResponse(await h.as(OWNER, '/meta'));
    expect(page).toContain('····4321');
    for (const out of [post, page]) {
      for (const p of pieces(SENTINEL, 8)) expect(out).not.toContain(p);
      for (const p of pieces(blob, 16)) expect(out).not.toContain(p);
    }
    // The input is write-only.
    expect(page).toMatch(/<input[^>]*name="token"[^>]*type="password"[^>]*value=""/);
  });

  test.each([
    ['with a space', `${SENTINEL} x`],
    ['with a control character', `${SENTINEL}\u0007`],
    ['too long', SENTINEL.repeat(20)],
  ])('a refused token (%s) is not echoed in the 422 page', async (_label, token) => {
    const res = await saveToken(token);
    expect(res.status).toBe(422);
    const out = await wholeResponse(res);
    for (const p of pieces(SENTINEL, 8)) expect(out).not.toContain(p);
    expect(await metaRows(h)).toEqual({});
  });

  test('no encryption key: 409 with a clear message, nothing stored, nothing echoed', async () => {
    Object.assign(h.env, { SETTINGS_ENCRYPTION_KEY: undefined });
    const res = await saveToken(SENTINEL);
    expect(res.status).toBe(409);
    const out = await wholeResponse(res);
    expect(out).toContain('le jeton n’a pas été enregistré');
    for (const p of pieces(SENTINEL, 8)) expect(out).not.toContain(p);
    expect(await metaRows(h)).toEqual({});
  });

  test('an invalid key (16 bytes) is the same as none', async () => {
    Object.assign(h.env, { SETTINGS_ENCRYPTION_KEY: btoa('0123456789abcdef') });
    expect((await saveToken(SENTINEL)).status).toBe(409);
    expect(await metaRows(h)).toEqual({});
  });

  test('in production a test-looking token (FAKE…) is refused', async () => {
    Object.assign(h.env, { ENV: 'production' });
    try {
      const res = await saveToken('FAKE_TEST_TOKEN_0123456789');
      expect(res.status).toBe(422);
      expect(await metaRows(h)).toEqual({});
    } finally {
      Object.assign(h.env, { ENV: 'test' });
    }
  });

  test('wrong key or tampered value: the page still renders, says unreadable, shows no characters', async () => {
    await saveToken(SENTINEL);
    Object.assign(h.env, { SETTINGS_ENCRYPTION_KEY: OTHER_KEY });
    let res = await h.as(OWNER, '/meta');
    expect(res.status).toBe(200);
    let page = await res.text();
    expect(page).toContain('illisible');
    expect(page).not.toContain('4321');
    Object.assign(h.env, { SETTINGS_ENCRYPTION_KEY: KEY });
    await h.db.prepare(`UPDATE settings SET value = '"AQ=="' WHERE key = 'metaAccessTokenEnc'`).run();
    res = await h.as(OWNER, '/meta');
    expect(res.status).toBe(200);
    page = await res.text();
    expect(page).toContain('illisible');
  });
});

describe('M-4: confirmer, logistics and content can neither see nor change the Meta settings', () => {
  const OTHERS = [USERS.confirmer, USERS.logistics, USERS.content];
  const POSTS: [string, Record<string, string>][] = [
    ['/meta/pixel', { pixelId: '1234567890123456', consent: 'off' }],
    ['/meta/pixel/remove', {}],
    ['/meta/token', { token: `${SENTINEL}other` }],
    ['/meta/token/remove', {}],
    ['/meta/test-code', { testEventCode: 'OTHER999' }],
    ['/meta/test-code/remove', {}],
  ];

  test.each(OTHERS)('%s: no nav entry, GET 403, every POST 403, values and audit unchanged', async (email) => {
    await savePixel(PIXEL);
    await saveToken(SENTINEL);
    await postAs(h, OWNER, '/meta/test-code', { testEventCode: 'TEST1234' });
    const before = await metaRows(h);
    const auditId = await lastAuditId(h);

    const dash = await (await h.as(email, '/dashboard')).text();
    expect(dash).not.toContain('href="/meta"');
    const get = await h.as(email, '/meta');
    expect(get.status).toBe(403);
    const body = await get.text();
    expect(body).not.toContain(PIXEL);
    for (const [path, data] of POSTS) {
      const res = await postAs(h, email, path, data);
      expect(res.status, path).toBe(403);
    }
    expect(await metaRows(h)).toEqual(before);
    expect(await auditSince(h, auditId)).toEqual([]);
  });

  test('the owner has the nav entry', async () => {
    expect(await (await h.as(OWNER, '/dashboard')).text()).toContain('href="/meta"');
  });
});

describe('M-5: audit rows for Meta settings never carry the token or its ciphertext', () => {
  test('every action writes set/change/remove markers; no secret, no blob, no test code', async () => {
    const start = await lastAuditId(h);
    await savePixel(PIXEL);
    await saveToken(SENTINEL);
    const blob1 = JSON.parse((await metaRows(h))['metaAccessTokenEnc']!) as string;
    await saveToken(`${SENTINEL}B`);
    const blob2 = JSON.parse((await metaRows(h))['metaAccessTokenEnc']!) as string;
    await postAs(h, OWNER, '/meta/test-code', { testEventCode: 'TESTSECRET1' });
    await postAs(h, OWNER, '/meta/test-code', { testEventCode: 'TESTSECRET2' });
    await savePixel('9876543210987654', 'off');
    await postAs(h, OWNER, '/meta/token/remove');
    await postAs(h, OWNER, '/meta/test-code/remove');
    await postAs(h, OWNER, '/meta/pixel/remove');
    const rows = await auditSince(h, start);
    expect(rows.map((r) => `${r.action} ${r.entity_id}`)).toEqual([
      'metaSettings.set metaPixelId',
      'metaSettings.set metaConsentRequired',
      'metaSettings.set metaAccessTokenEnc',
      'metaSettings.change metaAccessTokenEnc',
      'metaSettings.set metaTestEventCode',
      'metaSettings.change metaTestEventCode',
      'metaSettings.change metaPixelId',
      'metaSettings.change metaConsentRequired',
      'metaSettings.remove metaAccessTokenEnc',
      'metaSettings.remove metaTestEventCode',
      'metaSettings.remove metaPixelId',
    ]);
    const text = JSON.stringify(rows);
    for (const p of pieces(SENTINEL, 8)) expect(text).not.toContain(p);
    for (const blob of [blob1, blob2]) for (const p of pieces(blob, 12)) expect(text).not.toContain(p);
    expect(text).not.toContain('TESTSECRET');
    const secretRows = rows.filter((r) => r.entity_id === 'metaAccessTokenEnc' || r.entity_id === 'metaTestEventCode');
    for (const r of secretRows) {
      for (const side of [r.before, r.after]) expect(side === null || /^\{"present":(true|false)\}$/.test(side)).toBe(true);
    }
    // The Pixel ID is public: its rows keep the values.
    expect(rows[6]!.before).toBe(`"${PIXEL}"`);
    expect(rows[6]!.after).toBe('"9876543210987654"');
  });

  test('saving the same values again writes nothing', async () => {
    await savePixel(PIXEL);
    await postAs(h, OWNER, '/meta/test-code', { testEventCode: 'TEST1234' });
    const start = await lastAuditId(h);
    await savePixel(PIXEL);
    await postAs(h, OWNER, '/meta/test-code', { testEventCode: 'TEST1234' });
    await postAs(h, OWNER, '/meta/token/remove');
    expect(await auditSince(h, start)).toEqual([]);
  });
});

test('META_KEYS covers every row this screen writes', async () => {
  await savePixel(PIXEL);
  await saveToken(SENTINEL);
  await postAs(h, OWNER, '/meta/test-code', { testEventCode: 'TEST1234' });
  expect(Object.keys(await metaRows(h)).sort()).toEqual([...META_KEYS].sort());
});
