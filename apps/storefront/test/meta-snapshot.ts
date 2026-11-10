// Test seam for Meta build settings (MSET-4): the build reads `settings.metaPixel` from the snapshot
// HB_SNAPSHOT names, so tests point HB_SNAPSHOT at a small temp file. Undo with vi.unstubAllEnvs().
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

/** Non-zero fake Pixel ID (the admin and the export refuse all zeros). */
export const PIXEL = '100000000000001';

let dir: string | undefined;
let n = 0;

/** Writes a snapshot stub carrying only `settings.metaPixel` and returns its path. */
export function snapshotFile(metaPixel: unknown): string {
  dir ??= mkdtempSync(join(tmpdir(), 'hb-meta-snapshot-'));
  const file = join(dir, `snapshot-${n++}.json`);
  writeFileSync(file, JSON.stringify({ settings: { metaPixel } }));
  return file;
}

/** Makes the build see this `settings.metaPixel` (null = Meta off). */
export function useMetaPixel(metaPixel: { pixelId: string; consentRequired: boolean } | null): void {
  vi.stubEnv('HB_SNAPSHOT', snapshotFile(metaPixel));
}
