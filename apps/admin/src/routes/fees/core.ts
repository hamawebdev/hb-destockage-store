/**
 * Delivery-fee editor core (ACAT-4, plan artifacts/ACAT-4/plan.md). Pure: range parsing, the
 * proposed table from a form, the diff against D1 and the "check this" flags. No I/O.
 *
 * Rules (lead decisions, plan §5):
 *  - a placeholder fee is confirmed only when its "confirm" box is ticked (row or bulk); saving a
 *    fee or toggling `available` alone keeps `placeholder`;
 *  - fee 0 is allowed (free delivery); a row going to 0, or rising more than 3×, is flagged;
 *  - a wilaya with no row and no fee stays "not set" (unavailable).
 */
export const WILAYA_MIN = 1;
export const WILAYA_MAX = 69;
export const FEE_MAX = 100_000;

export interface FeeRow {
  feeDzd: number;
  available: boolean;
  placeholder: boolean;
}

export interface CurrentRow extends FeeRow {
  code: number;
  /** `updated_at` the form was rendered with; 0 = no row. */
  version: number;
}

/** What the form proposes for one wilaya. `feeDzd` null = left blank. */
export interface ProposedRow {
  code: number;
  feeDzd: number | null;
  available: boolean;
  confirm: boolean;
  version: number;
}

export interface Change {
  code: number;
  before: FeeRow | null;
  after: FeeRow;
  version: number;
  /** placeholder → confirmed by this save. */
  confirmed: boolean;
  /** "check this" warnings (not blocks). */
  toZero: boolean;
  riseOver3x: boolean;
}

/** "1-16, 31, 49-58" → codes. Null when malformed or out of 1–69. */
export function parseRange(input: string): Set<number> | null {
  const out = new Set<number>();
  const text = input.trim();
  if (text === '') return out;
  for (const part of text.split(/[,\s،]+/u).filter((p) => p !== '')) {
    const m = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(part);
    if (m === null) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < WILAYA_MIN || b > WILAYA_MAX || a > b) return null;
    for (let c = a; c <= b; c++) out.add(c);
  }
  return out;
}

export interface Bulk {
  codes: ReadonlySet<number>;
  feeDzd: number | null;
  /** null = leave each row's own value. */
  available: boolean | null;
  confirm: boolean;
}

/** Applies the bulk bar on top of the per-row values (bulk wins for the selected rows). */
export function applyBulk(rows: readonly ProposedRow[], bulk: Bulk | null): ProposedRow[] {
  if (bulk === null || bulk.codes.size === 0) return rows.map((r) => ({ ...r }));
  return rows.map((r) =>
    bulk.codes.has(r.code)
      ? {
          ...r,
          feeDzd: bulk.feeDzd ?? r.feeDzd,
          available: bulk.available ?? r.available,
          confirm: r.confirm || bulk.confirm,
        }
      : { ...r },
  );
}

export type RowError = 'fee_required';

/** Diff of the proposed table against the current one. */
export function diffFees(
  current: ReadonlyMap<number, CurrentRow>,
  proposed: readonly ProposedRow[],
): { ok: true; changes: Change[] } | { ok: false; errors: Map<number, RowError> } {
  const errors = new Map<number, RowError>();
  const changes: Change[] = [];
  for (const p of proposed) {
    const cur = current.get(p.code);
    const before: FeeRow | null = cur ? { feeDzd: cur.feeDzd, available: cur.available, placeholder: cur.placeholder } : null;
    if (p.feeDzd === null) {
      // Blank: fine for a wilaya that has no fee yet; an existing fee cannot be blanked.
      if (before !== null) errors.set(p.code, 'fee_required');
      continue;
    }
    const placeholder = before === null ? false : before.placeholder && !p.confirm;
    const after: FeeRow = { feeDzd: p.feeDzd, available: p.available, placeholder };
    if (before !== null && before.feeDzd === after.feeDzd && before.available === after.available && before.placeholder === after.placeholder) continue;
    changes.push({
      code: p.code,
      before,
      after,
      version: p.version,
      confirmed: before !== null && before.placeholder && !after.placeholder,
      toZero: after.feeDzd === 0 && (before === null || before.feeDzd !== 0),
      riseOver3x: before !== null && before.feeDzd > 0 && after.feeDzd > 3 * before.feeDzd,
    });
  }
  return errors.size > 0 ? { ok: false, errors } : { ok: true, changes };
}
