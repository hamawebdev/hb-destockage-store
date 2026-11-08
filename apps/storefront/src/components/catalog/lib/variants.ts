import type { Id, OptionProps, VariantProps } from '@hb/catalog';

/**
 * Variant picker model.
 *
 *  - `none`   one variant: no picker (the order form posts `defaultVariantId`).
 *  - `single` one option (size *or* colour): each value is a radio `name="variantId"
 *             value="<variant id>"`, so the choice reaches the order form with no JS.
 *  - `multi`  two or more options: radios `name="opt.<option id>" value="<value id>"`; the
 *             Worker resolves the combination when JS is off, `variant.js` fills a hidden
 *             `variantId` when it is on.
 *
 * Every radio has `id="ov-<value id>"` (option-value ids are unique across the catalogue) and
 * `form="order-form"`, so the picker sits outside orderform's `<form>`.
 *
 * The CSS is identical on every product page (hash CSP, shell's post-build check), so no
 * per-product rules: without JS, `single` mode switches the price/stock block and the "selected
 * value" label with constant positional `:has()` rules (up to CSS_POSITIONS values); `multi` mode
 * shows the default variant until variant.js runs, and the Worker's review step shows the exact
 * price either way. Browsers without `:has()` (≈ 4 % in Algeria) keep the default block.
 */
export type PickerMode = 'none' | 'single' | 'multi';

export interface PickerInput {
  readonly options: readonly OptionProps[];
  readonly variants: readonly VariantProps[];
}

export function pickerMode({ options, variants }: PickerInput): PickerMode {
  if (variants.length <= 1 || options.length === 0) return 'none';
  return options.length === 1 ? 'single' : 'multi';
}

/**
 * The variant preselected on the product page (checked radios, visible price/stock block, JSON-LD
 * sku): the default variant when it can be ordered, else the first orderable one; a sold-out
 * default is never preselected. Only when nothing is orderable does it fall back to the default.
 */
export function defaultVariant(variants: readonly VariantProps[]): VariantProps | undefined {
  return (
    variants.find((v) => v.isDefault && v.available) ??
    variants.find((v) => v.available) ??
    variants.find((v) => v.isDefault) ??
    variants[0]
  );
}

export function isAvailable(v: VariantProps): boolean {
  return v.available;
}

/** `single` mode: the variant each value selects (undefined ⇒ value has no active variant). */
export function variantByValue(variants: readonly VariantProps[]): Map<Id, VariantProps> {
  const m = new Map<Id, VariantProps>();
  for (const v of variants) for (const id of v.optionValueIds) m.set(id, v);
  return m;
}

export const radioId = (valueId: Id): string => `ov-${valueId}`;
export const radioName = (mode: PickerMode, optionId: Id): string =>
  mode === 'single' ? 'variantId' : `opt.${optionId}`;

const HEX = /^#[0-9a-f]{6}$/i;

/** Swatch fill for an SVG presentation attribute (allowed under the hash CSP, unlike style=""). */
export function swatchFill(hex: string | null): string | null {
  return hex && HEX.test(hex) ? hex.toLowerCase() : null;
}

/**
 * The selected-variant blocks (price, stock, SKU) rendered in a `.cat-vps` container, in this
 * order. `single` mode: one block per option value, same order as the radios, so the template's
 * constant positional `:has()` CSS switches them with no JS (block undefined ⇒ the value has no
 * variant). `multi` mode: one block per variant; variant.js switches them by `data-k`.
 */
export function variantBlocks({ options, variants }: PickerInput): readonly (VariantProps | undefined)[] {
  const mode = pickerMode({ options, variants });
  if (mode === 'single') {
    const byValue = variantByValue(variants);
    return (options[0]?.values ?? []).map((v) => byValue.get(v.id));
  }
  return variants;
}

/** How many values per option the template's positional CSS covers; beyond, variant.js does it. */
export const CSS_POSITIONS = 12;
