/**
 * Money maths. All amounts are integer Algerian dinars (DZD); there are no fractional amounts
 * anywhere in the system (DB, API, display). Totals are always recomputed server-side.
 */

/** Integer DZD. A plain number at runtime; use `isDzd` to check a value. */
export type Dzd = number;

/** Maximum quantity of one variant in one order line (lead decision); the server also caps it at tracked stock. */
export const MAX_QTY_PER_LINE = 10;
/** Maximum number of distinct lines in one order. */
export const MAX_ORDER_LINES = 10;

export type MoneyErrorCode = 'not_integer' | 'negative' | 'overflow';

export class MoneyError extends Error {
  readonly code: MoneyErrorCode;
  constructor(code: MoneyErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'MoneyError';
    this.code = code;
  }
}

/** True for a non-negative safe integer. */
export function isDzd(value: unknown): value is Dzd {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export interface PricedLine {
  readonly unitPriceDzd: Dzd;
  readonly qty: number;
}

export type TotalledLine<L extends PricedLine> = L & { readonly lineTotalDzd: Dzd };

export interface Totals<L extends PricedLine = PricedLine> {
  readonly lines: readonly TotalledLine<L>[];
  readonly subtotalDzd: Dzd;
  readonly feeDzd: Dzd;
  readonly totalDzd: Dzd;
}

/**
 * Line totals, subtotal and total. Extra fields on each line (variantId, names…) are carried
 * through. Throws `MoneyError` on a non-integer, negative or unsafe amount or quantity.
 * Quantity limits are a validation concern (`order-schema.ts`), not checked here beyond `qty ≥ 1`.
 */
export function computeTotals<L extends PricedLine>(lines: readonly L[], feeDzd: Dzd): Totals<L> {
  assertDzd(feeDzd, 'feeDzd');
  let subtotal = 0;
  const out: TotalledLine<L>[] = [];
  for (const [i, line] of lines.entries()) {
    assertDzd(line.unitPriceDzd, `lines[${i}].unitPriceDzd`);
    if (!Number.isSafeInteger(line.qty)) throw new MoneyError('not_integer', `lines[${i}].qty`);
    if (line.qty < 1) throw new MoneyError('negative', `lines[${i}].qty`);
    const lineTotal = line.unitPriceDzd * line.qty;
    assertSafe(lineTotal, `lines[${i}].lineTotalDzd`);
    subtotal += lineTotal;
    assertSafe(subtotal, 'subtotalDzd');
    out.push({ ...line, lineTotalDzd: lineTotal });
  }
  const total = subtotal + feeDzd;
  assertSafe(total, 'totalDzd');
  return { lines: out, subtotalDzd: subtotal, feeDzd, totalDzd: total };
}

function assertDzd(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(Number.isInteger(value) ? 'overflow' : 'not_integer', what);
  }
  if (value < 0) throw new MoneyError('negative', what);
}

function assertSafe(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new MoneyError('overflow', what);
}
