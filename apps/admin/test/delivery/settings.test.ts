// SHIP-2 (SHIP-0 contract checks 18, 19, 20, 20a, 22b, 26): courier keys and settings, on real D1
// with the real courier stand-in.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { harness, USERS, csrfFrom, type Harness } from '../helpers.ts';
import { startStandin, type Standin } from './standin.ts';
import { postAs } from '../orders/fixtures.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const SENTINEL_ID = 'SENTINEL-standin-id';
const SENTINEL_TOKEN = 'SENTINEL-token-value-999';

let h: Harness;
let standin: Standin;
const logs: string[] = [];

async function page(email: string, path: string) {
  const res = await h.as(email, path);
  return { status: res.status, html: await res.text() };
}
const post = (email: string, path: string, data: Record<string, string> = {}) => postAs(h, email, path, data);
const saveKeys = (courier = 'yalidine', apiId = 'standin-id', apiToken = 'standin-token') => post(USERS.owner, `/delivery/settings/${courier}/keys`, { cred_apiId: apiId, cred_apiToken: apiToken });
const account = (courier = 'yalidine') => h.db.prepare('select * from courier_accounts where courier = ?').bind(courier).first<Record<string, unknown>>();
// audit_log is append-only, so each test reads only the rows written since it started.
let auditFrom = 0;
const auditRows = async () =>
  (await h.db.prepare(`select action, before, after from audit_log where entity = 'courier_accounts' and id > ? order by id`).bind(auditFrom).all<{ action: string; before: string | null; after: string | null }>()).results;

