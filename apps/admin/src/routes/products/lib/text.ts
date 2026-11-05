/**
 * Text clean-up for every catalogue/content text field (ACAT-0 plan §2).
 * Normalises (NFC, CRLF → LF, tabs → spaces in multi-line text, trim), then applies CAT-1's text
 * safety rule from `@hb/catalog` (imported, not copied): no C0/C1 control characters and no bidi
 * embedding/override/isolate controls; newlines only in multi-line fields. The admin therefore
 * accepts exactly what `validateSnapshot` accepts at publish. Pure, no I/O.
 */
import { isSafeLine, isSafeMultiline } from '@hb/catalog';

export type TextError = 'unsafe_char';

export type TextResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: TextError };

export function cleanText(input: string, opts: { readonly multiline?: boolean } = {}): TextResult {
  const multiline = opts.multiline === true;
  let s = input.normalize('NFC').replace(/\r\n?/g, '\n');
  if (multiline) s = s.replace(/\t/g, ' ');
  s = s.trim();
  const safe = multiline ? isSafeMultiline(s) : isSafeLine(s);
  return safe ? { ok: true, value: s } : { ok: false, error: 'unsafe_char' };
}
