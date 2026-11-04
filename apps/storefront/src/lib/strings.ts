/**
 * Build-time UI strings. The table is LayoutProps.strings (brand/copy/strings.<lang>.json via
 * CAT-3); nothing reaches the client. A missing key fails the build; with HB_STRICT_COPY=1 (the
 * production build) so does a value still marked [PLACEHOLDER]. Owner: shell.
 */
import type { StringTable } from '@hb/catalog';

export function t(strings: StringTable, key: string): string {
  const v = strings[key];
  if (v === undefined) throw new Error(`missing UI string "${key}"`);
  if (process.env['HB_STRICT_COPY'] === '1' && v.includes('[PLACEHOLDER]')) throw new Error(`UI string "${key}" is a placeholder`);
  return v;
}
