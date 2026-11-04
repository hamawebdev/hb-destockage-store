// Pagination helpers. Offset: `?page=` (1-based). Keyset: `?after=<at>.<id>` on (at desc, id desc).
import type { Context } from 'hono';
import type { AppEnv } from '../env.ts';

export const DEFAULT_PAGE_SIZE = 50;

export function parsePage(c: Context<AppEnv>): number {
  const raw = c.req.query('page');
  const n = raw !== undefined && /^\d{1,6}$/.test(raw) ? Number(raw) : 1;
  return Math.max(1, n);
}

export function pageCount(total: number, pageSize = DEFAULT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function offsetOf(page: number, pageSize = DEFAULT_PAGE_SIZE): number {
  return (page - 1) * pageSize;
}

export interface Cursor {
  at: number;
  id: number;
}

export function encodeCursor(cur: Cursor): string {
  return `${cur.at}.${cur.id}`;
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined) return null;
  const m = /^(\d{1,16})\.(\d{1,16})$/.exec(raw);
  if (!m) return null;
  const at = Number(m[1]);
  const id = Number(m[2]);
  return Number.isSafeInteger(at) && Number.isSafeInteger(id) ? { at, id } : null;
}

/** Fetch `pageSize + 1` rows; this returns the page and the next cursor (or null). */
export function cursorPage<R>(rows: readonly R[], pageSize: number, key: (r: R) => Cursor): { rows: R[]; next: string | null } {
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  return { rows: page, next: rows.length > pageSize && last !== undefined ? encodeCursor(key(last)) : null };
}
