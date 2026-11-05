/**
 * Variant matrix generator (ACAT-2, plan §3). Pure, deterministic, no I/O.
 *
 * Input = the product's target options (already saved, in position order) and its existing
 * variants. Output = a plan the router applies in one D1 batch: which variants to keep (and which
 * option values they gain), which to create, which to delete, and the default variant.
 *
 * Invariants it guarantees (they are CAT-1 `checkProductIntegrity`'s, which applies them to every
 * variant, active or not):
 *  - every variant holds exactly one value of each option;
 *  - no two variants share a combination;
 *  - exactly one default among active variants (when any is active).
 * A combination that disappears can therefore only be deleted, never kept as inactive. When the
 * variant to delete is referenced by an order line or a pack, the plan is refused
 * (`referenced_conflict`) instead: the editor must keep that value/option.
 * Stopping the sale of one combination is `active = false` in the variant grid, not this module.
 */
import { slugify } from './slug.ts';

export const MATRIX_LIMITS = { maxOptions: 3, maxValuesPerOption: 30, maxCombinations: 100 } as const;
export const SKU_MAX = 40;
export const SKU_RE = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;

export interface MatrixValue {
  readonly id: number;
  /** French label; the SKU code is derived from it. */
  readonly labelFr: string;
}

export interface MatrixOption {
  readonly id: number;
  /** In position order. */
  readonly values: readonly MatrixValue[];
}

export interface ExistingVariant {
  readonly id: number;
  readonly sku: string;
  /** Current value links, with the option each value belongs to (values of removed options included). */
  readonly links: readonly { readonly optionId: number; readonly valueId: number }[];
  readonly active: boolean;
  readonly isDefault: boolean;
  /** Referenced by `order_items` or `pack_items`: must never be deleted. */
  readonly referenced: boolean;
}

export interface MatrixInput {
  /** Target options in position order. */
  readonly options: readonly MatrixOption[];
  readonly existing: readonly ExistingVariant[];
  /** Product base SKU, e.g. `HB-POELE`. */
  readonly baseSku: string;
  /** For an option an existing variant has no value of (option just added): the value it takes. Default: the option's first value. */
  readonly fill?: Readonly<Record<number, number>>;
  /** SKUs already used anywhere in the catalogue (other products). Own variants' SKUs are added automatically. */
  readonly isSkuTaken?: (sku: string) => boolean;
}

export type MatrixError =
  | { readonly code: 'no_options' }
  | { readonly code: 'too_many_options' }
  | { readonly code: 'empty_option'; readonly optionId: number }
  | { readonly code: 'too_many_values'; readonly optionId: number }
  | { readonly code: 'too_many_combinations'; readonly count: number }
  | { readonly code: 'bad_fill'; readonly optionId: number }
  | { readonly code: 'bad_base_sku' }
  | { readonly code: 'referenced_conflict'; readonly variantIds: readonly number[] };

export type MatrixRow =
  | { readonly kind: 'keep'; readonly variantId: number; readonly optionValueIds: readonly number[] }
  | { readonly kind: 'create'; readonly sku: string; readonly optionValueIds: readonly number[] };

export interface MatrixPlan {
  /** Every resulting variant in matrix order (= the new `position` order). */
  readonly rows: readonly MatrixRow[];
  /** Kept variants that gain value links (option added). */
  readonly addLinks: readonly { readonly variantId: number; readonly optionValueIds: readonly number[] }[];
  /** Kept variants that lose value links (option removed). */
  readonly dropLinks: readonly { readonly variantId: number; readonly optionValueIds: readonly number[] }[];
  readonly deleteVariantIds: readonly number[];
  /** The default variant afterwards: an existing id, a SKU of a created row, or null (no active variant). */
  readonly defaultVariant: { readonly variantId: number } | { readonly sku: string } | null;
}

export type MatrixResult = { readonly ok: true; readonly plan: MatrixPlan } | { readonly ok: false; readonly errors: readonly MatrixError[] };

const comboKey = (ids: readonly number[]): string => [...ids].sort((a, b) => a - b).join('-');