beforeAll(async () => {
  h = await harness();
  standin = await startStandin();
  for (const method of ['log', 'error', 'warn', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
  }
});
afterAll(async () => {
  standin?.stop();
  await h?.close();
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await standin.reset();
  await standin.control('yalidine/scenario', { quota: false });
  await h.db.prepare('delete from courier_accounts').run();
  await h.db.prepare(`insert or ignore into wilayas (code, name_fr, name_ar) values (16, 'Alger', 'الجزائر')`).run();
  h.env.COURIER_KEYS_KEY = KEY;
  h.env.COURIER_STANDIN_URL = standin.url;
  auditFrom = (await h.db.prepare('select coalesce(max(id), 0) as n from audit_log').first<{ n: number }>())!.n;
});
afterEach(() => {
  delete h.env.COURIER_KEYS_KEY;
});

describe('permissions (check 19)', () => {
  const paths = ['/delivery/settings', '/delivery/settings/yalidine'];
  test.each([
    ['confirmer', USERS.confirmer],
    ['logistics', USERS.logistics],
  ])('%s gets 403 on the settings pages', async (_n, email) => {
    for (const p of paths) expect((await h.as(email, p)).status).toBe(403);
  });
  test('content is refused and no one anonymous gets a page', async () => {
    for (const p of paths) {
      expect((await h.as(USERS.content, p)).status).toBe(403);
      expect((await h.as(null, p)).status).toBe(401);
    }
  });
  test('a non-owner cannot write, with a valid CSRF token', async () => {
    const res = await post(USERS.logistics, '/delivery/settings/yalidine/keys', { cred_apiId: 'a', cred_apiToken: 'b' });
    expect(res.status).toBe(403);
    expect(await account()).toBeNull();
  });
  test('owner sees the list and the page', async () => {
    const list = await page(USERS.owner, '/delivery/settings');
    expect(list.status).toBe(200);
    expect(list.html).toContain('Yalidine');
    expect((await page(USERS.owner, '/delivery/settings/yalidine')).status).toBe(200);
  });
  test('an unknown courier is 404, including prototype names', async () => {
    for (const id of ['nope', '__proto__', 'constructor']) expect((await h.as(USERS.owner, `/delivery/settings/${id}`)).status).toBe(404);
  });
});

describe('saving keys', () => {
  test('stored sealed, masked, and audited as metadata only (check 18)', async () => {
    logs.length = 0;
    expect((await saveKeys('yalidine', SENTINEL_ID, SENTINEL_TOKEN)).status).toBe(303);
    const row = (await account())!;
    expect(row['enabled']).toBe(0);
    expect(row['credentials_cipher']).toEqual(expect.any(String));
    for (const v of Object.values(row)) expect(String(v)).not.toContain('SENTINEL');
    const { html, status } = await page(USERS.owner, '/delivery/settings/yalidine');
    expect(status).toBe(200);
    expect(html).not.toContain(SENTINEL_TOKEN);
    expect(html).not.toContain(SENTINEL_ID);
    expect(html).toContain('999'); // last four of a long value is the permitted hint
    const audits = await auditRows();
    expect(audits.at(-1)!.action).toBe('courierAccount.saveKeys');
    expect(JSON.stringify(audits)).not.toContain('SENTINEL');
    expect(JSON.parse(audits.at(-1)!.after!)).toEqual({ fieldsSet: ['apiId', 'apiToken'], enabled: false });
    expect(logs.join('\n')).not.toContain('SENTINEL');
  });

  test('webhook signing secret: optional, sealed with the keys, kept when blank, never echoed (SHIP-5)', async () => {
    await saveKeys();
    expect((await account())!['credentials_hint']).not.toContain('webhookSecret');
    const res = await post(USERS.owner, '/delivery/settings/yalidine/keys', { cred_apiId: '', cred_apiToken: '', cred_webhookSecret: 'SENTINEL-webhook-secret-777' });
    expect(res.status).toBe(303);
    const row = (await account())!;
    expect(JSON.parse(String(row['credentials_hint']))).toMatchObject({ webhookSecret: '-777', apiId: '' });
    expect(String(row['credentials_cipher'])).not.toContain('SENTINEL');
    await post(USERS.owner, '/delivery/settings/yalidine/keys', { cred_apiId: 'standin-id2', cred_apiToken: '' });
    expect(JSON.parse(String((await account())!['credentials_hint']))).toMatchObject({ webhookSecret: '-777' });
    const { html } = await page(USERS.owner, '/delivery/settings/yalidine');
    expect(html).toContain('cred_webhookSecret');
    expect(html).not.toContain('SENTINEL-webhook');
    expect((await page(USERS.owner, '/delivery/settings/ecotrack-ab-delivery')).html).not.toContain('cred_webhookSecret');
    expect(JSON.stringify(await auditRows())).not.toContain('SENTINEL');
  });
  test('a short value shows only "set"', async () => {
    await saveKeys('yalidine', 'abc', 'defghi');
    const hint = JSON.parse(String((await account())!['credentials_hint']));
    expect(hint).toEqual({ apiId: '', apiToken: '' });
  });

  test('a blank field on update keeps the stored value', async () => {
    await saveKeys('yalidine', 'standin-id', 'standin-token');
    const before = (await account())!;
    expect((await post(USERS.owner, '/delivery/settings/yalidine/keys', { cred_apiId: '', cred_apiToken: '' })).status).toBe(303);
    expect((await account())!['credentials_cipher']).toBe(before['credentials_cipher']);
    expect((await post(USERS.owner, '/delivery/settings/yalidine/keys', { cred_apiId: '', cred_apiToken: 'standin-token' })).status).toBe(303);
    expect((await post(USERS.owner, '/delivery/settings/yalidine/test')).status).toBe(303);
    expect((await account())!['last_check_result']).toBe('valid');
  });

  test('a validation failure re-renders without echoing what was typed', async () => {
    const res = await post(USERS.owner, '/delivery/settings/yalidine/keys', { cred_apiId: SENTINEL_ID, cred_apiToken: '' });
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain(SENTINEL_ID);
    expect(await account()).toBeNull();
  });

  test('over-long input is refused and input fields never carry a value', async () => {
    const res = await post(USERS.owner, '/delivery/settings/yalidine/keys', { cred_apiId: 'x'.repeat(501), cred_apiToken: 'y' });
    expect(res.status).toBe(422);
    await saveKeys();
    const { html } = await page(USERS.owner, '/delivery/settings/yalidine');
    expect(html).not.toMatch(/type="password"[^>]*value="[^"]/);
  });
});

