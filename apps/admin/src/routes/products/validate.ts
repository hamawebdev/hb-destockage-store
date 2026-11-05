/**
 * Product, options and variant-grid validation (ACAT-2, plan §2–§4). Each form is parsed by a
 * strict Valibot schema (admin-core `parseForm`/`validateForm`), then finished by a pure function
 * that applies the catalogue rules and returns either rows to write or message keys per field.
 * Grid and options schemas are built from the product's actual ids/rows, so they stay strict.
 */
import * as v from 'valibot';
import { vCheckbox, vOptionalInt, vOptionalText, vPicklist, vText } from '../../lib/forms.ts';
import { MAX_ORDER_TOTAL_DZD, vDzd, vOptionalDzd } from './lib/money.ts';
import { OPTION_KINDS } from '@hb/db';
import { cleanText } from './lib/text.ts';
import { checkSlug, suggestSlug } from './lib/slug.ts';
import { slugErrorKey, textErrorKey, type FieldMessageKey } from './lib/field-messages.ts';
import { MATRIX_LIMITS, normalizeSku, SKU_RE } from './lib/matrix.ts';
import type { ProductMessageKey } from './messages.ts';

export const LIMITS = { name: 120, brand: 60, summary: 300, description: 5000, /** Input sanity cap. Prices above MAX_ORDER_TOTAL_DZD are allowed but warned about (they cannot be ordered). */
  price: 10 * MAX_ORDER_TOTAL_DZD, stock: 9_999_999, weight: 100_000, optionName: 40, value: 40 } as const;

/** Absent → '' → null (vOptionalInt is a union: a strict object would reject the absent key). */
const optionalInt = (min: number, max: number) => v.optional(vOptionalInt(min, max), '');
const BRAND_RE = /^[\p{Script=Latin}\p{Nd}][\p{Script=Latin}\p{Nd} &'.+-]*$/u;

/** Message keys: shared field messages, product messages, or admin-core's `form.required`. */
export type ErrorKey = FieldMessageKey | ProductMessageKey | 'form.required';
export type Errors = Record<string, ErrorKey>;

// ---------------------------------------------------------------------------------------------
// Details (create + edit)
// ---------------------------------------------------------------------------------------------

const detailsEntries = {
  category_id: vOptionalInt(1, Number.MAX_SAFE_INTEGER),
  name_fr: vText(LIMITS.name),
  name_ar: vText(LIMITS.name),
  brand_latin: vOptionalText(LIMITS.brand),
  summary_fr: vOptionalText(LIMITS.summary),
  summary_ar: vOptionalText(LIMITS.summary),
  description_fr: vOptionalText(LIMITS.description),
  description_ar: vOptionalText(LIMITS.description),
  slug_fr: vOptionalText(80),
  slug_ar: vOptionalText(80),
  sort: optionalInt(0, 9999),
  placeholder: vCheckbox(),
  tp_fr: vCheckbox(),
  tp_ar: vCheckbox(),
};

export const DetailsSchema = v.strictObject({
  ...detailsEntries,
  v: optionalInt(0, Number.MAX_SAFE_INTEGER),
  confirm_slug_change: vCheckbox(),
});

export const CreateSchema = v.strictObject({
  ...detailsEntries,
  kind: vPicklist(['simple', 'variable'] as const),
  sku: v.pipe(vText(40), v.transform(normalizeSku)),
  price: vDzd(LIMITS.price),
  compare_at: vOptionalDzd(LIMITS.price),
  stock: optionalInt(0, LIMITS.stock),
  weight: optionalInt(0, LIMITS.weight),
});

export type DetailsData = v.InferOutput<typeof DetailsSchema>;
export type CreateData = v.InferOutput<typeof CreateSchema>;

export interface ProductRow {
  categoryId: number;
  nameFr: string;
  nameAr: string;
  brandLatin: string | null;
  summaryFr: string;
  summaryAr: string;
  descriptionFr: string;
  descriptionAr: string;
  slugFr: string;
  slugAr: string;
  sort: number;
  placeholder: boolean;
  translationPlaceholder: ('fr' | 'ar')[];
}

export interface DetailsContext {
  readonly categoryIds: ReadonlySet<number>;
  readonly slugTaken: (lang: 'fr' | 'ar', slug: string) => boolean;
}

export function finishDetails(data: DetailsData | CreateData, ctx: DetailsContext): { ok: true; row: ProductRow } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const text = (field: string, value: string | null, multiline = false): string => {
    if (value === null) return '';
    const r = cleanText(value, { multiline });
    if (!r.ok) errors[field] = textErrorKey(r.error);
    return r.ok ? r.value : value;
  };
  const nameFr = text('name_fr', data.name_fr);
  const nameAr = text('name_ar', data.name_ar);
  const summaryFr = text('summary_fr', data.summary_fr);
  const summaryAr = text('summary_ar', data.summary_ar);
  const descriptionFr = text('description_fr', data.description_fr, true);
  const descriptionAr = text('description_ar', data.description_ar, true);
  let brandLatin: string | null = null;
  if (data.brand_latin !== null) {
    const b = text('brand_latin', data.brand_latin);
    if (errors['brand_latin'] === undefined && !BRAND_RE.test(b)) errors['brand_latin'] = 'err.brand';
    brandLatin = b === '' ? null : b;
  }
  const slug = (lang: 'fr' | 'ar', input: string | null, fromName: string): string => {
    if (input === null) return suggestSlug(fromName, (s) => ctx.slugTaken(lang, s), 'produit');
    const r = checkSlug(input);
    if (!r.ok) {
      errors[`slug_${lang}`] = slugErrorKey(r.error);
      return input;
    }
    if (ctx.slugTaken(lang, r.value)) errors[`slug_${lang}`] = 'err.slug_taken';
    return r.value;
  };
  const slugFr = slug('fr', data.slug_fr, nameFr);
  const slugAr = slug('ar', data.slug_ar, nameAr);
  if (data.category_id === null || !ctx.categoryIds.has(data.category_id)) errors['category_id'] = 'err.category';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const translationPlaceholder: ('fr' | 'ar')[] = [];
  if (data.tp_fr === true) translationPlaceholder.push('fr');
  if (data.tp_ar === true) translationPlaceholder.push('ar');
  return {
    ok: true,
    row: {
      categoryId: data.category_id as number,
      nameFr,
      nameAr,
      brandLatin,
      summaryFr,
      summaryAr,
      descriptionFr,
      descriptionAr,
      slugFr,
      slugAr,
      sort: data.sort ?? 0,
      placeholder: data.placeholder === true,
      translationPlaceholder,
    },
  };
}

