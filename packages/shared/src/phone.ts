/**
 * Algerian mobile phone normalisation and validation.
 *
 * Rule (CLAUDE.md, STACK-REPORT §6): the national significant number (NSN, without the trunk
 * `0`) must match libphonenumber's Algerian mobile pattern. Never `^0[567]\d{8}$`, which
 * accepts unallocated ranges such as 050–053.
 *
 * Source: libphonenumber `resources/PhoneNumberMetadata.xml`, territory DZ, `<mobile>`
 * `<nationalNumberPattern>`. SHARED-2 re-checks the current metadata and pins version/commit here.
 *
 * Runs in Workers, Node and the browser; no dependencies.
 */

/** NSN pattern for Algerian mobiles (9 digits), as a source string for reuse in HTML `pattern`-free contexts. */
export const DZ_MOBILE_NSN_PATTERN = '5(?:4[0-29]|6[0-4])\\d{6}|(?:55|6\\d|7[7-9])\\d{7}';

const MOBILE_NSN_RE = /* @__PURE__ */ new RegExp(`^(?:${DZ_MOBILE_NSN_PATTERN})$`);

export const DZ_COUNTRY_CODE = '213';

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

// Eastern Arabic-Indic (U+0660–0669) and Extended/Persian (U+06F0–06F9) digits.
const NON_ASCII_DIGIT_RE = /[٠-٩۰-۹]/g;
// Separators users type or paste: whitespace (incl. NBSP/NNBSP), ASCII and Unicode dashes, dots,
// parentheses, and bidi/format marks from copy-paste (LRM, RLM, ALM, embeddings, isolates, BOM).
const STRIP_RE = /[\s\-‐-―.()‎‏؜‪-‮⁦-⁩﻿]/g;

/** Converts Eastern Arabic and Persian digits to ASCII; leaves everything else unchanged. */
export function toAsciiDigits(input: string): string {
  return input.replace(NON_ASCII_DIGIT_RE, (d) => {
    const cp = d.charCodeAt(0);
    return String(cp >= 0x06f0 ? cp - 0x06f0 : cp - 0x0660);
  });
}

/**
 * Normalises a user-typed Algerian phone number.
 * Accepts `0XXXXXXXXX`, `+213XXXXXXXXX`, `00213XXXXXXXXX`, `213XXXXXXXXX` (and `+213 0…`),
 * with any Eastern Arabic/Persian digits, spaces, dashes, dots, parentheses or bidi marks.
 */
export function normalizePhone(input: string): PhoneResult {
  const cleaned = toAsciiDigits(input).replace(STRIP_RE, '');
  if (cleaned === '') return { ok: false, code: 'phone_required' };
  if (!/^\+?\d+$/.test(cleaned)) return { ok: false, code: 'phone_invalid' };

  const nsn = extractNsn(cleaned);
  if (nsn === null) return { ok: false, code: 'phone_invalid' };

  if (MOBILE_NSN_RE.test(nsn)) {
    return { ok: true, e164: `+213${nsn}`, national: `0${nsn}` };
  }
  // Well-formed Algerian numbers that are not mobiles: 8-digit fixed lines (2x/3x/4x),
  // and 9-digit 5/6/7 numbers outside the allocated mobile ranges (e.g. 050–053).
  if (/^[1-4]\d{7}$/.test(nsn) || /^[5-7]\d{8}$/.test(nsn)) {
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
  } else if (digits.startsWith('213') && (digits.length === 11 || digits.length === 12)) {
    rest = digits.slice(3);
  } else if (digits.startsWith('0')) {
    return digits.slice(1);
  } else {
    return null;
  }
  // `+213 0555…`: drop a redundant trunk prefix after the country code.
  if (rest.startsWith('0') && (rest.length === 9 || rest.length === 10)) rest = rest.slice(1);
  return rest;
}

/**
 * Display form `0X XX XX XX XX` for a normalised number (E.164 or national).
 * Render it inside `<bdi>` or `dir="ltr"` (CLAUDE.md bidi rule). Returns the input unchanged
 * when it is not a normalised Algerian mobile.
 */
export function formatPhoneDisplay(phone: string): string {
  const national = phone.startsWith('+213') ? `0${phone.slice(4)}` : phone;
  if (!/^0\d{9}$/.test(national)) return phone;
  return `${national.slice(0, 2)} ${national.slice(2, 4)} ${national.slice(4, 6)} ${national.slice(6, 8)} ${national.slice(8, 10)}`;
}
