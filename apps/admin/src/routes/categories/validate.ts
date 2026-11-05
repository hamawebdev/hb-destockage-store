/**
 * Category form validation (ACAT-1, plan §2 and §5). Two stages:
 *  1. `CategoryFormSchema` (Valibot, via admin-core's `parseForm`): shape, types, lengths. Strict:
 *     unknown fields are rejected (no mass assignment of id, timestamps, …).
 *  2. `finishCategory` (pure): text safety (CAT-1 rule), slug suggestion/format/uniqueness, parent
 *     placement (no cycle, ≤ 3 levels). Returns the row to write or message keys per field.
 */
import * as v from 'valibot';
import { vCheckbox, vOptionalInt, vOptionalText, vText } from '../../lib/forms.ts';
import { cleanText } from '../products/lib/text.ts';
import { checkSlug, suggestSlug } from '../products/lib/slug.ts';
import { slugErrorKey, textErrorKey, type FieldMessageKey } from '../products/lib/field-messages.ts';
import { checkParent, type ParentError, type TreeNode } from './tree.ts';

export const NAME_MAX = 120;
export const DESCRIPTION_MAX = 2000;

/**
 * `vOptionalInt` is a union, and inside a strict object a union does not accept an absent key
 * (Valibot reports a key issue). Absent → '' → null.
 */
const optionalInt = (min: number, max: number) => v.optional(vOptionalInt(min, max), '');

export const CategoryFormSchema = v.strictObject({
  name_fr: vText(NAME_MAX),
  name_ar: vText(NAME_MAX),
  description_fr: vOptionalText(DESCRIPTION_MAX),
  description_ar: vOptionalText(DESCRIPTION_MAX),
  slug_fr: vOptionalText(80),
  slug_ar: vOptionalText(80),
  parent_id: optionalInt(1, Number.MAX_SAFE_INTEGER),
  sort: optionalInt(0, 9999),
  active: vCheckbox(),
  placeholder: vCheckbox(),
  tp_fr: vCheckbox(),
  tp_ar: vCheckbox(),
  /** `updated_at` the edit form was rendered with (absent on create). */
  v: optionalInt(0, Number.MAX_SAFE_INTEGER),
  confirm_slug_change: vCheckbox(),
});

export type CategoryFormData = v.InferOutput<typeof CategoryFormSchema>;

/** Columns written by create/update (DB-1 `categories`). */
export interface CategoryRow {
  nameFr: string;
  nameAr: string;
  descriptionFr: string | null;
  descriptionAr: string | null;
  slugFr: string;
  slugAr: string;
  parentId: number | null;
  sort: number;
  active: boolean;
  placeholder: boolean;
  translationPlaceholder: ('fr' | 'ar')[];
}

export type CategoryErrorKey = FieldMessageKey | `parent.${ParentError}`;

export interface FinishContext {
  /** null on create. */
  readonly id: number | null;
  readonly nodes: readonly TreeNode[];
  /** Is this slug used by another category in that language? */
  readonly slugTaken: (lang: 'fr' | 'ar', slug: string) => boolean;
}

export type FinishResult =
  | { readonly ok: true; readonly row: CategoryRow }
  | { readonly ok: false; readonly errors: Readonly<Record<string, CategoryErrorKey>> };

export function finishCategory(data: CategoryFormData, ctx: FinishContext): FinishResult {
  const errors: Record<string, CategoryErrorKey> = {};
  const text = (field: string, value: string | null, multiline: boolean): string | null => {
    if (value === null) return null;
    const r = cleanText(value, { multiline });
    if (!r.ok) {
      errors[field] = textErrorKey(r.error);
      return null;
    }
    return r.value === '' ? null : r.value;
  };
  const nameFr = text('name_fr', data.name_fr, false) ?? '';
  const nameAr = text('name_ar', data.name_ar, false) ?? '';
  const descriptionFr = text('description_fr', data.description_fr, true);
  const descriptionAr = text('description_ar', data.description_ar, true);

  const slug = (lang: 'fr' | 'ar', input: string | null, fromName: string): string => {
    const field = `slug_${lang}`;
    if (input === null) {
      // Blank: suggest from the name (Arabic is transliterated), avoiding taken slugs.
      return suggestSlug(fromName, (s) => ctx.slugTaken(lang, s), 'categorie');
    }
    const r = checkSlug(input);
    if (!r.ok) {
      errors[field] = slugErrorKey(r.error);
      return input;
    }
    if (ctx.slugTaken(lang, r.value)) errors[field] = 'err.slug_taken';
    return r.value;
  };
  const slugFr = slug('fr', data.slug_fr, nameFr);
  const slugAr = slug('ar', data.slug_ar, nameAr);

  const parentId = data.parent_id;
  const parentError = checkParent(ctx.nodes, ctx.id, parentId);
  if (parentError !== null) errors['parent_id'] = `parent.${parentError}`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const translationPlaceholder: ('fr' | 'ar')[] = [];
  if (data.tp_fr === true) translationPlaceholder.push('fr');
  if (data.tp_ar === true) translationPlaceholder.push('ar');
  return {
    ok: true,
    row: {
      nameFr,
      nameAr,
      descriptionFr,
      descriptionAr,
      slugFr,
      slugAr,
      parentId,
      sort: data.sort ?? 0,
      active: data.active === true,
      placeholder: data.placeholder === true,
      translationPlaceholder,
    },
  };
}
