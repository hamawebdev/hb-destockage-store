/**
 * Maps D1/SQLite constraint failures to the form field they concern, so a race on a unique slug
 * or SKU re-renders the form with a field error instead of a 500 (ACAT-0 plan §2.1).
 * D1 messages look like `D1_ERROR: UNIQUE constraint failed: categories.slug_fr: SQLITE_CONSTRAINT`.
 */

export function uniqueViolation(err: unknown): { table: string; column: string } | null {
  const msg = errorText(err);
  const m = /UNIQUE constraint failed: ([a-z_]+)\.([a-z_]+)/.exec(msg);
  return m ? { table: m[1] as string, column: m[2] as string } : null;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return /FOREIGN KEY constraint failed/.test(errorText(err));
}

/** Name of a failed CHECK constraint, e.g. `delivery_fees_fee_nonneg`. */
export function checkViolation(err: unknown): string | null {
  const m = /CHECK constraint failed: ([a-z0-9_]+)/.exec(errorText(err));
  return m ? (m[1] as string) : null;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return `${err.message} ${cause instanceof Error ? cause.message : ''}`;
  }
  return String(err);
}