/** SKU code of an option value: ASCII, upper case, no dashes, ≤ 6 chars (e.g. "28 cm" → "28CM"). */
export function valueCode(labelFr: string): string {
  const code = slugify(labelFr).replace(/-/g, '').toUpperCase().slice(0, 6);
  return code === '' ? 'X' : code;
}

/** Upper-cased, restricted to the SKU charset. */
export function normalizeSku(s: string): string {
  return s.trim().toUpperCase();
}

function buildSku(base: string, codes: readonly string[]): string {
  const joined = [base, ...codes].join('-');
  return joined.length <= SKU_MAX ? joined : joined.slice(0, SKU_MAX).replace(/[-._]+$/, '');
}

function freeSku(candidate: string, taken: (s: string) => boolean): string {
  if (!taken(candidate)) return candidate;
  for (let n = 2; n < 100_000; n++) {
    const suffix = `-${n}`;
    const room = SKU_MAX - suffix.length;
    const c = (candidate.length > room ? candidate.slice(0, room).replace(/[-._]+$/, '') : candidate) + suffix;
    if (!taken(c)) return c;
  }
  throw new Error('freeSku: exhausted');
}

/** Cartesian product in option order, then value order. */
function cartesian(options: readonly MatrixOption[]): number[][] {
  let acc: number[][] = [[]];
  for (const o of options) {
    const next: number[][] = [];
    for (const prefix of acc) for (const v of o.values) next.push([...prefix, v.id]);
    acc = next;
  }
  return acc;
}

