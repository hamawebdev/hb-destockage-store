// DB-5 (second half): exportCatalogSnapshot on workerd D1.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fixtureSnapshot, parseSnapshot, settingsToKeyValues, type CatalogSnapshot } from '@hb/catalog';
import { exportCatalogSnapshot } from '../src/export.ts';
import { buildSeedStatements, type SeedInput } from '../src/seed/build.ts';
import { loadSeedInput } from '../src/seed/load.ts';
import { DEV_ADMIN_USERS } from '../src/seed/dev-users.ts';
import { STOREFRONT_SETTINGS_KEYS, type Db } from '../src/index.ts';
import { exec, freshD1, type RawD1 } from './d1.ts';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let d1: RawD1;
let db: Db;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ d1, db, dispose } = await freshD1());
});
afterEach(async () => dispose?.());

async function load(input: SeedInput) {
  for (const s of buildSeedStatements(input)) await d1.prepare(s.sql).bind(...s.params).run();
}

function fromSnapshot(s: CatalogSnapshot): SeedInput {
  return {
    wilayas: s.wilayas.map((w) => ({ code: w.code, name_fr: w.name.fr, name_ar: w.name.ar, courier_code: w.courierCode })),
    communes: [],
    fees: [],
    categories: s.categories,
    products: s.products,
    contentPages: s.contentPages,
    settings: settingsToKeyValues(s.settings),
    adminUsers: DEV_ADMIN_USERS,
  };
}

