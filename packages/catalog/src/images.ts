/**
 * CAT-4 — image pipeline (Node only: import as `@hb/catalog/images`).
 *
 * For every image a snapshot references (products and categories, deduplicated by key):
 *  - decode the original once, apply orientation, convert to sRGB through its embedded profile (the
 *    client's photos carry Display P3; sharp's default conversion matches LittleCMS, see
 *    artifacts/CAT-4/p3-to-srgb.md); AVIF is written without a profile, which browsers read as sRGB;
 *  - AVIF at 360/480/720/960/1200 w (never wider than the original), 4:2:0;
 *  - per-candidate quality search: the highest quality ≤ `maxQuality` (and ≤ the next-smaller
 *    width's quality) whose file is ≤ `maxBytes` (25,000), for every width ≤ 960; 1200 w reuses
 *    the 960 w quality (no budget applies above 960 w);
 *  - a 1200×630 JPEG (`og:image`, link previews do not read AVIF);
 *  - files named `<hash>-<w>.avif` / `<hash>-og.jpg`, hash = SHA-256 of the original + encoder
 *    settings, written to `<outDir>/img/`;
 *  - an on-disk cache keyed by that hash, so a rebuild with unchanged photos only copies files.
 * Returns the `ImageManifest` the page-props builders consume and a per-image report.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { candidateWidths } from './widths.ts';
import {
  IMAGE_MAX_BYTES_UP_TO_960,
  IMAGE_WIDTHS,
  type CatalogSnapshot,
  type ImageManifest,
  type ImageManifestEntry,
  type SnapshotImage,
  type SrcsetCandidate,
} from './types.ts';

/** Bump when the encoding recipe changes: every hash (and cached file) changes with it. */
export const PIPELINE_VERSION = 'cat4-v2';
export const BUDGET_MAX_WIDTH = 960;

export interface ImagePipelineOptions {
  /** Site root of the static output (e.g. `apps/storefront/public`); files go to `<outDir>/img/`. */
  readonly outDir: string;
  /** Persistent cache directory (e.g. `node_modules/.cache/hb-catalog-images`). */
  readonly cacheDir: string;
  /** Returns the original's bytes for a `SnapshotImage.key` (disk for seed, R2 for D1 exports). */
  readonly readOriginal: (key: string) => Promise<Buffer>;
  readonly widths?: readonly number[];
  /** Byte ceiling for every candidate ≤ 960 w. Default 25,000. */
  readonly maxBytes?: number;
  /** Starting (highest) AVIF quality. Default 60. */
  readonly maxQuality?: number;
  /** Lowest AVIF quality the search may use; below it the build fails. Default 20. */
  readonly minQuality?: number;
  /** AVIF effort 0–9 (slower = smaller). Default 4. */
  readonly effort?: number;
  /** Images processed in parallel. Default 2 (shared build machine). */
  readonly concurrency?: number;
  /** libvips threads per operation (`sharp.concurrency`). Default 2 (shared build machine). */
  readonly threads?: number;
  /** Delete files in `<outDir>/img/` that are not in this manifest. Default true. */
  readonly prune?: boolean;
}

export interface ImageReportRow {
  readonly key: string;
  readonly hash: string;
  readonly original: { readonly width: number; readonly height: number; readonly bytes: number };
  readonly candidates: readonly (SrcsetCandidate & { readonly quality: number })[];
  readonly ogBytes: number;
  readonly cached: boolean;
  readonly ms: number;
}

export interface ImagePipelineResult {
  readonly manifest: ImageManifest;
  readonly report: readonly ImageReportRow[];
}

export class ImageBudgetError extends Error {
  override name = 'ImageBudgetError';
}

interface CacheRecord {
  readonly version: string;
  readonly key: string;
  readonly hash: string;
  readonly original: ImageReportRow['original'];
  readonly candidates: ImageReportRow['candidates'];
  readonly ogBytes: number;
}

/** Reads originals from `<dir>/<key>`; refuses keys that escape `dir`. */
export function dirOriginalReader(dir: string): (key: string) => Promise<Buffer> {
  const base = resolve(dir);
  return async (key) => {
    const file = resolve(base, normalize(key));
    if (!file.startsWith(base + sep)) throw new Error(`image key escapes ${base}: ${key}`);
    return readFile(file);
  };
}

/** Seed originals: `<repoRoot>/data/photos/<key>`. */
export const seedOriginalReader = (repoRoot: string): ((key: string) => Promise<Buffer>) =>
  dirOriginalReader(resolve(repoRoot, 'data/photos'));