/** First variant of a new product. */
export function finishFirstVariant(data: CreateData, skuTaken: (sku: string) => boolean): { ok: true } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  if (!SKU_RE.test(data.sku)) errors['sku'] = 'err.sku_format';
  else if (skuTaken(data.sku)) errors['sku'] = 'err.sku_taken';
  if (data.compare_at !== null && data.compare_at <= data.price) errors['compare_at'] = 'err.compare_at';
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Variant grid
// ---------------------------------------------------------------------------------------------

export interface GridVariant {
  readonly id: number;
}

/** Strict schema for the grid of these variants: `sku_<id>`, `price_<id>`, … plus `default`. */
export function gridSchema(variantIds: readonly number[]) {
  const entries: Record<string, v.GenericSchema<unknown, unknown>> = {
    default: optionalInt(1, Number.MAX_SAFE_INTEGER),
  };
  for (const id of variantIds) {
    entries[`sku_${id}`] = v.pipe(vText(40), v.transform(normalizeSku));
    entries[`price_${id}`] = vDzd(LIMITS.price);
    entries[`compare_${id}`] = vOptionalDzd(LIMITS.price);
    entries[`stock_${id}`] = optionalInt(0, LIMITS.stock);
    /** Stock as rendered ('' = untracked): the write is conditional on it (orders decrement stock). */
    entries[`stockwas_${id}`] = optionalInt(0, LIMITS.stock);
    entries[`weight_${id}`] = optionalInt(0, LIMITS.weight);
    entries[`active_${id}`] = vCheckbox();
    entries[`ver_${id}`] = v.pipe(vOptionalInt(0, Number.MAX_SAFE_INTEGER), v.nonNullable(v.number(), 'form.required'));
  }
  return v.strictObject(entries);
}