describe('exportCatalogSnapshot', () => {
  test('round trip: CAT-1 fixtureSnapshot → D1 (seed builder) → export gives the same snapshot back', async () => {
    await load(fromSnapshot(fixtureSnapshot));
    const out = await exportCatalogSnapshot(db, { generatedAt: 1, publishRunId: null, integrity: { requireAllWilayas: false } });
    expect(out.meta).toEqual({ version: 1, source: 'd1', generatedAt: 1, publishRunId: null });
    expect({ ...out, meta: fixtureSnapshot.meta }).toEqual(fixtureSnapshot);
  });

  test('carries the prices printed on a photo (DB-8), only on the images that have some', async () => {
    await load(fromSnapshot(fixtureSnapshot));
    await exec(d1, "update images set printed_prices_dzd = '[14600]' where id = 5021");
    const out = await exportCatalogSnapshot(db, { integrity: { requireAllWilayas: false } });
    const images = out.products.flatMap((p) => p.images);
    expect(images.filter((i) => i.printedPricesDzd !== undefined).map((i) => [i.id, i.printedPricesDzd])).toEqual([[5021, [14600]]]);
  });

  test('exports every status (drafts and archived too) and carries no customer or order data', async () => {
    await load(fromSnapshot(fixtureSnapshot));
    await exec(
      d1,
      `insert into wilayas (code, name_fr, name_ar) values (31, 'Oran', 'وهران') on conflict do nothing;
       insert into communes (id, wilaya_code, name_fr, name_ar) values (3101, 31, 'Oran', 'وهران');
       insert into customers (id, phone_e164, name, notes) values (1, '+213661234567', 'Secret Customer', 'vip');
       insert into settings (key, value) values ('jobs.backup_status', '{"health":"ok"}'), ('jobs.notify_invalid', '{"count":1,"lastAt":1}')`,
    );
    const out = await exportCatalogSnapshot(db, { integrity: { requireAllWilayas: false } });
    expect(new Set(out.products.map((p) => p.status))).toEqual(new Set(fixtureSnapshot.products.map((p) => p.status)));
    const json = JSON.stringify(out);
    // D1 keys → snapshot fields: metaPixelId + metaConsentRequired become metaPixel (CART-1).
    const snapshotFields = [...STOREFRONT_SETTINGS_KEYS.filter((k) => k !== 'metaPixelId' && k !== 'metaConsentRequired'), 'metaPixel'];
    expect(Object.keys(out.settings).sort()).toEqual(snapshotFields.sort());
    expect(json).not.toContain('Secret Customer');
    expect(json).not.toContain('661234567');
    expect(json).not.toContain('@dev.local');
  });

  test('CART-1: cartEnabled missing ⇒ true; false is carried', async () => {
    await load(fromSnapshot(fixtureSnapshot));
    await exec(d1, "delete from settings where key = 'cartEnabled'");
    expect((await exportCatalogSnapshot(db, { integrity: { requireAllWilayas: false } })).settings.cartEnabled).toBe(true);
    await exec(d1, "insert into settings (key, value) values ('cartEnabled', 'false')");
    expect((await exportCatalogSnapshot(db, { integrity: { requireAllWilayas: false } })).settings.cartEnabled).toBe(false);
  });

  test('CART-1: metaPixel from metaPixelId + metaConsentRequired (missing ⇒ true); no or empty ID ⇒ null', async () => {
    await load(fromSnapshot(fixtureSnapshot));
    const exp = async () => (await exportCatalogSnapshot(db, { integrity: { requireAllWilayas: false } })).settings.metaPixel;
    await exec(d1, "delete from settings where key in ('metaPixelId', 'metaConsentRequired')");
    expect(await exp()).toBeNull();
    await exec(d1, `insert into settings (key, value) values ('metaPixelId', '"123456789012345"')`);
    expect(await exp()).toEqual({ pixelId: '123456789012345', consentRequired: true });
    await exec(d1, "insert into settings (key, value) values ('metaConsentRequired', 'false')");
    expect(await exp()).toEqual({ pixelId: '123456789012345', consentRequired: false });
    await exec(d1, `update settings set value = '""' where key = 'metaPixelId'`);
    expect(await exp()).toBeNull();
  });

  test('CART-1: an invalid Pixel ID fails the export with a clear message', async () => {
    await load(fromSnapshot(fixtureSnapshot));
    await exec(d1, `insert into settings (key, value) values ('metaPixelId', '"00000000000000000"') on conflict (key) do update set value = excluded.value`);
    await expect(exportCatalogSnapshot(db, { integrity: { requireAllWilayas: false } })).rejects.toThrow(/settings\.metaPixel\.pixelId: metaPixelId must be 15 or 16 digits/);
  });

  test('CART-1: Meta server secrets (metaAccessTokenEnc, metaTestEventCode, any metaAccess*) never reach the snapshot', async () => {
    await load(fromSnapshot(fixtureSnapshot));
    const SENTINEL = 'SENTINEL-meta-secret-91c4';
    await exec(
      d1,
      `insert into settings (key, value) values
         ('metaPixelId', '"123456789012345"'),
         ('metaAccessTokenEnc', '"${SENTINEL}"'),
         ('metaAccessTokenIv', '"${SENTINEL}"'),
         ('metaAccessTokenUpdatedAt', '{"by":"${SENTINEL}"}'),
         ('metaTestEventCode', '"${SENTINEL}"')
       on conflict (key) do update set value = excluded.value`,
    );
    const out = await exportCatalogSnapshot(db, { integrity: { requireAllWilayas: false } });
    expect(out.settings.metaPixel).toEqual({ pixelId: '123456789012345', consentRequired: true });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  test('TGS-1: the Telegram rows (settings, sealed bot token, jobs status) never reach the snapshot', async () => {
    await load(fromSnapshot(fixtureSnapshot));
    const SENTINEL = 'SENTINEL-telegram-5d2e';
    await exec(
      d1,
      `insert into settings (key, value) values
         ('telegram', '{"enabled":true,"chats":[{"id":"42","title":"${SENTINEL}"}],"tokenLast4":"${SENTINEL}"}'),
         ('telegramBotTokenEnc', '"${SENTINEL}.${SENTINEL}"'),
         ('jobs.telegram_status', '{"lastErrorCode":"${SENTINEL}"}')
       on conflict (key) do update set value = excluded.value`,
    );
    const out = await exportCatalogSnapshot(db, { integrity: { requireAllWilayas: false } });
    const json = JSON.stringify(out);
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toMatch(/telegram/i);
    // The deploy export copies exactly these keys out of production (orchestrate settingsSql refuses any other).
    const keys = STOREFRONT_SETTINGS_KEYS.map((k) => `'${k}'`).join(', ');
    const copied = (await d1.prepare(`select key, value from settings where key in (${keys})`).all<{ key: string; value: string }>()).results;
    expect(JSON.stringify(copied)).not.toContain(SENTINEL);
    expect(copied.some((r) => /telegram/i.test(r.key))).toBe(false);
  });

  test('CART-1: the deploy path agrees: copying only STOREFRONT_SETTINGS_KEYS rows (orchestrate settingsSql) exports the same settings', async () => {
    await load(fromSnapshot(fixtureSnapshot));
    await exec(
      d1,
      `insert into settings (key, value) values
         ('cartEnabled', 'false'), ('metaPixelId', '"123456789012345"'), ('metaConsentRequired', 'false'),
         ('metaAccessTokenEnc', '"SENTINEL-deploy-path"'), ('metaTestEventCode', '"SENTINEL-deploy-path"'), ('orderMaxUnanswered', '3')
       on conflict (key) do update set value = excluded.value`,
    );
    const direct = await exportCatalogSnapshot(db, { generatedAt: 1, integrity: { requireAllWilayas: false } });
    // What the pipeline does in production: SELECT … WHERE key IN (STOREFRONT_SETTINGS_KEYS), then load
    // those rows into the build's local D1 (which has no other settings) and export there.
    const keys = STOREFRONT_SETTINGS_KEYS.map((k) => `'${k}'`).join(', ');
    const copied = (await d1.prepare(`select key, value from settings where key in (${keys})`).all<{ key: string; value: string }>()).results;
    expect(copied.map((r) => r.key).sort()).toEqual([...STOREFRONT_SETTINGS_KEYS].sort());
    await exec(d1, 'delete from settings');
    for (const r of copied) await d1.prepare('insert into settings (key, value) values (?, ?)').bind(r.key, r.value).run();
    const viaDeploy = await exportCatalogSnapshot(db, { generatedAt: 1, integrity: { requireAllWilayas: false } });
    expect(viaDeploy.settings).toEqual(direct.settings);
    expect(direct.settings.cartEnabled).toBe(false);
    expect(direct.settings.metaPixel).toEqual({ pixelId: '123456789012345', consentRequired: false });
    expect(JSON.stringify(direct)).not.toContain('SENTINEL-deploy-path');
  });

  test('a missing required setting fails the export (never a silent default)', async () => {
    await load(fromSnapshot(fixtureSnapshot));
    await exec(d1, "delete from settings where key = 'contactPhone'");
    await expect(exportCatalogSnapshot(db, { integrity: { requireAllWilayas: false } })).rejects.toThrow(/settings\.contactPhone is missing/);
  });

  test('CAT-1 integrity is enforced on export: by default all 69 wilayas are required', async () => {
    await load(fromSnapshot(fixtureSnapshot));
    await expect(exportCatalogSnapshot(db)).rejects.toThrow(/wilaya/i);
  });
});

// Real data: HB_SEED_ROOT, else the repo itself once data/ is there, so it runs in npm test and the gate.
const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const root = process.env.HB_SEED_ROOT ?? repoRoot;
describe.skipIf(!existsSync(join(root, 'data', 'catalog', 'validate.mjs')))('exportCatalogSnapshot on the real seed', () => {
  test('seeded D1 exports a snapshot that passes full CAT-1 validation (69 wilayas)', async () => {
    const { input } = await loadSeedInput(root);
    await load(input);
    const out = await exportCatalogSnapshot(db, { publishRunId: 7 });
    expect(out.wilayas).toHaveLength(69);
    expect(out.products).toHaveLength(input.products.length);
    expect(out.meta.publishRunId).toBe(7);
    expect(() => parseSnapshot(JSON.parse(JSON.stringify(out)), 'json round trip')).not.toThrow();
  }, 900_000); // seeding ~2,300 statements one by one over the local proxy: slow on a loaded machine
});
