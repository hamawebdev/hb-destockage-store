/**
 * Build-time string lookup for the order components (same contract as shell's `t()`:
 * `LayoutProps.strings` = brand/copy/strings.<lang>.json, flat dotted keys).
 * Difference: a key brand has not written yet renders as a visible `[PLACEHOLDER] <key>`
 * (CLAUDE.md placeholder rule) instead of failing a development build. With HB_STRICT_COPY=1
 * (production build) a missing key or a `[PLACEHOLDER]` value throws, exactly like `t()`.
 * Owner: orderform.
 */
import type { StringTable } from '@hb/catalog';

export type Vars = Readonly<Record<string, string | number>>;

/** U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP DIRECTIONAL ISOLATE: a `<bdi dir="ltr">` that survives `textContent`. */
export const ltr = (s: string): string => `⁦${s}⁩`;

export function str(strings: StringTable, key: string, vars?: Vars): string {
  const strict = process.env['HB_STRICT_COPY'] === '1';
  let v = strings[key];
  if (v === undefined) {
    if (strict) throw new Error(`missing UI string "${key}"`);
    v = `[PLACEHOLDER] ${key}`;
  } else if (strict && v.includes('[PLACEHOLDER]')) {
    throw new Error(`UI string "${key}" is a placeholder`);
  }
  return vars ? v.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : v;
}
