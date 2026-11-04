/** Eastern-Arabic (U+0660–0669) and Persian (U+06F0–06F9) digits → ASCII. */
export function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => String((d.codePointAt(0)! & 0xf) % 10));
}
