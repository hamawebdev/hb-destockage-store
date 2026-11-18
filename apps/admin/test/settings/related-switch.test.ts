// BOOT-45 / D-030: the "you may also like" switch in the owner's store settings, next to the cart switch.
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
let auditMark = 0;
beforeEach(async () => {
  await h.db.prepare("delete from settings where key in ('relatedEnabled', 'cartEnabled')").run();
  auditMark = (await h.db.prepare('select coalesce(max(id), 0) as m from audit_log').first<{ m: number }>())?.m ?? 0;
});

async function setting(key: string): Promise<unknown> {
  const r = await h.db.prepare('select value from settings where key = ?').bind(key).first<{ value: string }>();
  return r ? JSON.parse(r.value) : undefined;
}
async function audits() {
  return (
    await h.db
      .prepare("select action, entity_id, before, after, actor_email from audit_log where entity_id = 'relatedEnabled' and id > ? order by id")
      .bind(auditMark)
      .all<Record<string, string | null>>()
  ).results;
}
const page = async (email: string) => (await h.as(email, '/settings')).text();
const checked = (html: string, value: 'on' | 'off') =>
  new RegExp(`<input type="radio" class="check" id="f-relatedEnabled-${value}" name="relatedEnabled" value="${value}" checked=""`).test(html);

describe('"you may also like" switch: owner', () => {
  test('starts on (key missing); one on/off control with the publish note and a link to /publish (FR)', async () => {
    const html = await page(USERS.owner);
    expect(html).toContain('data-related-switch');
    expect(html).toContain('« Vous aimerez aussi » sur les pages produit');
    expect(checked(html, 'on')).toBe(true);
    expect(checked(html, 'off')).toBe(false);
    expect(html).toContain('action="/settings/related"');
    expect(html).toContain('Prend effet à la prochaine publication.');
    expect(html).toMatch(/data-related-publish-note[\s\S]*?<a href="\/publish">Publier le site<\/a>/);
    // The cart switch is still there, unchanged.
    expect(html).toContain('data-cart-switch');
    expect(html).toContain('action="/settings/cart"');
  });

  test('in Arabic (owner with Arabic UI)', async () => {
    const html = await page(USERS.ownerAr);
    expect(html).toContain('قسم «قد يعجبك أيضاً» في صفحات المنتجات');
    expect(html).toContain('يسري التغيير عند النشر القادم.');
    expect(html).toContain('ظاهر');
    expect(html).toContain('مخفي');
  });

  test('turn off then back on: JSON boolean, audited, the page follows, the cart switch is untouched', async () => {
    const off = await postAs(h, USERS.owner, '/settings/related', { relatedEnabled: 'off' });
    expect(off.status).toBe(303);
    expect(await setting('relatedEnabled')).toBe(false);
    const html = await page(USERS.owner);
    expect(checked(html, 'off')).toBe(true);
    expect(html).toContain('Réglage enregistré : section masquée.');
    expect((await postAs(h, USERS.owner, '/settings/related', { relatedEnabled: 'on' })).status).toBe(303);
    expect(await setting('relatedEnabled')).toBe(true);
    expect((await audits()).map((r) => [r['action'], r['before'], r['after'], r['actor_email']])).toEqual([
      ['settings.update', null, 'false', USERS.owner],
      ['settings.update', 'false', 'true', USERS.owner],
    ]);
    expect(await setting('cartEnabled')).toBeUndefined();
  });

  test('an invalid value is refused with 422 and nothing changes', async () => {
    await postAs(h, USERS.owner, '/settings/related', { relatedEnabled: 'off' });
    for (const bad of [{ relatedEnabled: 'maybe' }, {}, { cartEnabled: 'off' }]) {
      const res = await postAs(h, USERS.owner, '/settings/related', bad);
      expect(res.status).toBe(422);
      expect(await res.text()).toContain('Choisissez « Affichée » ou « Masquée ».');
    }
    expect(await setting('relatedEnabled')).toBe(false);
    expect(await setting('cartEnabled')).toBeUndefined();
    expect((await audits()).length).toBe(1);
  });

  test('the publish export reads the switch (the site changes at the next publish)', async () => {
    const minimal = [
      "insert into settings (key, value) values ('storeName', '{\"fr\":\"HB\",\"ar\":\"HB\"}') on conflict (key) do nothing",
      "insert into settings (key, value) values ('contactPhone', '\"0560417403\"') on conflict (key) do nothing",
      "insert into settings (key, value) values ('whatsapp', '\"213779942022\"') on conflict (key) do nothing",
    ];
    for (const s of minimal) await h.db.prepare(s).run();
    const db = createDb(h.db);
    const exp = async () => (await exportCatalogSnapshot(db, { integrity: { requireAllWilayas: false } })).settings.relatedEnabled;
    expect(await exp()).toBe(true);
    await postAs(h, USERS.owner, '/settings/related', { relatedEnabled: 'off' });
    expect(await exp()).toBe(false);
  });
});

describe('"you may also like" switch: other roles', () => {
  for (const [role, email] of [
    ['confirmer', USERS.confirmer],
    ['logistics', USERS.logistics],
    ['content', USERS.content],
  ] as const) {
    test(`${role}: POST refused 403, value unchanged`, async () => {
      const res = await postAs(h, email, '/settings/related', { relatedEnabled: 'off' });
      expect(res.status).toBe(403);
      expect(await setting('relatedEnabled')).toBeUndefined();
    });
  }
});
