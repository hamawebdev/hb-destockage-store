/**
 * Media reads and writes (ACAT-3, plan §6). Originals go to R2 (`MEDIA`) under a server-generated
 * key; rows go to D1 in one batch with their audit row. Owner = a product or a category
 * (`images_one_owner`). Binding = whole product (both null), an option value, or a variant (never
 * both: DB trigger + CAT-1 `checkProductIntegrity`).
 */
import { and, asc, desc, eq, max, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Context } from 'hono';
import { categories, images, optionValues, productOptions, products, variants, type Image } from '@hb/db';
import { audit } from '../../audit/audit.ts';
import type { AppEnv } from '../../env.ts';
import { deleteUnreferencedMedia } from '../products/lib/r2.ts';
import { EXT, MIME, type ImageType } from './sniff.ts';

type Ctx = Context<AppEnv>;

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 10;
export const MIN_LONG_SIDE = 600;
export const RECOMMENDED_WIDTH = 1200;
export const MAX_PIXELS = 40_000_000;

export type Owner = { kind: 'product'; id: number } | { kind: 'category'; id: number };

export const ownerPath = (o: Owner): string => (o.kind === 'product' ? `/products/${o.id}` : `/categories/${o.id}`);
const ownerWhere = (o: Owner) => (o.kind === 'product' ? eq(images.productId, o.id) : eq(images.categoryId, o.id));
const ownerCols = (o: Owner) => (o.kind === 'product' ? { productId: o.id, categoryId: null } : { productId: null, categoryId: o.id });
const run = (c: Ctx, items: BatchItem<'sqlite'>[]) => c.var.db.batch(items as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

/** `product:12` / `category:3` → Owner, if it exists. */
export async function resolveOwner(c: Ctx, raw: string | undefined): Promise<Owner | null> {
  const m = /^(product|category):([1-9]\d{0,9})$/.exec(raw ?? '');
  if (m === null) return null;
  const id = Number(m[2]);
  const table = m[1] === 'product' ? products : categories;
  const [row] = await c.var.db.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
  return row === undefined ? null : { kind: m[1] as 'product' | 'category', id };
}

export function ownerOf(img: Image): Owner {
  return img.productId !== null ? { kind: 'product', id: img.productId } : { kind: 'category', id: img.categoryId as number };
}

export async function loadImages(c: Ctx, o: Owner): Promise<Image[]> {
  return c.var.db.select().from(images).where(ownerWhere(o)).orderBy(asc(images.position), asc(images.id));
}

export async function loadImage(c: Ctx, id: number): Promise<Image | undefined> {
  const [row] = await c.var.db.select().from(images).where(eq(images.id, id)).limit(1);
  return row;
}

export async function recentImages(c: Ctx, limit = 50): Promise<Image[]> {
  return c.var.db.select().from(images).orderBy(desc(images.createdAt), desc(images.id)).limit(limit);
}

/** Binding choices for a product: its option values (colour first) and its variants. */
export interface BindChoices {
  values: { id: number; labelFr: string; labelAr: string }[];
  variants: { id: number; sku: string }[];
}
export async function bindChoices(c: Ctx, productId: number): Promise<BindChoices> {
  const db = c.var.db;
  const [vals, vars] = await Promise.all([
    db
      .select({ id: optionValues.id, labelFr: optionValues.valueFr, labelAr: optionValues.valueAr, kind: productOptions.kind })
      .from(optionValues)
      .innerJoin(productOptions, eq(productOptions.id, optionValues.optionId))
      .where(eq(productOptions.productId, productId))
      .orderBy(sql`${productOptions.kind} <> 'colour'`, asc(productOptions.position), asc(optionValues.position)),
    db.select({ id: variants.id, sku: variants.sku }).from(variants).where(eq(variants.productId, productId)).orderBy(asc(variants.position)),
  ]);
  return { values: vals.map(({ id, labelFr, labelAr }) => ({ id, labelFr, labelAr })), variants: vars };
}

export interface Upload {
  bytes: Uint8Array;
  type: ImageType;
  width: number;
  height: number;
  name: string;
}

/**
 * Puts each original in R2, then inserts the rows (after the owner's last position) and one
 * `image.upload` audit row in one batch. If the batch fails, the objects just written are removed.
 */
export async function uploadImages(c: Ctx, o: Owner, files: readonly Upload[], alt: { fr: string; ar: string }, placeholder: boolean): Promise<number> {
  const db = c.var.db;
  const [pos] = await db.select({ p: max(images.position) }).from(images).where(ownerWhere(o));
  const start = (pos?.p ?? -1) + 1;
  const keys: string[] = [];
  try {
    for (const f of files) {
      const key = `${o.kind === 'product' ? 'products' : 'categories'}/${o.id}/${crypto.randomUUID()}.${EXT[f.type]}`;
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', f.bytes));
      await c.env.MEDIA.put(key, f.bytes, {
        httpMetadata: { contentType: MIME[f.type] },
        customMetadata: { sha256: [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''), uploadedBy: String(c.var.user.id) },
      });
      keys.push(key);
    }
    const rows = files.map((f, i) => ({
      ...ownerCols(o),
      r2Key: keys[i] as string,
      width: f.width,
      height: f.height,
      altFr: alt.fr,
      altAr: alt.ar,
      position: start + i,
      placeholder,
    }));
    await run(c, [
      db.insert(images).values(rows),
      audit(c, {
        action: 'image.upload',
        entity: 'images',
        entityId: `${o.kind}:${o.id}`,
        before: null,
        after: { images: rows.map((r, i) => ({ r2Key: r.r2Key, width: r.width, height: r.height, type: files[i]?.type, bytes: files[i]?.bytes.length })) },
      }),
    ]);
    return files.length;
  } catch (err) {
    for (const key of keys) {
      try {
        await c.env.MEDIA.delete(key);
      } catch {
        console.error(JSON.stringify({ level: 'error', msg: 'r2 cleanup failed', key, requestId: c.var.requestId }));
      }
    }
    throw err;
  }
}

export interface ImagePatch {
  altFr: string;
  altAr: string;
  variantId: number | null;
  optionValueId: number | null;
  placeholder: boolean;
}

export async function updateImage(c: Ctx, img: Image, patch: ImagePatch): Promise<boolean> {
  const before: ImagePatch = { altFr: img.altFr, altAr: img.altAr, variantId: img.variantId, optionValueId: img.optionValueId, placeholder: img.placeholder };
  const changed = (Object.keys(patch) as (keyof ImagePatch)[]).filter((k) => before[k] !== patch[k]);
  if (changed.length === 0) return false;
  const db = c.var.db;
  await run(c, [
    db.update(images).set(patch).where(eq(images.id, img.id)),
    audit(c, {
      action: 'image.update',
      entity: 'images',
      entityId: img.id,
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, patch[k]])),
    }),
  ]);
  return true;
}

