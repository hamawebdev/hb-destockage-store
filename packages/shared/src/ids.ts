/**
 * Identifier types shared by the order flow, the DB schema and the admin.
 * All are positive integers at runtime (D1 INTEGER primary keys / official codes).
 */

/** `variants.id`. Every product has ≥ 1 variant; order lines always reference a variant. */
export type VariantId = number;

/** `communes.id`. */
export type CommuneId = number;

/** Wilaya code 1–69 (Law 26-06 + Decree 26-206). The 58-wilaya courier code is a separate column. */
export type WilayaCode = number;

export const WILAYA_CODE_MIN = 1;
export const WILAYA_CODE_MAX = 69;

export function isWilayaCode(value: unknown): value is WilayaCode {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= WILAYA_CODE_MIN &&
    value <= WILAYA_CODE_MAX
  );
}

/** True for a positive safe integer (variant and commune ids). */
export function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