export interface GridRow {
  id: number;
  sku: string;
  priceDzd: number;
  compareAtDzd: number | null;
  stock: number | null;
  stockWas: number | null;
  weightG: number | null;
  active: boolean;
  version: number;
}

export function finishGrid(
  data: Record<string, unknown>,
  variantIds: readonly number[],
  skuTakenElsewhere: (sku: string) => boolean,
): { ok: true; rows: GridRow[]; defaultId: number | null } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const rows: GridRow[] = variantIds.map((id) => ({
    id,
    sku: data[`sku_${id}`] as string,
    priceDzd: data[`price_${id}`] as number,
    compareAtDzd: (data[`compare_${id}`] ?? null) as number | null,
    stock: (data[`stock_${id}`] ?? null) as number | null,
    stockWas: (data[`stockwas_${id}`] ?? null) as number | null,
    weightG: (data[`weight_${id}`] ?? null) as number | null,
    active: data[`active_${id}`] === true,
    version: data[`ver_${id}`] as number,
  }));
  const seen = new Set<string>();
  for (const r of rows) {
    if (!SKU_RE.test(r.sku)) errors[`sku_${r.id}`] = 'err.sku_format';
    else if (seen.has(r.sku) || skuTakenElsewhere(r.sku)) errors[`sku_${r.id}`] = 'err.sku_taken';
    seen.add(r.sku);
    if (r.compareAtDzd !== null && r.compareAtDzd <= r.priceDzd) errors[`compare_${r.id}`] = 'err.compare_at';
  }
  const defaultId = (data['default'] ?? null) as number | null;
  const active = rows.filter((r) => r.active);
  if (active.length > 0 && (defaultId === null || !active.some((r) => r.id === defaultId))) errors['default'] = 'err.default';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, rows, defaultId: active.length > 0 ? defaultId : null };
}

// ---------------------------------------------------------------------------------------------
// Options form → draft
// ---------------------------------------------------------------------------------------------

/** Rows rendered: existing options + one blank; existing values + 2 blank per option. */
export const MAX_OPTION_ROWS = MATRIX_LIMITS.maxOptions + 1;
export const MAX_VALUE_ROWS = MATRIX_LIMITS.maxValuesPerOption + 2;

export function optionsSchema() {
  const e: Record<string, v.GenericSchema<unknown, unknown>> = {
    v: optionalInt(0, Number.MAX_SAFE_INTEGER),
    /** Prefix for generated variant SKUs. */
    base_sku: v.pipe(vText(40), v.transform(normalizeSku)),
  };
  for (let i = 0; i < MAX_OPTION_ROWS; i++) {
    e[`o${i}_id`] = optionalInt(1, Number.MAX_SAFE_INTEGER);
    e[`o${i}_kind`] = v.optional(vPicklist(OPTION_KINDS), 'other');
    e[`o${i}_name_fr`] = v.optional(vOptionalText(LIMITS.optionName), '');
    e[`o${i}_name_ar`] = v.optional(vOptionalText(LIMITS.optionName), '');
    e[`o${i}_remove`] = vCheckbox();
    for (let j = 0; j < MAX_VALUE_ROWS; j++) {
      const k = `o${i}v${j}`;
      e[`${k}_id`] = optionalInt(1, Number.MAX_SAFE_INTEGER);
      e[`${k}_fr`] = v.optional(vOptionalText(LIMITS.value), '');
      e[`${k}_ar`] = v.optional(vOptionalText(LIMITS.value), '');
      e[`${k}_hex`] = v.optional(vOptionalText(7), '');
      e[`${k}_remove`] = vCheckbox();
    }
  }
  return v.strictObject(e);
}

export interface DraftValue {
  /** Existing id, or null for a new value. */
  id: number | null;
  valueFr: string;
  valueAr: string;
  swatchHex: string | null;
}
export interface DraftOption {
  id: number | null;
  kind: (typeof OPTION_KINDS)[number];
  nameFr: string;
  nameAr: string;
  values: DraftValue[];
}