describe('the encryption key (checks 20, 26)', () => {
  test('unset: pages work, couriers off with the reason, saving refused', async () => {
    delete h.env.COURIER_KEYS_KEY;
    const { status, html } = await page(USERS.owner, '/delivery/settings/yalidine');
    expect(status).toBe(200);
    expect(html).toContain('COURIER_KEYS_KEY');
    expect((await saveKeys()).status).toBe(409);
    expect(await account()).toBeNull();
    expect((await h.as(USERS.owner, '/dashboard')).status).toBe(200);
  });
  test.each([['not base64', '%%%%'], ['wrong length', btoa('short')]])('%s: off with the reason, no 500', async (_n, bad) => {
    h.env.COURIER_KEYS_KEY = bad;
    const { status, html } = await page(USERS.owner, '/delivery/settings');
    expect(status).toBe(200);
    expect(html).toContain('COURIER_KEYS_KEY');
    expect((await saveKeys()).status).toBe(409);
  });
  test('a different key: flagged unreadable, no call, no crash, cannot enable', async () => {
    await saveKeys();
    h.env.COURIER_KEYS_KEY = OTHER_KEY;
    const { status, html } = await page(USERS.owner, '/delivery/settings/yalidine');
    expect(status).toBe(200);
    expect(html).toMatch(/illisibles/);
    const before = (await standin.state('yalidine')).readCount;
    expect((await post(USERS.owner, '/delivery/settings/yalidine/test')).status).toBe(409);
    expect((await standin.state('yalidine')).readCount).toBe(before);
    expect((await post(USERS.owner, '/delivery/settings/yalidine/enable')).status).toBe(409);
    expect((await account())!['enabled']).toBe(0);
  });
  test('ciphertext swapped between two couriers does not open', async () => {
    await saveKeys('yalidine');
    await saveKeys('guepex');
    const y = (await account('yalidine'))!;
    const g = (await account('guepex'))!;
    await h.db.batch([
      h.db.prepare('update courier_accounts set credentials_cipher = ?, credentials_iv = ? where courier = ?').bind(g['credentials_cipher'], g['credentials_iv'], 'yalidine'),
      h.db.prepare('update courier_accounts set credentials_cipher = ?, credentials_iv = ? where courier = ?').bind(y['credentials_cipher'], y['credentials_iv'], 'guepex'),
    ]);
    expect((await post(USERS.owner, '/delivery/settings/yalidine/test')).status).toBe(409);
    expect((await page(USERS.owner, '/delivery/settings/yalidine')).html).toMatch(/illisibles/);
  });
});