/** Swaps with the neighbour and renumbers the owner's images 0..n-1, one batch. */
export async function moveImage(c: Ctx, img: Image, dir: 'up' | 'down'): Promise<boolean> {
  const o = ownerOf(img);
  const list = await loadImages(c, o);
  const i = list.findIndex((x) => x.id === img.id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= list.length) return false;
  const order = list.map((x) => x.id);
  [order[i], order[j]] = [order[j] as number, order[i] as number];
  const db = c.var.db;
  await run(c, [
    ...order.map((id, position) => db.update(images).set({ position }).where(and(eq(images.id, id), ownerWhere(o)))),
    audit(c, { action: 'image.reorder', entity: 'images', entityId: `${o.kind}:${o.id}`, before: { order: list.map((x) => x.id) }, after: { order } }),
  ]);
  return true;
}

export async function deleteImage(c: Ctx, img: Image): Promise<void> {
  const db = c.var.db;
  await run(c, [
    db.delete(images).where(eq(images.id, img.id)),
    audit(c, { action: 'image.delete', entity: 'images', entityId: img.id, before: { ...img }, after: null }),
  ]);
  // The original stays in R2 while another row references it (seed reuses photos).
  await deleteUnreferencedMedia(c, [img.r2Key]);
}

/** Checks a binding against the product's own values/variants. */
export function validBinding(choices: BindChoices, bind: string): { variantId: number | null; optionValueId: number | null } | null {
  if (bind === '') return { variantId: null, optionValueId: null };
  const m = /^(v|o):([1-9]\d{0,9})$/.exec(bind);
  if (m === null) return null;
  const id = Number(m[2]);
  if (m[1] === 'v') return choices.variants.some((x) => x.id === id) ? { variantId: id, optionValueId: null } : null;
  return choices.values.some((x) => x.id === id) ? { variantId: null, optionValueId: id } : null;
}

