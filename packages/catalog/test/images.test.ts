import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildImages, dirOriginalReader, ImageBudgetError, seedOriginalReader, sizesMarkdown, snapshotImages } from '../src/images.ts';
import { fixtureSnapshot, type CatalogSnapshot } from '../src/index.ts';
import { createBuildContext } from '../src/build.ts';
import stringsAr from '../src/fixtures/strings.ar.json' with { type: 'json' };
import stringsFr from '../src/fixtures/strings.fr.json' with { type: 'json' };

let root: string;
const fast = { effort: 0, concurrency: 2 } as const;

/** Deterministic noisy photo-like JPEG (noise defeats compression, so budgets bite). */
async function photo(width: number, height: number, seed: number, p3 = false): Promise<Buffer> {
  const px = Buffer.alloc(width * height * 3);
  let x = seed * 2654435761;
  for (let i = 0; i < px.length; i++) {
    x = (Math.imul(x ^ (x >>> 15), 2246822507) + i) >>> 0;
    const base = (i % 3) * 60 + ((i / 3 / width) % 128);
    px[i] = (base + (x & 63)) & 255;
  }
  let img = sharp(px, { raw: { width, height, channels: 3 } });
  if (p3) img = img.withIccProfile('p3');
  return img.jpeg({ quality: 90 }).toBuffer();
}

