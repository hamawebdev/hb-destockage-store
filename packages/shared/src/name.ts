/**
 * The order-name rule (SHARED-7): one implementation, used by the storefront (`NameSchema` in
 * order-schema.ts calls it) and by the admin contact edit in @hb/db. Pure and Valibot-free.
 *
 * Steps, in order (identical to NameSchema before SHARED-7):
 * 1. not a string ⇒ `name_required`;
 * 2. Unicode NFC;
 * 3. remove invisible marks (bidi marks, embeddings, overrides, isolates, ZWSP, word joiner, BOM);
 *    ZWNJ/ZWJ are kept because they shape Arabic-script text;
 * 4. collapse every whitespace run (spaces, tabs, line breaks, NBSP…) to one space, trim;
 * 5. empty ⇒ `name_required`;
 * 6. any remaining control, lone surrogate, private-use or format character (other than
 *    ZWNJ/ZWJ) ⇒ `name_invalid` — rejected, never silently removed;
 * 7. no letter ⇒ `name_invalid`;
 * 8. length outside NAME_MIN_LENGTH…NAME_MAX_LENGTH (UTF-16 code units) ⇒ `name_invalid`.
 */

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 80;

export type NameErrorCode = 'name_required' | 'name_invalid';
export type NameResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly code: NameErrorCode };

// Bidi marks, embeddings, overrides, isolates, zero-width space, word joiner and BOM: invisible,
// never part of a name. ZWNJ/ZWJ (U+200C/U+200D) are kept: they shape Arabic-script text.
const INVISIBLE_RE = /[\u200b\u200e\u200f\u061c\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
// Anything still left that is a control, surrogate, private-use or other format character.
const FORBIDDEN_IN_NAME_RE = /[\p{Cc}\p{Cs}\p{Co}]|(?![\u200c\u200d])\p{Cf}/u;
const LETTER_RE = /\p{L}/u;

/** Normalises and validates a customer name (order form, admin contact edit). */
export function normalizeName(input: unknown): NameResult {
  if (typeof input !== 'string') return { ok: false, code: 'name_required' };
  const value = input.normalize('NFC').replace(INVISIBLE_RE, '').replace(/\s+/gu, ' ').trim();
  if (value.length === 0) return { ok: false, code: 'name_required' };
  if (FORBIDDEN_IN_NAME_RE.test(value)) return { ok: false, code: 'name_invalid' };
  if (!LETTER_RE.test(value)) return { ok: false, code: 'name_invalid' };
  if (value.length < NAME_MIN_LENGTH || value.length > NAME_MAX_LENGTH) return { ok: false, code: 'name_invalid' };
  return { ok: true, value };
}
