// CART-2: the storefront cart switch in the owner-only store settings (ledger C-3, C-4, C-5).
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { exportCatalogSnapshot } from '@hb/db/export';
import { createDb } from '@hb/db';
import { harness, postAs, USERS, type Harness } from '../helpers.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => h?.close());
// audit_log is append-only: each test only looks at the rows written after it started.
let auditMark = 0;
beforeEach(async () => {
  await h.db.prepare("delete from settings where key = 'cartEnabled'").run();
  auditMark = (await h.db.prepare('select coalesce(max(id), 0) as m from audit_log').first<{ m: number }>())?.m ?? 0;
});

async function cartSetting(): Promise<unknown> {
  const r = await h.db.prepare("select value from settings where key = 'cartEnabled'").first<{ value: string }>();
  return r ? JSON.parse(r.value) : undefined;
}
async function cartAudits() {
  return (
    await h.db
      .prepare("select action, entity, entity_id, before, after, actor_email from audit_log where entity_id = 'cartEnabled' and id > ? order by id")
      .bind(auditMark)
      .all<Record<string, string | null>>()
  ).results;
}
const page = async (email: string) => (await h.as(email, '/settings')).text();

describe('cart switch: owner', () => {
  test('missing key shows "on"; the page has a clear on/off control and the next-publish note (FR)', async () => {
    const html = await page(USERS.owner);
    expect(html).toContain('data-cart-switch');
    expect(html).toMatch(/<input type="radio" class="check" id="f-cartEnabled-on" name="cartEnabled" value="on" checked=""/);
    expect(html).toMatch(/<input type="radio" class="check" id="f-cartEnabled-off" name="cartEnabled" value="off"(?! checked)/);
    expect(html).toContain('action="/settings/cart"');
    expect(html).toContain('Prend effet à la prochaine publication.');
    expect(html).toContain('<a href="/publish">Publier le site</a>');
  });

  test('the next-publish note in Arabic (owner with Arabic UI)', async () => {
    const html = await page(USERS.ownerAr);
    expect(html).toContain('يسري التغيير عند النشر القادم.');
    expect(html).toContain('<a href="/publish">نشر الموقع</a>');
    expect(html).toContain('سلة المتجر');
  });

  test('turn off then back on: stored as a JSON boolean, audited before → after, page follows', async () => {
    const off = await postAs(h, USERS.owner, '/settings/cart', { cartEnabled: 'off' });
    expect(off.status).toBe(303);
    expect(off.headers.get('Location')).toMatch(/^\/settings\?/);
    expect(await cartSetting()).toBe(false);
    expect(await page(USERS.owner)).toMatch(/id="f-cartEnabled-off" name="cartEnabled" value="off" checked=""/);

    expect((await postAs(h, USERS.owner, '/settings/cart', { cartEnabled: 'on' })).status).toBe(303);
    expect(await cartSetting()).toBe(true);
    const rows = await cartAudits();
    expect(rows.map((r) => [r['action'], r['entity'], r['before'], r['after'], r['actor_email']])).toEqual([
      ['settings.update', 'settings', null, 'false', USERS.owner],
      ['settings.update', 'settings', 'false', 'true', USERS.owner],
    ]);
  });

  test('saving the same value writes nothing; a missing key is written explicitly', async () => {
    expect((await postAs(h, USERS.owner, '/settings/cart', { cartEnabled: 'on' })).status).toBe(303);
    expect(await cartSetting()).toBe(true);
    expect((await postAs(h, USERS.owner, '/settings/cart', { cartEnabled: 'on' })).status).toBe(303);
    expect((await cartAudits()).length).toBe(1);
  });

  test('an invalid value is refused with 422 and nothing changes', async () => {
    await postAs(h, USERS.owner, '/settings/cart', { cartEnabled: 'off' });
    for (const bad of [{ cartEnabled: 'maybe' }, {}, { cartEnabled: 'true' }]) {
      const res = await postAs(h, USERS.owner, '/settings/cart', bad);
      expect(res.status).toBe(422);
      expect(await res.text()).toContain('Choisissez « Activé » ou « Désactivé ».');
    }
    expect(await cartSetting()).toBe(false);
    expect((await cartAudits()).length).toBe(1);
  });

  test('a store-settings save does not touch the cart switch', async () => {
    await postAs(h, USERS.owner, '/settings/cart', { cartEnabled: 'off' });
    const res = await postAs(h, USERS.owner, '/settings', {
      storeName_fr: 'HB Destockage',
      storeName_ar: 'إتش بي ديستوكاج',
      contactPhone: '0560417403',
      whatsapp: '0779942022',
      contactEmail: '',
      orderMaxUnanswered: '3',
      callRetryMinutes: '30',
      unreachableRetryMinutes: '240',
      lowStockThreshold: '3',
      delayedParcelDays: '5',
    });
    expect(res.status).toBe(303);
    expect(await cartSetting()).toBe(false);
  });

  test('the publish export reads the switch (takes effect at the next publish)', async () => {
    const minimal = [
      "insert into settings (key, value) values ('storeName', '{\"fr\":\"HB\",\"ar\":\"HB\"}') on conflict (key) do nothing",
      "insert into settings (key, value) values ('contactPhone', '\"0560417403\"') on conflict (key) do nothing",
      "insert into settings (key, value) values ('whatsapp', '\"213779942022\"') on conflict (key) do nothing",
    ];
    for (const s of minimal) await h.db.prepare(s).run();
    const db = createDb(h.db);
    const exp = async () => (await exportCatalogSnapshot(db, { integrity: { requireAllWilayas: false } })).settings.cartEnabled;
    expect(await exp()).toBe(true);
    await postAs(h, USERS.owner, '/settings/cart', { cartEnabled: 'off' });
    expect(await exp()).toBe(false);
  });
});

describe('cart switch: other roles (C-5)', () => {
  for (const [role, email] of [
    ['confirmer', USERS.confirmer],
    ['logistics', USERS.logistics],
    ['content', USERS.content],
  ] as const) {
    test(`${role}: not rendered, POST refused 403, value unchanged`, async () => {
      await postAs(h, USERS.owner, '/settings/cart', { cartEnabled: 'on' });
      const get = await h.as(email, '/settings');
      expect(get.status).toBe(403);
      const html = await get.text();
      expect(html).not.toContain('data-cart-switch');
      expect(html).not.toContain('cartEnabled');
      for (const pageUrl of ['/dashboard', '/orders']) {
        const other = await h.as(email, pageUrl);
        expect(await other.text()).not.toContain('cartEnabled');
      }
      for (const value of ['off', 'on']) {
        const res = await postAs(h, email, '/settings/cart', { cartEnabled: value });
        expect(res.status).toBe(403);
      }
      expect(await cartSetting()).toBe(true);
      expect((await cartAudits()).length).toBe(1);
    });
  }
});