describe('test connection and enabling (check 22b)', () => {
  const lastCheck = async () => (await account())!['last_check_result'];
  test('valid keys', async () => {
    await saveKeys();
    expect((await post(USERS.owner, '/delivery/settings/yalidine/test')).status).toBe(303);
    expect(await lastCheck()).toBe('valid');
    expect((await page(USERS.owner, '/delivery/settings/yalidine')).html).toContain('Connexion réussie');
  });
  test('keys saved during a test: the result is not recorded against the new keys (review r1 nit 1)', async () => {
    await saveKeys();
    await standin.control('yalidine/scenario', { slowMs: 800 });
    const testing = post(USERS.owner, '/delivery/settings/yalidine/test');
    await new Promise((r) => setTimeout(r, 300));
    await saveKeys('yalidine', 'other-id', 'other-token');
    const res = await testing;
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Les clés ont changé');
    expect(await lastCheck()).toBeNull();
    expect((await auditRows()).filter((r) => r.action === 'courierAccount.test')).toHaveLength(0);
  });
  test('refused keys are invalid', async () => {
    await saveKeys('yalidine', 'wrong', 'wrong');
    await post(USERS.owner, '/delivery/settings/yalidine/test');
    expect(await lastCheck()).toBe('invalid');
  });
  test('an outage never says the key is wrong', async () => {
    await saveKeys();
    await standin.control('yalidine/scenario', { down: true });
    await post(USERS.owner, '/delivery/settings/yalidine/test');
    expect(await lastCheck()).toBe('unavailable');
    const { html } = await page(USERS.owner, '/delivery/settings/yalidine');
    expect(html).toContain('ce n’est pas un problème de clés');
    expect(html).not.toContain('Clés refusées');
  });
  test('rate limited', async () => {
    await saveKeys();
    await standin.control('yalidine/scenario', { read: '429' });
    await post(USERS.owner, '/delivery/settings/yalidine/test');
    expect(await lastCheck()).toBe('rate_limited');
  });
  test('keys are checked through the guard: no stand-in URL, no request leaves', async () => {
    await saveKeys();
    delete h.env.COURIER_STANDIN_URL;
    const before = (await standin.state('yalidine')).readCount;
    await post(USERS.owner, '/delivery/settings/yalidine/test');
    expect(await lastCheck()).toBe('unavailable');
    expect((await standin.state('yalidine')).readCount).toBe(before);
  });
  test('enable needs keys; disable and remove work and are audited', async () => {
    expect((await post(USERS.owner, '/delivery/settings/yalidine/enable')).status).toBe(409);
    await saveKeys();
    // Yalidine needs an origin wilaya on every parcel: refused until it is set.
    expect((await post(USERS.owner, '/delivery/settings/yalidine/enable')).status).toBe(409);
    expect((await account())!['enabled']).toBe(0);
    expect((await post(USERS.owner, '/delivery/settings/yalidine/config', { originWilaya: '16' })).status).toBe(303);
    expect((await post(USERS.owner, '/delivery/settings/yalidine/enable')).status).toBe(303);
    expect((await account())!['enabled']).toBe(1);
    expect((await post(USERS.owner, '/delivery/settings/yalidine/disable')).status).toBe(303);
    expect((await account())!['enabled']).toBe(0);
    await post(USERS.owner, '/delivery/settings/yalidine/enable');
    expect((await post(USERS.owner, '/delivery/settings/yalidine/remove-keys')).status).toBe(303);
    expect(await account()).toMatchObject({ enabled: 0, credentials_cipher: null, credentials_iv: null });
    expect((await auditRows()).map((a) => a.action)).toEqual(['courierAccount.saveKeys', 'courierAccount.config', 'courierAccount.enable', 'courierAccount.disable', 'courierAccount.enable', 'courierAccount.removeKeys']);
  });
  test('an unconfirmed tenant cannot be enabled by direct POST until a valid check', async () => {
    const { listCouriers } = await import('@hb/couriers');
    const tenant = listCouriers().find((a) => a.confidence.baseUrl === 'unconfirmed');
    expect(tenant).toBeDefined();
    const id = tenant!.id;
    await standin.control(`${id}/scenario`, { quota: false });
    const fields = Object.fromEntries(tenant!.capabilities.credentialFields.map((f) => [`cred_${f.key}`, 'standin-token']));
    expect((await post(USERS.owner, `/delivery/settings/${id}/keys`, fields)).status).toBe(303);
    expect((await post(USERS.owner, `/delivery/settings/${id}/enable`)).status).toBe(409);
    expect((await account(id))!['enabled']).toBe(0);
    await post(USERS.owner, `/delivery/settings/${id}/test`);
    expect((await account(id))!['last_check_result']).toBe('valid');
    expect((await post(USERS.owner, `/delivery/settings/${id}/enable`)).status).toBe(303);
    expect((await account(id))!['enabled']).toBe(1);
    // New keys are unproven again, so an unconfirmed tenant goes off.
    await post(USERS.owner, `/delivery/settings/${id}/keys`, fields);
    expect((await account(id))!['enabled']).toBe(0);
  });
});