/** Every image a snapshot references (products and categories), first occurrence per key. */
export function snapshotImages(snapshot: CatalogSnapshot): SnapshotImage[] {
  const seen = new Map<string, SnapshotImage>();
  for (const c of snapshot.categories) if (c.image && !seen.has(c.image.key)) seen.set(c.image.key, c.image);
  for (const p of snapshot.products) for (const i of p.images) if (!seen.has(i.key)) seen.set(i.key, i);
  return [...seen.values()];
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

interface Settings {
  readonly widths: readonly number[];
  readonly maxBytes: number;
  readonly maxQuality: number;
  readonly minQuality: number;
  readonly effort: number;
}

async function encodeOne(key: string, original: Buffer, s: Settings, hash: string, cacheDir: string): Promise<CacheRecord> {
  const base = sharp(original, { failOn: 'error' }).rotate().toColourspace('srgb');
  const meta = await base.clone().toBuffer({ resolveWithObject: true });
  const W = meta.info.width;
  const H = meta.info.height;
  const widths = candidateWidths(W, s.widths);

  const candidates: (SrcsetCandidate & { quality: number })[] = [];
  let lastQuality = s.maxQuality;
  for (const w of widths) {
    const { data, info } = await base.clone().resize({ width: w, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
    const enc = (q: number): Promise<Buffer> =>
      sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
        .avif({ quality: q, effort: s.effort, chromaSubsampling: '4:2:0' })
        .toBuffer();
    let quality: number;
    let file: Buffer;
    if (w > BUDGET_MAX_WIDTH) {
      quality = lastQuality;
      file = await enc(quality);
    } else {
      // Widths ascend and the fitting quality only falls with width, so start where the previous
      // width ended (saves encodes; at worst a wider candidate gets a slightly lower quality).
      const start = lastQuality;
      file = await enc(start);
      quality = start;
      if (file.length > s.maxBytes) {
        // Highest quality in [minQuality, start) that fits.
        let lo = s.minQuality;
        let hi = start - 1;
        let best: { q: number; buf: Buffer } | null = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const buf = await enc(mid);
          if (buf.length <= s.maxBytes) {
            best = { q: mid, buf };
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        if (!best) {
          throw new ImageBudgetError(`${key}: ${w} w exceeds ${s.maxBytes} B even at quality ${s.minQuality}`);
        }
        quality = best.q;
        file = best.buf;
      }
      lastQuality = quality;
    }
    await writeFile(join(cacheDir, `${hash}-${w}.avif`), file);
    candidates.push({ url: `/img/${hash}-${w}.avif`, width: info.width, height: info.height, bytes: file.length, quality });
  }

  const og = await base
    .clone()
    .resize({ width: 1200, height: 630, fit: 'cover', position: sharp.strategy.attention })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
  await writeFile(join(cacheDir, `${hash}-og.jpg`), og);

  return { version: PIPELINE_VERSION, key, hash, original: { width: W, height: H, bytes: original.length }, candidates, ogBytes: og.length };
}

async function sameSize(a: string, b: string): Promise<boolean> {
  if (!existsSync(b)) return false;
  const [x, y] = await Promise.all([stat(a), stat(b)]);
  return x.size === y.size;
}

export async function buildImages(snapshot: CatalogSnapshot, opts: ImagePipelineOptions): Promise<ImagePipelineResult> {
  const s: Settings = {
    widths: opts.widths ?? IMAGE_WIDTHS,
    maxBytes: opts.maxBytes ?? IMAGE_MAX_BYTES_UP_TO_960,
    maxQuality: opts.maxQuality ?? 60,
    minQuality: opts.minQuality ?? 20,
    effort: opts.effort ?? 4,
  };
  const settingsKey = JSON.stringify([PIPELINE_VERSION, s]);
  sharp.concurrency(opts.threads ?? 2);
  const imgDir = join(opts.outDir, 'img');
  await mkdir(imgDir, { recursive: true });
  await mkdir(opts.cacheDir, { recursive: true });

  const rows = await mapLimit(snapshotImages(snapshot), opts.concurrency ?? 2, async (img): Promise<ImageReportRow> => {
    const t0 = performance.now();
    const original = await opts.readOriginal(img.key);
    const hash = createHash('sha256').update(settingsKey).update('\0').update(original).digest('hex').slice(0, 16);
    const recordFile = join(opts.cacheDir, `${hash}.json`);
    let record: CacheRecord | null = null;
    let cached = false;
    if (existsSync(recordFile)) {
      const r = JSON.parse(await readFile(recordFile, 'utf8')) as CacheRecord;
      const files = [...r.candidates.map((c) => `${hash}-${c.width}.avif`), `${hash}-og.jpg`];
      if (r.version === PIPELINE_VERSION && files.every((f) => existsSync(join(opts.cacheDir, f)))) {
        record = { ...r, key: img.key };
        cached = true;
      }
    }
    if (!record) {
      record = await encodeOne(img.key, original, s, hash, opts.cacheDir);
      await writeFile(recordFile, JSON.stringify(record));
    }
    for (const f of [...record.candidates.map((c) => `${hash}-${c.width}.avif`), `${hash}-og.jpg`]) {
      const from = join(opts.cacheDir, f);
      const to = join(imgDir, f);
      if (!(await sameSize(from, to))) await copyFile(from, to);
    }
    return { key: img.key, hash, original: record.original, candidates: record.candidates, ogBytes: record.ogBytes, cached, ms: Math.round(performance.now() - t0) };
  });

  const manifest: Record<string, ImageManifestEntry> = {};
  for (const r of rows) {
    manifest[r.key] = {
      key: r.key,
      hash: r.hash,
      original: { width: r.original.width, height: r.original.height },
      candidates: r.candidates.map(({ url, width, height, bytes }) => ({ url, width, height, bytes })),
      og: { url: `/img/${r.hash}-og.jpg`, bytes: r.ogBytes },
      stub: false,
    };
  }

  if (opts.prune !== false) {
    const keep = new Set(rows.flatMap((r) => [...r.candidates.map((c) => `${r.hash}-${c.width}.avif`), `${r.hash}-og.jpg`]));
    for (const f of await readdir(imgDir)) {
      if (/^[0-9a-f]{16}-(\d+\.avif|og\.jpg)$/.test(f) && !keep.has(f)) await rm(join(imgDir, f));
    }
  }
  return { manifest, report: rows };
}

/** Markdown sizes table (artifacts/CAT-4/sizes.md). */
export function sizesMarkdown(result: ImagePipelineResult, title = 'CAT-4 image sizes'): string {
  const widths = [...new Set(result.report.flatMap((r) => r.candidates.map((c) => c.width)))].sort((a, b) => a - b);
  const lines = [
    `# ${title}`,
    '',
    `AVIF bytes (quality) per candidate width. Budget: every candidate ≤ ${BUDGET_MAX_WIDTH} w ≤ ${IMAGE_MAX_BYTES_UP_TO_960.toLocaleString('en')} B.`,
    '',
    `| key | original | ${widths.map((w) => `${w} w`).join(' | ')} | og.jpg | cached | ms |`,
    `|---|---|${widths.map(() => '---:').join('|')}|---:|---|---:|`,
  ];
  for (const r of result.report) {
    const cells = widths.map((w) => {
      const c = r.candidates.find((x) => x.width === w);
      return c ? `${c.bytes.toLocaleString('en')} (q${c.quality})` : '–';
    });
    lines.push(
      `| ${r.key} | ${r.original.width}×${r.original.height}, ${(r.original.bytes / 1024).toFixed(0)} KiB | ${cells.join(' | ')} | ${r.ogBytes.toLocaleString('en')} | ${r.cached ? 'yes' : 'no'} | ${r.ms} |`,
    );
  }
  const within = result.report.flatMap((r) => r.candidates.filter((c) => c.width <= BUDGET_MAX_WIDTH));
  const above = result.report.flatMap((r) => r.candidates.filter((c) => c.width > BUDGET_MAX_WIDTH));
  const max = within.reduce((m, c) => Math.max(m, c.bytes), 0);
  const maxAbove = above.reduce((m, c) => Math.max(m, c.bytes), 0);
  lines.push(
    '',
    `Images: ${result.report.length}. Largest candidate ≤ ${BUDGET_MAX_WIDTH} w: ${max.toLocaleString('en')} B. Over budget: ${within.filter((c) => c.bytes > IMAGE_MAX_BYTES_UP_TO_960).length}. ` +
      `Largest candidate > ${BUDGET_MAX_WIDTH} w (no budget): ${maxAbove.toLocaleString('en')} B.`,
    '',
  );
  return lines.join('\n');
}
