/** Matches our commune to the courier's own entry: equal after folding, never by similarity. */
import type { CourierCommune, ParcelInput, PrepareCode } from './types.ts';

/** Case, accents, hyphens, apostrophes and spacing don't distinguish two communes. */
export function foldName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s\-‐-―'’`ʼ]/gu, '');
}

export type CommuneMatch =
  | { readonly ok: true; readonly commune: CourierCommune }
  | { readonly ok: false; readonly code: Extract<PrepareCode, 'commune_unmapped' | 'commune_not_deliverable'>; readonly detail: string };

function pick(candidate: string, communes: readonly CourierCommune[]): CourierCommune[] {
  const folded = foldName(candidate);
  return folded === '' ? [] : communes.filter((c) => foldName(c.name) === folded);
}

/** A person's pick wins; otherwise French, then Arabic. Two entries that fold alike match nothing. */
export function matchCommune(
  commune: ParcelInput['commune'],
  communes: readonly CourierCommune[],
): CommuneMatch {
  const candidates = commune.courierName !== undefined
    ? [commune.courierName]
    : [commune.nameFr, commune.nameAr];
  for (const candidate of candidates) {
    const found = pick(candidate, communes);
    if (found.length > 1) {
      return {
        ok: false,
        code: 'commune_unmapped',
        detail: `Several courier communes match "${candidate}"`,
      };
    }
    const match = found[0];
    if (match) {
      if (!match.deliverable) {
        return {
          ok: false,
          code: 'commune_not_deliverable',
          detail: `The courier does not deliver to ${match.name}`,
        };
      }
      return { ok: true, commune: match };
    }
  }
  return {
    ok: false,
    code: 'commune_unmapped',
    detail: `No courier commune matches "${commune.nameFr}"`,
  };
}
