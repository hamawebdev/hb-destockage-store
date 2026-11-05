/**
 * Algerian mobile phone normalisation and validation.
 *
 * Rule (CLAUDE.md, STACK-REPORT §6): the national significant number (NSN, without the trunk
 * `0`) must match libphonenumber's Algerian mobile pattern. Never `^0[567]\d{8}$`, which
 * accepts unallocated ranges such as 050–053.
 *
 * Source: libphonenumber `resources/PhoneNumberMetadata.xml`, territory DZ, release v9.0.42
 * (2026-10-27), checked at master commit 5ea78f46ccc1a258012344801ce04eb6eb4c55da (2026-11-04).
 * The mobile `<nationalNumberPattern>` is copied verbatim below; the non-mobile patterns are used
 * only to tell "not a mobile" (`phone_not_mobile`) from "not a phone number" (`phone_invalid`).
 * To refresh: compare the DZ block of that file with the constants here and the provenance test.
 *
 * Runs in Workers, Node and the browser; no dependencies.
 */

/** DZ mobile NSN pattern (9 digits), verbatim from libphonenumber v9.0.42. */
export const DZ_MOBILE_NSN_PATTERN = '5(?:4[0-29]|6[0-4])\\d{6}|(?:55|6\\d|7[7-9])\\d{7}';

/** DZ fixedLine, tollFree, premiumRate and voip NSN patterns, verbatim from libphonenumber v9.0.42. */
export const DZ_NON_MOBILE_NSN_PATTERNS = [
  '9619\\d{5}|(?:[1-3]\\d|4[013-689])\\d{6}',
  '800\\d{6}',
  '80[3-689]1\\d{5}',
  '98[23]\\d{6}',
] as const;

// The whole alternation is anchored: neither alternative may match a prefix or a suffix.
const MOBILE_NSN_RE = /* @__PURE__ */ new RegExp(`^(?:${DZ_MOBILE_NSN_PATTERN})$`);
const NON_MOBILE_NSN_RE = /* @__PURE__ */ new RegExp(`^(?:${DZ_NON_MOBILE_NSN_PATTERNS.join('|')})$`);

export const DZ_COUNTRY_CODE = '213';

/** Longer inputs are rejected before any processing. */
export const PHONE_INPUT_MAX_LENGTH = 64;

export type PhoneE164 = `+213${string}`;

/** Stable error codes; messages live in brand strings `order.errors.<code>`. */
export type PhoneErrorCode = 'phone_required' | 'phone_invalid' | 'phone_not_mobile';

export type PhoneOk = {
  readonly ok: true;
  /** `+213XXXXXXXXX` — what is stored (`orders.phone_e164`, `customers.phone_e164`) and rate-limited on. */
  readonly e164: PhoneE164;
  /** Trunk-prefixed national form `0XXXXXXXXX` (10 ASCII digits) — what Algerians dial and couriers expect. */
  readonly national: string;
};
export type PhoneErr = { readonly ok: false; readonly code: PhoneErrorCode };
export type PhoneResult = PhoneOk | PhoneErr;

// Eastern Arabic-Indic (U+0660–0669), Extended/Persian (U+06F0–06F9) and fullwidth (U+FF10–FF19) digits.
const NON_ASCII_DIGIT_RE = /[٠-٩۰-۹０-９]/g;
// Separators users type or paste: whitespace (incl. NBSP/NNBSP), ASCII and Unicode dashes and
// minus, dots, parentheses — and every Unicode format character (\p{Cf}: soft hyphen, ZWSP, ZWNJ,
// ZWJ, word joiner, LRM/RLM/ALM, bidi embeddings/overrides/isolates, BOM, tags…), which
// WhatsApp and contact apps add when a number is copied. None can be part of a phone number.
const STRIP_RE = /[\s\p{Cf}\-\u2010-\u2015\u2212.()]/gu;

/** Converts Eastern Arabic, Persian and fullwidth digits to ASCII; leaves everything else unchanged. */
export function toAsciiDigits(input: string): string {
  return input.replace(NON_ASCII_DIGIT_RE, (d) => {
    const cp = d.charCodeAt(0);
    return String(cp - (cp >= 0xff10 ? 0xff10 : cp >= 0x06f0 ? 0x06f0 : 0x0660));
  });
}