describe('webhook token', () => {
  const TOKEN_IN_PAGE = /\/api\/courier-hook\/yalidine\/([A-Za-z0-9_-]{43})/;
  test('shown once, stored only as a hash, absent from audit and logs', async () => {
    logs.length = 0;
    const res = await post(USERS.owner, '/delivery/settings/yalidine/webhook-token');
    expect(res.status).toBe(200);
    const token = TOKEN_IN_PAGE.exec(await res.text())![1]!;
    const row = (await account())!;
    expect(row['webhook_token_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(await auditRows())).not.toContain(token);
    expect(logs.join('\n')).not.toContain(token);
    const after = await page(USERS.owner, '/delivery/settings/yalidine');
    expect(after.html).not.toContain(token);
    expect(after.html).not.toMatch(TOKEN_IN_PAGE);
  });
  test('rotate replaces the hash; remove clears it; a no-webhook courier is 404', async () => {
    const first = TOKEN_IN_PAGE.exec(await (await post(USERS.owner, '/delivery/settings/yalidine/webhook-token')).text())![1]!;
    const firstHash = (await account())!['webhook_token_hash'];
    const second = TOKEN_IN_PAGE.exec(await (await post(USERS.owner, '/delivery/settings/yalidine/webhook-token')).text())![1]!;
    expect(second).not.toBe(first);
    expect((await account())!['webhook_token_hash']).not.toBe(firstHash);
    await post(USERS.owner, '/delivery/settings/yalidine/webhook-token/remove');
    expect((await account())!['webhook_token_hash']).toBeNull();
    const { listCouriers } = await import('@hb/couriers');
    const none = listCouriers().find((a) => a.capabilities.webhook === 'none');
    if (none) expect((await post(USERS.owner, `/delivery/settings/${none.id}/webhook-token`)).status).toBe(404);
  });
});

describe('courier settings form', () => {
  test('origin wilaya is validated against the wilayas table', async () => {
    const { listCouriers } = await import('@hb/couriers');
    const needs = listCouriers().find((a) => a.capabilities.needsOriginWilaya);
    expect(needs).toBeDefined();
    const res = await post(USERS.owner, `/delivery/settings/${needs!.id}/config`, { originWilaya: '999' });
    expect(res.status).toBe(422);
  });
  test('the confidence notes of a courier are on its page', async () => {
    const { html } = await page(USERS.owner, '/delivery/settings/guepex');
    expect(html).toContain('Liste de statuts reprise de Yalidine');
  });
  test('every confidence note of every courier has French and Arabic text (review r1 nit 2)', async () => {
    const { listCouriers } = await import('@hb/couriers');
    const { m, hasDeliveryMessage } = await import('../../src/routes/delivery/messages.ts');
    const codes = new Set(listCouriers().flatMap((a) => a.confidence.notes));
    for (const code of codes) {
      expect(hasDeliveryMessage(`note.${code}`), code).toBe(true);
      for (const lang of ['fr', 'ar'] as const) expect(m(lang)(`note.${code}` as never), `${lang} ${code}`).not.toContain('note.');
    }
    for (const id of ['noest', 'maystro', 'zr-express']) {
      for (const email of [USERS.owner, USERS.ownerAr]) expect((await page(email, `/delivery/settings/${id}`)).html).not.toMatch(/note\.[a-z_]+/);
    }
  });
  test('Arabic page renders', async () => {
    const { status, html } = await page(USERS.ownerAr, '/delivery/settings');
    expect(status).toBe(200);
    expect(html).toContain('شركات التوصيل');
    void csrfFrom;
  });
});