export function generateMatrix(input: MatrixInput): MatrixResult {
  const { options, existing } = input;
  const errors: MatrixError[] = [];
  const baseSku = normalizeSku(input.baseSku);

  if (options.length === 0) errors.push({ code: 'no_options' });
  if (options.length > MATRIX_LIMITS.maxOptions) errors.push({ code: 'too_many_options' });
  for (const o of options) {
    if (o.values.length === 0) errors.push({ code: 'empty_option', optionId: o.id });
    if (o.values.length > MATRIX_LIMITS.maxValuesPerOption) errors.push({ code: 'too_many_values', optionId: o.id });
  }
  if (!SKU_RE.test(baseSku)) errors.push({ code: 'bad_base_sku' });
  const count = options.reduce((n, o) => n * o.values.length, 1);
  if (options.length > 0 && count > MATRIX_LIMITS.maxCombinations) errors.push({ code: 'too_many_combinations', count });

  // value id → option id, for target options.
  const optionOfValue = new Map<number, number>();
  const valueById = new Map<number, MatrixValue>();
  for (const o of options) {
    for (const v of o.values) {
      optionOfValue.set(v.id, o.id);
      valueById.set(v.id, v);
    }
  }
  const fill = new Map<number, number>();
  for (const o of options) {
    const wanted = input.fill?.[o.id];
    const first = o.values[0];
    if (wanted !== undefined && !o.values.some((v) => v.id === wanted)) errors.push({ code: 'bad_fill', optionId: o.id });
    else if (wanted !== undefined) fill.set(o.id, wanted);
    else if (first !== undefined) fill.set(o.id, first.id);
  }
  if (errors.length > 0) return { ok: false, errors };

  // Projection of each existing variant onto the target options:
  //  - link to an option that is no longer a target option (option removed): dropped;
  //  - link to a target option whose value is no longer a target value (value removed): the
  //    combination is gone, so the variant is deleted (refused if referenced);
  //  - no link for a target option (option added): it takes the `fill` value.
  const deleteIds: number[] = [];
  const conflicts: number[] = [];
  const addLinks: { variantId: number; optionValueIds: number[] }[] = [];
  const dropLinks: { variantId: number; optionValueIds: number[] }[] = [];

  interface Projected {
    readonly v: ExistingVariant;
    readonly combo: number[];
    readonly added: number[];
    readonly dropped: number[];
  }
  const projected: Projected[] = [];
  const targetOptionIds = new Set(options.map((o) => o.id));
  for (const v of existing) {
    const byOption = new Map<number, number[]>();
    const dropped: number[] = [];
    let valueRemoved = false;
    for (const { optionId, valueId } of v.links) {
      if (!targetOptionIds.has(optionId)) dropped.push(valueId);
      else if (optionOfValue.get(valueId) !== optionId) valueRemoved = true;
      else byOption.set(optionId, [...(byOption.get(optionId) ?? []), valueId]);
    }
    // Value removed, or two values of one option (corrupt data): the combination is gone.
    if (valueRemoved || [...byOption.values()].some((ids) => ids.length > 1)) {
      (v.referenced ? conflicts : deleteIds).push(v.id);
      continue;
    }
    const combo: number[] = [];
    const added: number[] = [];
    for (const o of options) {
      const have = byOption.get(o.id)?.[0];
      if (have !== undefined) combo.push(have);
      else {
        const f = fill.get(o.id) as number;
        combo.push(f);
        added.push(f);
      }
    }
    projected.push({ v, combo, added, dropped });
  }

  // Duplicates after projection: keep the best one, delete the rest (referenced ones conflict).
  const rank = (p: Projected): number[] => [p.v.referenced ? 0 : 1, p.v.active ? 0 : 1, p.v.isDefault ? 0 : 1, p.v.id];
  const cmp = (a: Projected, b: Projected): number => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if ((ra[i] as number) !== (rb[i] as number)) return (ra[i] as number) - (rb[i] as number);
    return 0;
  };
  const keptByKey = new Map<string, Projected>();
  for (const p of [...projected].sort(cmp)) {
    const key = comboKey(p.combo);
    if (!keptByKey.has(key)) keptByKey.set(key, p);
    else (p.v.referenced ? conflicts : deleteIds).push(p.v.id);
  }

  if (conflicts.length > 0) return { ok: false, errors: [{ code: 'referenced_conflict', variantIds: [...conflicts].sort((a, b) => a - b) }] };

  // SKU allocation for new rows: avoid own SKUs (kept and deleted ones are still in the DB until the batch runs) and the catalogue's.
  const ownSkus = new Set(existing.map((v) => normalizeSku(v.sku)));
  const generated = new Set<string>();
  const taken = (s: string): boolean => ownSkus.has(s) || generated.has(s) || (input.isSkuTaken?.(s) ?? false);

  const rows: MatrixRow[] = [];
  for (const combo of cartesian(options)) {
    const kept = keptByKey.get(comboKey(combo));
    if (kept !== undefined) {
      rows.push({ kind: 'keep', variantId: kept.v.id, optionValueIds: combo });
      if (kept.added.length > 0) addLinks.push({ variantId: kept.v.id, optionValueIds: kept.added });
      if (kept.dropped.length > 0) dropLinks.push({ variantId: kept.v.id, optionValueIds: kept.dropped });
    } else {
      const codes = combo.map((id) => valueCode(valueById.get(id)?.labelFr ?? ''));
      const sku = freeSku(buildSku(baseSku, codes), taken);
      generated.add(sku);
      rows.push({ kind: 'create', sku, optionValueIds: combo });
    }
  }

  // Default: the current default if kept and active; else the first active kept row; else the
  // first created row (new variants are active); else none.
  const keptIds = new Set(rows.flatMap((r) => (r.kind === 'keep' ? [r.variantId] : [])));
  const byId = new Map(existing.map((v) => [v.id, v]));
  const currentDefault = existing.find((v) => v.isDefault && v.active && keptIds.has(v.id));
  let defaultVariant: MatrixPlan['defaultVariant'] = null;
  if (currentDefault !== undefined) defaultVariant = { variantId: currentDefault.id };
  else {
    for (const r of rows) {
      if (r.kind === 'keep' && byId.get(r.variantId)?.active === true) {
        defaultVariant = { variantId: r.variantId };
        break;
      }
      if (r.kind === 'create') {
        defaultVariant = { sku: r.sku };
        break;
      }
    }
  }

  return {
    ok: true,
    plan: {
      rows,
      addLinks,
      dropLinks,
      deleteVariantIds: [...deleteIds].sort((a, b) => a - b),
      defaultVariant,
    },
  };
}