/**
 * Normalises a user-typed Algerian mobile number.
 * Accepts `0XXXXXXXXX`, `+213XXXXXXXXX`, `00213XXXXXXXXX`, `213XXXXXXXXX`, a redundant trunk 0
 * after any country-code form (`+213 0…`, `00213 0…`, `213 0…`), and a
 * bare 9-digit NSN that is exactly a mobile; with any Eastern Arabic/Persian/fullwidth digits,
 * fullwidth `＋`, spaces, dashes, dots, parentheses, and any invisible format character.
 */
export function normalizePhone(input: string): PhoneResult {
  if (input.length > PHONE_INPUT_MAX_LENGTH) return { ok: false, code: 'phone_invalid' };
  const cleaned = toAsciiDigits(input).replace(/＋/g, '+').replace(STRIP_RE, '');
  if (cleaned === '') return { ok: false, code: 'phone_required' };
  if (!/^\+?\d+$/.test(cleaned)) return { ok: false, code: 'phone_invalid' };

  const nsn = extractNsn(cleaned);
  if (nsn === null) return { ok: false, code: 'phone_invalid' };

  if (MOBILE_NSN_RE.test(nsn)) {
    return { ok: true, e164: `+213${nsn}`, national: `0${nsn}` };
  }
  // Well-formed Algerian numbers that are not mobiles: fixed lines, toll-free, premium, VoIP,
  // and 9-digit 5/6/7 numbers outside the allocated mobile ranges (e.g. 050–053).
  if (NON_MOBILE_NSN_RE.test(nsn) || /^[5-7]\d{8}$/.test(nsn)) {
    return { ok: false, code: 'phone_not_mobile' };
  }
  return { ok: false, code: 'phone_invalid' };
}

function extractNsn(digits: string): string | null {
  let rest: string;
  if (digits.startsWith('+')) {
    if (!digits.startsWith('+213')) return null;
    rest = digits.slice(4);
  } else if (digits.startsWith('00213')) {
    rest = digits.slice(5);
  } else if (digits.startsWith('213') && digits.length >= 11 && digits.length <= 13) {
    // 213 + 8/9-digit NSN, or 213 + 0 + 9-digit NSN (same as `+213 0…`).
    rest = digits.slice(3);
  } else if (digits.startsWith('0')) {
    return digits.slice(1);
  } else if (MOBILE_NSN_RE.test(digits)) {
    // Bare NSN with the trunk 0 left out: accepted only when it is exactly a mobile.
    return digits;
  } else {
    return null;
  }
  // `+213 0555…`: drop a redundant trunk prefix after the country code.
  if (rest.startsWith('0') && (rest.length === 9 || rest.length === 10)) rest = rest.slice(1);
  return rest;
}

function toNational(phone: string): string | null {
  const national = phone.startsWith('+213') ? `0${phone.slice(4)}` : phone;
  return /^0\d{9}$/.test(national) ? national : null;
}

/**
 * National display form `0X XX XX XX XX` for a normalised number (E.164 or national).
 * Render it inside `<bdi>` or `dir="ltr"` (CLAUDE.md bidi rule). Returns the input unchanged
 * when it is not a normalised 10-digit Algerian number.
 */
export function formatPhoneDisplay(phone: string): string {
  const n = toNational(phone);
  if (n === null) return phone;
  return `${n.slice(0, 2)} ${n.slice(2, 4)} ${n.slice(4, 6)} ${n.slice(6, 8)} ${n.slice(8, 10)}`;
}

/**
 * International display form `+213 X XX XX XX XX` (e.g. WhatsApp link text).
 * Render it inside `<bdi dir="ltr">`. Returns the input unchanged when it is not normalised.
 */
export function formatPhoneInternational(phone: string): string {
  const n = toNational(phone);
  if (n === null) return phone;
  return `+213 ${n.slice(1, 2)} ${n.slice(2, 4)} ${n.slice(4, 6)} ${n.slice(6, 8)} ${n.slice(8, 10)}`;
}
