/**
 * Stand-in image manifest for fixtures and tests (no encoding, no I/O). URLs follow the CAT-4
 * scheme (`/img/<hash>-<w>.avif`, `/img/<hash>-og.jpg`) but the files do not exist; `bytes` is 0
 * and `stub` is true. Real builds use CAT-4's manifest.
 */
import { candidateWidths } from './widths.ts';
import { type CatalogSnapshot, type ImageManifest, type ImageManifestEntry, type SnapshotImage } from './types.ts';

/** FNV-1a 32-bit, hex. Deterministic stand-in for the content hash. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function stubManifestEntry(img: Pick<SnapshotImage, 'key' | 'width' | 'height'>): ImageManifestEntry {
  const hash = fnv1a(img.key);
  const list = candidateWidths(img.width);
  return {
    key: img.key,
    hash,
    original: { width: img.width, height: img.height },
    candidates: list.map((w) => ({ url: `/img/${hash}-${w}.avif`, width: w, height: Math.round((w * img.height) / img.width), bytes: 0 })),
    og: { url: `/img/${hash}-og.jpg`, bytes: 0 },
    stub: true,
  };
}

/** Every image in the snapshot (products and categories), keyed by `key`. */
export function stubImageManifest(snapshot: CatalogSnapshot): ImageManifest {
  const out: Record<string, ImageManifestEntry> = {};
  const add = (img: SnapshotImage): void => {
    out[img.key] ??= stubManifestEntry(img);
  };
  for (const p of snapshot.products) p.images.forEach(add);
  for (const c of snapshot.categories) if (c.image) add(c.image);
  return out;
}
