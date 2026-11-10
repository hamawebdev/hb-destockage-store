// Shared bits for the /meta tests (MSET-2).
import type { Harness } from '../helpers.ts';

export const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
export const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(6)));
/** A token-shaped sentinel: anything containing a piece of it must never leave the server. */
export const SENTINEL = 'EAASENTINELmset2tok0123456789abcdefghijklmnopqrstuvwxyzQRST4321';
export const PIXEL = '100000000000001';
export const META_KEYS = ['metaPixelId', 'metaConsentRequired', 'metaAccessTokenEnc', 'metaTestEventCode'] as const;

/** Every substring of the sentinel of length n. */
export const pieces = (s: string, n: number): string[] => Array.from({ length: s.length - n + 1 }, (_, i) => s.slice(i, i + n));

export async function metaRows(h: Harness): Promise<Record<string, string>> {
  const { results } = await h.db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'meta%' ORDER BY key`).all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function clearMeta(h: Harness): Promise<void> {
  await h.db.prepare(`DELETE FROM settings WHERE key LIKE 'meta%'`).run();
}

export async function lastAuditId(h: Harness): Promise<number> {
  return (await h.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log').first<{ n: number }>())!.n;
}

export async function auditSince(h: Harness, id: number): Promise<{ action: string; entity_id: string | null; before: string | null; after: string | null }[]> {
  return (
    await h.db
      .prepare('SELECT action, entity_id, before, after FROM audit_log WHERE id > ? ORDER BY id')
      .bind(id)
      .all<{ action: string; entity_id: string | null; before: string | null; after: string | null }>()
  ).results;
}

/** Headers and body of a response as one string, for leak greps. */
export async function wholeResponse(res: Response): Promise<string> {
  return `${res.status}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${await res.text()}`;
}
