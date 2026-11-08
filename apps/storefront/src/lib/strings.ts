/**
 * Build-time UI strings. The table is LayoutProps.strings (brand/copy/strings.<lang>.json via
 * CAT-3); nothing reaches the client. A missing key fails the build; with HB_STRICT_COPY=1 (the
 * production build) so does a rendered value still marked [PLACEHOLDER]. Without `vars` the raw
 * template is returned (pages' catalog i18n wraps this as its lookup and fills `{count}` itself);
 * with `vars`, every `{name}` is filled and a missing one fails the build. Owner: shell.
 */
import type { StringTable } from '@hb/catalog';

/** `[PLACEHOLDER]` or `[PLACEHOLDER: note]` / `[PLACEHOLDER : note]` (brand/copy and data/content). */
export const PLACEHOLDER_RE = /\[PLACEHOLDER\b/;

/** Split a text into plain parts and placeholder markers (with their optional note). */
export function placeholderParts(text: string): ({ text: string } | { note: string | null })[] {
  const out: ({ text: string } | { note: string | null })[] = [];
  let last = 0;
  for (const m of text.matchAll(/\s*\[PLACEHOLDER\s*(?::\s*([^\]]*?))?\s*\]\s*/g)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ note: m[1] ? m[1] : null });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function t(strings: StringTable, key: string, vars?: Readonly<Record<string, string | number>>): string {
  const v = strings[key];
  if (v === undefined) throw new Error(`missing UI string "${key}"`);
  if (process.env['HB_STRICT_COPY'] === '1' && PLACEHOLDER_RE.test(v)) throw new Error(`UI string "${key}" is a placeholder`);
  if (vars === undefined) return v;
  return v.replace(/\{(\w+)\}/g, (_, name: string) => {
    const x = vars[name];
    if (x === undefined) throw new Error(`UI string "${key}" needs {${name}}`);
    return String(x);
  });
}

/** National mobile number for display: 0560417403 → "0560 41 74 03". Render inside <bdi dir="ltr">. */
export const groupPhone = (national: string): string => national.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4');
