/**
 * R2 (`MEDIA`) housekeeping shared by categories, products and media (ACAT-0 plan §6).
 * One original may back several image rows (seed reuses photos), so an object is deleted only when
 * no `images` row references its key any more. Best effort: a failed R2 delete never undoes the
 * D1 change that already happened; the key is logged (no PII) for a later sweep.
 */
import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { images } from '@hb/db';
import type { AppEnv } from '../../../env.ts';

export async function deleteUnreferencedMedia(c: Context<AppEnv>, keys: readonly string[]): Promise<string[]> {
  const orphans: string[] = [];
  for (const key of new Set(keys)) {
    const [row] = await c.var.db
      .select({ n: sql<number>`count(*)` })
      .from(images)
      .where(eq(images.r2Key, key));
    if ((row?.n ?? 0) > 0) continue;
    try {
      await c.env.MEDIA.delete(key);
    } catch {
      orphans.push(key);
      console.error(JSON.stringify({ level: 'error', msg: 'r2 delete failed', key, requestId: c.var.requestId }));
    }
  }
  return orphans;
}