export interface ExistingOption {
  id: number;
  kind: (typeof OPTION_KINDS)[number];
  valueIds: readonly number[];
}

/**
 * Turns the options form into the target structure (in position order). Blank new rows are
 * ignored; `_remove` drops an option or value. Ids must belong to this product.
 */
export function finishOptions(data: Record<string, unknown>, existing: readonly ExistingOption[]): { ok: true; options: DraftOption[] } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const out: DraftOption[] = [];
  const str = (k: string): string => {
    const raw = data[k];
    if (typeof raw !== 'string' || raw === '') return '';
    const r = cleanText(raw);
    if (!r.ok) errors[k] = textErrorKey(r.error);
    return r.ok ? r.value : raw;
  };
  const known = new Map(existing.map((o) => [o.id, o]));
  for (let i = 0; i < MAX_OPTION_ROWS; i++) {
    const id = (data[`o${i}_id`] ?? null) as number | null;
    const prior = id === null ? undefined : known.get(id);
    if (id !== null && prior === undefined) {
      errors[`o${i}_id`] = 'err.stale';
      continue;
    }
    if (data[`o${i}_remove`] === true) continue;
    const nameFr = str(`o${i}_name_fr`);
    const nameAr = str(`o${i}_name_ar`);
    const kind = data[`o${i}_kind`] as DraftOption['kind'];
    const values: DraftValue[] = [];
    const seenFr = new Set<string>();
    const seenAr = new Set<string>();
    for (let j = 0; j < MAX_VALUE_ROWS; j++) {
      const k = `o${i}v${j}`;
      const vid = (data[`${k}_id`] ?? null) as number | null;
      if (vid !== null && !(prior?.valueIds.includes(vid) ?? false)) {
        errors[`${k}_id`] = 'err.stale';
        continue;
      }
      if (data[`${k}_remove`] === true) continue;
      const fr = str(`${k}_fr`);
      const ar = str(`${k}_ar`);
      const hexRaw = str(`${k}_hex`).toLowerCase();
      if (vid === null && fr === '' && ar === '') continue; // blank new row
      if (fr === '') errors[`${k}_fr`] = 'form.required';
      if (ar === '') errors[`${k}_ar`] = 'form.required';
      let swatchHex: string | null = null;
      if (hexRaw !== '') {
        if (kind !== 'colour') errors[`${k}_hex`] = 'err.swatch_kind';
        else if (!/^#[0-9a-f]{6}$/.test(hexRaw)) errors[`${k}_hex`] = 'err.swatch';
        else swatchHex = hexRaw;
      }
      const kf = fr.toLocaleLowerCase('fr');
      const ka = ar;
      if ((fr !== '' && seenFr.has(kf)) || (ar !== '' && seenAr.has(ka))) errors[`${k}_fr`] = 'err.value_duplicate';
      seenFr.add(kf);
      seenAr.add(ka);
      values.push({ id: vid, valueFr: fr, valueAr: ar, swatchHex });
    }
    if (id === null && nameFr === '' && nameAr === '' && values.length === 0) continue; // blank new option
    if (nameFr === '') errors[`o${i}_name_fr`] = 'form.required';
    if (nameAr === '') errors[`o${i}_name_ar`] = 'form.required';
    if (prior !== undefined && prior.kind !== kind) errors[`o${i}_kind`] = 'err.option_kind_change';
    out.push({ id, kind, nameFr, nameAr, values });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, options: out };
}

/**
 * Suggested base SKU for the generator: the longest dash-separated prefix shared by the current
 * SKUs (e.g. HB-POELE-28CM-ROUGE, HB-POELE-32CM-NOIR → HB-POELE), or the single SKU itself.
 */
export function suggestBaseSku(skus: readonly string[]): string {
  if (skus.length === 0) return 'HB';
  if (skus.length === 1) return skus[0] as string;
  const parts = skus.map((s) => s.split('-'));
  const first = parts[0] as string[];
  let n = 0;
  while (n < first.length && parts.every((p) => p[n] === first[n])) n++;
  return n === 0 ? (first[0] as string) : first.slice(0, n).join('-');
}
