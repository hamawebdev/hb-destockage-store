/**
 * Build-time UI strings. The table is LayoutProps.strings (brand/copy/strings.<lang>.json via
 * CAT-3); nothing reaches the client. A missing key fails the build; with HB_STRICT_COPY=1 (the
 * production build) so does a rendered value still marked [PLACEHOLDER]. `{name}` placeholders are
 * filled from `vars`; a missing var fails the build. Owner: shell.
 */
import type { StringTable } from '@hb/catalog';

export function t(strings: StringTable, key: string, vars: Readonly<Record<string, string | number>> = {}): string {
  const v = strings[key];
  if (v === undefined) throw new Error(`missing UI string "${key}"`);
  if (process.env['HB_STRICT_COPY'] === '1' && v.includes('[PLACEHOLDER]')) throw new Error(`UI string "${key}" is a placeholder`);
  return v.replace(/\{(\w+)\}/g, (_, name: string) => {
    const x = vars[name];
    if (x === undefined) throw new Error(`UI string "${key}" needs {${name}}`);
    return String(x);
  });
}

/** National mobile number for display: 0560417403 → "0560 41 74 03". Render inside <bdi dir="ltr">. */
export const groupPhone = (national: string): string => national.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4');