/** Fixture snapshot whose images point at `n` real files under <root>/data/photos/. */
function snapshotWith(keys: readonly string[], dims: { width: number; height: number }): CatalogSnapshot {
  const p = fixtureSnapshot.products[1]!;
  return {
    ...fixtureSnapshot,
    categories: fixtureSnapshot.categories,
    products: [{ ...p, images: keys.map((key, i) => ({ ...p.images[0]!, id: 7000 + i, key, ...dims })) }],
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hb-images-'));
  await mkdir(join(root, 'data/photos/a'), { recursive: true });
  await writeFile(join(root, 'data/photos/a/big.jpg'), await photo(1400, 1000, 1, true));
  await writeFile(join(root, 'data/photos/a/small.jpg'), await photo(300, 200, 2));
  await writeFile(join(root, 'data/photos/a/mid.jpg'), await photo(800, 800, 3));
}, 60_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('buildImages', () => {
  test('widths capped at the original, budget met, sRGB without profile, og 1200×630, cache, prune', async () => {
    const out = join(root, 'out1');
    const cache = join(root, 'cache1');
    const snap = snapshotWith(['a/big.jpg', 'a/small.jpg', 'a/mid.jpg', 'a/big.jpg'], { width: 1400, height: 1000 });
    const opts = { outDir: out, cacheDir: cache, readOriginal: seedOriginalReader(root), maxBytes: 12_000, ...fast };
    const r1 = await buildImages(snap, opts);

    expect(Object.keys(r1.manifest).sort()).toEqual(['a/big.jpg', 'a/mid.jpg', 'a/small.jpg']);
    const big = r1.manifest['a/big.jpg']!;
    expect(big.candidates.map((c) => c.width)).toEqual([360, 480, 720, 960, 1200]);
    expect(big.candidates.map((c) => c.height)).toEqual([257, 343, 514, 686, 857]);
    expect(r1.manifest['a/mid.jpg']!.candidates.map((c) => c.width)).toEqual([360, 480, 720, 800]);
    expect(r1.manifest['a/mid.jpg']!.original).toEqual({ width: 800, height: 800 });
    expect(big.original).toEqual({ width: 1400, height: 1000 });
    expect(r1.manifest['a/small.jpg']!.candidates.map((c) => c.width)).toEqual([300]);
    for (const e of Object.values(r1.manifest)) {
      expect(e.stub).toBe(false);
      expect(e.hash).toMatch(/^[0-9a-f]{16}$/);
      for (const c of e.candidates) {
        expect(c.url).toBe(`/img/${e.hash}-${c.width}.avif`);
        if (c.width <= 960) expect(c.bytes).toBeLessThanOrEqual(12_000);
        const meta = await sharp(join(out, c.url)).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual(['heif', c.width, c.height]);
        expect(meta.icc).toBeUndefined();
      }
      const og = await sharp(join(out, e.og!.url)).metadata();
      expect([og.format, og.width, og.height]).toEqual(['jpeg', 1200, 630]);
    }
    // The noisy 1400 w photo cannot fit 12 kB at the top quality: the search lowered it.
    expect(r1.report.find((x) => x.key === 'a/big.jpg')!.candidates.some((c) => c.quality < 60)).toBe(true);
    expect(r1.report.every((x) => !x.cached)).toBe(true);

    // Second run: everything from cache, identical manifest.
    const r2 = await buildImages(snap, opts);
    expect(r2.report.every((x) => x.cached)).toBe(true);
    expect(r2.manifest).toEqual(r1.manifest);

    // Prune: drop a photo, its files disappear from out/img but stay in the cache.
    const r3 = await buildImages(snapshotWith(['a/mid.jpg'], { width: 800, height: 800 }), opts);
    const files = readdirSync(join(out, 'img'));
    expect(files.every((f) => f.startsWith(r3.manifest['a/mid.jpg']!.hash))).toBe(true);
    expect(existsSync(join(cache, `${big.hash}.json`))).toBe(true);

    expect(sizesMarkdown(r1)).toMatch(/\| a\/big\.jpg \| 1400×1000/);
  }, 300_000);

  test('BUG-12: with default settings every candidate ≤ 960 w is ≤ 20,000 B', async () => {
    const { IMAGE_TARGET_BYTES_UP_TO_960 } = await import('../src/types.ts');
    expect(IMAGE_TARGET_BYTES_UP_TO_960).toBe(20_000);
    // The noisy 1400 px photo exceeds 20 kB at the top quality, so the search has to work for it.
    const snap = snapshotWith(['a/big.jpg', 'a/mid.jpg'], { width: 1400, height: 1000 });
    const r = await buildImages(snap, { outDir: join(root, 'out6'), cacheDir: join(root, 'cache6'), readOriginal: seedOriginalReader(root), ...fast });
    const within = Object.values(r.manifest).flatMap((e) => e.candidates.filter((c) => c.width <= 960));
    expect(within.length).toBeGreaterThan(0);
    for (const c of within) expect(c.bytes, c.url).toBeLessThanOrEqual(20_000);
    expect(r.report.find((x) => x.key === 'a/big.jpg')!.candidates.some((c) => c.width <= 960 && c.quality < 60)).toBe(true);
    // Never below the floor: every chosen quality is ≥ 20.
    for (const row of r.report) for (const c of row.candidates) expect(c.quality).toBeGreaterThanOrEqual(20);
  }, 300_000);

  test('the hash changes with the encoder settings', async () => {
    const snap = snapshotWith(['a/small.jpg'], { width: 300, height: 200 });
    const base = { outDir: join(root, 'out2'), cacheDir: join(root, 'cache2'), readOriginal: seedOriginalReader(root), ...fast };
    const a = await buildImages(snap, base);
    const b = await buildImages(snap, { ...base, maxQuality: 50 });
    expect(a.manifest['a/small.jpg']!.hash).not.toBe(b.manifest['a/small.jpg']!.hash);
  }, 120_000);

  test('fails when even the lowest quality exceeds the budget', async () => {
    const snap = snapshotWith(['a/big.jpg'], { width: 1400, height: 1000 });
    await expect(
      buildImages(snap, { outDir: join(root, 'out3'), cacheDir: join(root, 'cache3'), readOriginal: seedOriginalReader(root), maxBytes: 300, minQuality: 40, ...fast }),
    ).rejects.toThrow(ImageBudgetError);
  }, 120_000);

  test('Display P3 originals are converted to sRGB (not just untagged)', async () => {
    // sRGB (200, 60, 40) written with a P3 profile: sharp converts on write, so the file stores
    // P3 values (~185, 71, 50) tagged P3. The pipeline must bring it back to ~(200, 60, 40).
    const px = Buffer.alloc(400 * 400 * 3);
    for (let i = 0; i < px.length; i += 3) px.set([200, 60, 40], i);
    const tagged = await sharp(px, { raw: { width: 400, height: 400, channels: 3 } }).withIccProfile('p3').png().toBuffer();
    const stored = await sharp(tagged).raw().toBuffer({ resolveWithObject: true });
    expect((await sharp(tagged).metadata()).icc).toBeDefined();
    await writeFile(join(root, 'data/photos/a/p3.png'), tagged);
    const snap = snapshotWith(['a/p3.png'], { width: 400, height: 400 });
    const out = join(root, 'out5');
    const r = await buildImages(snap, { outDir: out, cacheDir: join(root, 'cache5'), readOriginal: seedOriginalReader(root), maxQuality: 90, ...fast });
    const avif = join(out, r.manifest['a/p3.png']!.candidates[0]!.url);
    const { data } = await sharp(avif).raw().toBuffer({ resolveWithObject: true });
    const got = [...data.subarray(0, 3)];
    void stored;
    for (const [c, want] of [[got[0]!, 200], [got[1]!, 60], [got[2]!, 40]] as const) expect(Math.abs(c - want)).toBeLessThanOrEqual(4);
  }, 120_000);

  test('dirOriginalReader reads by key from any directory (R2 objects copied for a d1 publish)', async () => {
    const read = dirOriginalReader(join(root, 'data/photos'));
    expect((await read('a/small.jpg')).length).toBeGreaterThan(0);
    await expect(read('../catalog/x.json')).rejects.toThrow(/escapes/);
  });

  test('seedOriginalReader refuses keys outside data/photos', async () => {
    const read = seedOriginalReader(root);
    await expect(read('../../etc/passwd')).rejects.toThrow(/escapes/);
    await expect(read('/etc/passwd')).rejects.toThrow(/escapes/);
  });

  test('manifest feeds the page-props builders', async () => {
    const snap = snapshotWith(['a/mid.jpg'], { width: 800, height: 800 });
    const r = await buildImages(snap, { outDir: join(root, 'out4'), cacheDir: join(root, 'cache4'), readOriginal: seedOriginalReader(root), ...fast });
    const missing = snapshotImages(fixtureSnapshot).filter((i) => !(i.key in r.manifest));
    expect(missing.length).toBeGreaterThan(0); // fixture images are not in this manifest…
    const ctx = createBuildContext(snap, {
      siteUrl: 'https://hb.example',
      strings: { ar: stringsAr as Record<string, string>, fr: stringsFr as Record<string, string> },
      images: r.manifest,
    }); // …but this snapshot's are: the context accepts it.
    expect(ctx.products.length).toBe(1);
  }, 120_000);
});

describe('candidateWidths (never upscale)', () => {
  test.each([
    [1600, [360, 480, 720, 960, 1200]],
    [1200, [360, 480, 720, 960, 1200]],
    [1100, [360, 480, 720, 960, 1100]],
    [800, [360, 480, 720, 800]],
    [720, [360, 480, 720]],
    [300, [300]],
  ])('%i px → %j', async (w, expected) => {
    const { candidateWidths } = await import('../src/widths.ts');
    expect(candidateWidths(w)).toEqual(expected);
  });
});
