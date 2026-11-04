import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { fixtureSnapshot, SnapshotError } from '../src/index.ts';
import { fromExport, fromSeed, loadSnapshot, toSnapshotWilayas } from '../src/sources.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const put = async (root: string, rel: string, data: unknown): Promise<void> => {
  const f = join(root, rel);
  await mkdir(join(f, '..'), { recursive: true });
  await writeFile(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};

/** A repo tree laid out like data/ with the fixture split into seed/geo/brand files. */
async function fakeRepo(opts: { geo?: 'json' | 'module' | 'none'; content?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hb-catalog-'));
  dirs.push(root);
  const s = fixtureSnapshot;
  await put(root, 'data/catalog/categories.json', s.categories);
  await put(root, 'data/catalog/settings.json', s.settings);
  for (const p of s.products) await put(root, `data/catalog/products/${p.slug.fr}.json`, p);
  await put(root, 'data/catalog/provenance.json', { ignored: true });
  const rows = ALL_WILAYAS.map((w) => ({ code: w.code, name_ar: w.name.ar, name_fr: w.name.fr }));
  if ((opts.geo ?? 'json') === 'json') await put(root, 'data/geo/wilayas.json', rows);
  if (opts.geo === 'module') await put(root, 'data/geo/index.mjs', `export const loadWilayas = () => ${JSON.stringify(rows)};`);
  if (opts.content ?? true) for (const c of s.contentPages) await put(root, `data/content/${c.key}.json`, c);
  return root;
}

/** The fixture's 3 wilayas plus generated names for the other 66 (fromSeed requires all 69). */
const ALL_WILAYAS = Array.from({ length: 69 }, (_, i) => {
  const code = i + 1;
  return fixtureSnapshot.wilayas.find((w) => w.code === code) ?? { code, name: { ar: `ولاية ${code}`, fr: `Wilaya ${code}` }, courierCode: null };
});

const byId = <T extends { id: number }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => a.id - b.id);

describe('fromSeed', () => {
  test('assembles the same catalogue as the fixture', async () => {
    const snap = await fromSeed(await fakeRepo(), { generatedAt: 42 });
    expect(snap.meta).toEqual({ version: 1, source: 'seed', generatedAt: 42, publishRunId: null });
    expect(snap.categories).toEqual(fixtureSnapshot.categories);
    expect(byId(snap.products)).toEqual(byId(fixtureSnapshot.products));
    expect(byId(snap.contentPages)).toEqual(byId(fixtureSnapshot.contentPages));
    expect(snap.settings).toEqual(fixtureSnapshot.settings);
    expect(snap.wilayas).toEqual(ALL_WILAYAS);
  });

  test("prefers geo's loadWilayas() module", async () => {
    const snap = await fromSeed(await fakeRepo({ geo: 'module' }), { generatedAt: 1 });
    expect(snap.wilayas).toEqual(ALL_WILAYAS);
  });

  test('missing geo/content fail unless partial', async () => {
    const root = await fakeRepo({ geo: 'none', content: false });
    await expect(fromSeed(root)).rejects.toThrow(SnapshotError);
    const snap = await fromSeed(root, { partial: true, generatedAt: 1 });
    expect(snap.wilayas).toEqual([]);
    expect(snap.contentPages).toEqual([]);
  });

  test('issues name the product file', async () => {
    const root = await fakeRepo();
    const p = { ...fixtureSnapshot.products[1]!, variants: [{ ...fixtureSnapshot.products[1]!.variants[0]!, priceDzd: 0 }] };
    await put(root, `data/catalog/products/${p.slug.fr}.json`, p);
    const err = await fromSeed(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotError);
    expect((err as SnapshotError).issues.map((i) => i.path).join()).toContain('data/catalog/products/poele-28-cm.json');
  });

  test('invalid JSON names the file', async () => {
    const root = await fakeRepo();
    await put(root, 'data/catalog/settings.json', '{ nope');
    await expect(fromSeed(root)).rejects.toThrow(/settings\.json.*invalid JSON|invalid JSON/s);
  });

  test("runs seed's validateSeed and fails on its issues", async () => {
    const root = await fakeRepo();
    await put(root, 'data/catalog/validate.mjs', `export const validateSeed = () => [{ path: 'data/photos/x.jpg', message: 'missing photo' }];`);
    await expect(fromSeed(root)).rejects.toThrow(/missing photo/);
    await expect(fromSeed(root, { seedValidation: false, generatedAt: 1 })).resolves.toBeTruthy();
  });
});

describe('fromExport / loadSnapshot', () => {
  test('fromExport validates the export JSON', async () => {
    const root = await fakeRepo();
    const exp = { ...fixtureSnapshot, meta: { ...fixtureSnapshot.meta, source: 'd1', publishRunId: 7 } };
    await put(root, 'out/snapshot.json', { ...exp, wilayas: ALL_WILAYAS });
    expect((await fromExport(join(root, 'out/snapshot.json'))).meta.publishRunId).toBe(7);
    await put(root, 'out/bad.json', { ...exp, products: 'x' });
    await expect(fromExport(join(root, 'out/bad.json'))).rejects.toThrow(SnapshotError);
  });

  test('HB_SNAPSHOT selects the source', async () => {
    const root = await fakeRepo();
    expect(await loadSnapshot({ repoRoot: root, env: {} })).toEqual(fixtureSnapshot);
    expect((await loadSnapshot({ repoRoot: root, env: { HB_SNAPSHOT: 'seed' } })).meta.source).toBe('seed');
    const full = { ...fixtureSnapshot, wilayas: ALL_WILAYAS };
    await put(root, 'snap.json', full);
    expect(await loadSnapshot({ repoRoot: root, env: { HB_SNAPSHOT: 'snap.json' } })).toEqual(full);
    await put(root, 'partial.json', fixtureSnapshot);
    await expect(loadSnapshot({ repoRoot: root, env: { HB_SNAPSHOT: 'partial.json' } })).rejects.toThrow(/missing wilaya codes/);
  });
});

test('toSnapshotWilayas maps the known row shapes', () => {
  const expected = [{ code: 16, name: { ar: 'الجزائر', fr: 'Alger' }, courierCode: null }];
  expect(toSnapshotWilayas([{ code: 16, name_ar: 'الجزائر', name_fr: 'Alger' }])).toEqual(expected);
  expect(toSnapshotWilayas({ wilayas: [{ code: 16, nameAr: 'الجزائر', nameFr: 'Alger', courierCode: null }] })).toEqual(expected);
  expect(toSnapshotWilayas([{ code: 16, name: { ar: 'الجزائر', fr: 'Alger' }, courier_code: 16 }])).toEqual([{ ...expected[0], courierCode: '16' }]);
});
