// Form parsing and validation (Valibot). Handlers:
//
//   const Schema = v.object({ name: vText(120), price: vMoneyDzd(), active: vCheckbox() });
//   const f = await parseForm(c, Schema);
//   if (!f.ok) return c.render(<EditForm values={f.values} errors={f.errors} />, { title }), 422 …
//   // f.data is typed
//
// Use `v.object` (unknown fields are dropped) or `v.strictObject` (rejected). `_csrf` is removed
// before validation. Messages are dictionary keys (`form.*`), translated here.
import type { Context } from 'hono';
import * as v from 'valibot';
import type { AppEnv } from '../env.ts';
import type { MessageKey } from '../i18n/index.ts';
import { toAsciiDigits } from './digits.ts';

export type FormSchema = v.GenericSchema<Record<string, unknown>, Record<string, unknown>>;

export type ParsedForm<S extends FormSchema> =
  | { ok: true; data: v.InferOutput<S>; values: Record<string, string> }
  | { ok: false; errors: Record<string, string>; values: Record<string, string> };

const MSG = {
  required: 'form.required',
  invalid: 'form.invalid',
  moneyInteger: 'form.moneyInteger',
  tooLong: (max: number) => `form.tooLong|${max}`,
} as const;

/** Reads the urlencoded/multipart body. Files are not included in `values` (read them yourself). */
export async function readForm(c: Context<AppEnv>): Promise<Record<string, string>> {
  const body = await c.req.parseBody({ all: false });
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(body)) {
    if (k === '_csrf') continue;
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

export function validateForm<S extends FormSchema>(c: Context<AppEnv>, schema: S, values: Record<string, string>): ParsedForm<S> {
  const r = v.safeParse(schema, values, { abortPipeEarly: true });
  if (r.success) return { ok: true, data: r.output, values };
  const errors: Record<string, string> = {};
  for (const issue of r.issues) {
    const key = v.getDotPath(issue) ?? '_form';
    if (errors[key] !== undefined) continue;
    errors[key] = translateIssue(c, issue.message);
  }
  return { ok: false, errors, values };
}

export async function parseForm<S extends FormSchema>(c: Context<AppEnv>, schema: S): Promise<ParsedForm<S>> {
  return validateForm(c, schema, await readForm(c));
}

function translateIssue(c: Context<AppEnv>, message: string): string {
  const [key, arg] = message.split('|') as [string, string?];
  if (key.startsWith('form.')) {
    return c.var.t(key as MessageKey, arg !== undefined ? { max: Number(arg) } : undefined);
  }
  return c.var.t('form.invalid');
}

// ---------------------------------------------------------------------------------------------
// Field schemas (input is always a string or absent).
// ---------------------------------------------------------------------------------------------

/** Required trimmed text, 1..max chars. */
export const vText = (max: number) =>
  v.pipe(v.optional(v.string(), ''), v.trim(), v.minLength(1, MSG.required), v.maxLength(max, MSG.tooLong(max)));

/** Optional trimmed text; '' → null. */
export const vOptionalText = (max: number) =>
  v.pipe(
    v.optional(v.string(), ''),
    v.trim(),
    v.maxLength(max, MSG.tooLong(max)),
    v.transform((s) => (s === '' ? null : s)),
  );

/** Integer within [min, max]; accepts Eastern-Arabic digits. */
export const vInt = (min: number, max: number) =>
  v.pipe(
    v.optional(v.string(), ''),
    v.transform((s) => toAsciiDigits(s).trim()),
    v.minLength(1, MSG.required),
    v.regex(/^-?\d+$/, MSG.invalid),
    v.transform(Number),
    v.integer(MSG.invalid),
    v.minValue(min, MSG.invalid),
    v.maxValue(max, MSG.invalid),
  );

/**
 * Optional integer; '' or an absent key → null. The outer `v.optional` matters: object schemas
 * only treat optional/nullish entries as allowed-missing, not a union containing one.
 */
export const vOptionalInt = (min: number, max: number) =>
  v.optional(
    v.union([v.pipe(v.string(), v.trim(), v.length(0), v.transform(() => null)), vInt(min, max)], MSG.invalid),
    '',
  );

/**
 * Whole-dinar amount → digit string, or null (= field error `form.moneyInteger`). Prices are
 * integer DZD; a value is never rescaled (review ADMIN-1 r1 F2; lead spec 2026-11-05):
 * - plain digits: "14600";
 * - thousands grouping with ONE kind of separator (space, NBSP, narrow NBSP, thin space, "." or
 *   Arabic "٬"), every group after the first exactly three digits: "14 600", "14.600",
 *   "1.000.000", "١٤.٦٠٠";
 * - the single decimal exception: a trailing ",00", ".00" or Arabic "٫00" (zero centimes; lead
 *   ruling 2026-11-06: staff with an Arabic keyboard type "٫") after a valid
 *   integer part, using a different character than the grouping separator: "600,00" → 600,
 *   "1500.00" → 1500, "14.600,00" → 14600;
 * - everything else with a dot or comma is rejected: "1.5", "1,5", "14.60", "1500.50", "1,500",
 *   "14.600.00", "0.5".
 * Eastern-Arabic and Persian digits are accepted.
 */
export function normaliseDzd(input: string): string | null {
  let s = toAsciiDigits(input).trim();
  let centSep: string | undefined;
  const cents = /^(.*\d)([.,\u066B])00$/.exec(s);
  if (cents) {
    s = cents[1]!;
    centSep = cents[2]!;
  }
  if (/^\d+$/.test(s)) return s;
  const m = /^\d{1,3}([ \u00A0\u202F\u2009.\u066C])\d{3}(?:\1\d{3})*$/.exec(s);
  if (!m || m[1] === centSep) return null;
  return s.split(m[1]!).join('');
}

/** Integer DZD ≥ 0 (accepted spellings: see normaliseDzd). */
export const vMoneyDzd = (max = 100_000_000) =>
  v.pipe(
    v.optional(v.string(), ''),
    v.trim(),
    v.minLength(1, MSG.required),
    v.transform((s) => normaliseDzd(s) ?? 'invalid'),
    v.regex(/^\d+$/, MSG.moneyInteger),
    v.transform(Number),
    v.maxValue(max, MSG.invalid),
  );

/** Optional integer DZD: '' or an absent key → null (e.g. a compare-at price). */
export const vOptionalMoneyDzd = (max = 100_000_000) =>
  v.optional(
    v.union([v.pipe(v.string(), v.trim(), v.length(0), v.transform(() => null)), vMoneyDzd(max)], MSG.moneyInteger),
    '',
  );

const ABSENT = '\u0000absent';
/**
 * HTML checkbox: present (any value) → true, absent → false. The key is ALWAYS in the output:
 * an optional without a default would drop it, and Drizzle's `.set({ active: undefined })` then
 * silently leaves the column unchanged (unticking would never deactivate).
 */
export const vCheckbox = () => v.pipe(v.optional(v.string(), ABSENT), v.transform((s) => s !== ABSENT));

export const vPicklist = <const T extends readonly [string, ...string[]]>(values: T) =>
  v.pipe(v.optional(v.string(), ''), v.picklist(values, MSG.invalid));

export const vEmail = () =>
  v.pipe(v.optional(v.string(), ''), v.trim(), v.toLowerCase(), v.minLength(1, MSG.required), v.maxLength(254, MSG.tooLong(254)), v.email(MSG.invalid));

/** Positive integer id from a route param or field. */
export const vId = () => vInt(1, Number.MAX_SAFE_INTEGER);

/** Route param → positive integer id, or null (→ 404). */
export function paramId(c: Context<AppEnv>, name = 'id'): number | null {
  const raw = c.req.param(name);
  return raw !== undefined && /^[1-9]\d{0,15}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
}
