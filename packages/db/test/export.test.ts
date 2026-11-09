// DB-5 (second half): exportCatalogSnapshot on workerd D1.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fixtureSnapshot, parseSnapshot, type CatalogSnapshot } from '@hb/catalog';
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
    settings: s.settings as unknown as Record<string, unknown>,
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
    expect(Object.keys(out.settings).sort()).toEqual([...STOREFRONT_SETTINGS_KEYS].sort());
    expect(json).not.toContain('Secret Customer');
    expect(json).not.toContain('661234567');
    expect(json).not.toContain('@dev.local');
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
