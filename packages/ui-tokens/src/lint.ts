// Logical-properties lint: lists declarations that only work in one direction.
// Used by this package's tests; other workspaces may import it for their own CSS.

// Side-specific properties. Sizing (width/height) and overflow-x/y are not direction-dependent in
// horizontal writing modes, so they are allowed; inline-size/block-size are still preferred.
const PHYSICAL_PROP =
  /^(left|right|top|bottom|(margin|padding|scroll-margin|scroll-padding)-(left|right|top|bottom)|border-(left|right|top|bottom)(-(width|style|color))?|border-(top|bottom)-(left|right)-radius)$/;
const PHYSICAL_VALUE: Record<string, RegExp> = {
  'text-align': /^(left|right)$/,
  float: /^(left|right)$/,
  clear: /^(left|right)$/,
  'justify-content': /^(left|right)$/,
  'justify-items': /^(left|right)$/,
  'justify-self': /^(left|right)$/,
  resize: /^(horizontal|vertical)$/,
};
/** Shorthands whose 3- or 4-value forms (or 2+ for radius) assign physical sides/corners. */
const SIDE_SHORTHAND = /^(margin|padding|inset|border-width|border-style|border-color|scroll-margin|scroll-padding)$/;

function splitValue(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of v.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Returns `prop: value` for every direction-specific declaration in a stylesheet. */
export function physicalProperties(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: string[] = [];
  // Declarations sit after `{` or `;` and before `;` or `}`. @media/@supports preludes start with `(`
  // or `@`, so `(min-width: 768px)` is never read as a declaration.
  for (const m of src.matchAll(/[{;]\s*(-?[a-z][a-z-]*)\s*:\s*([^;{}]*)/g)) {
    const prop = m[1] as string;
    const value = (m[2] as string).replace(/\s*!important\s*$/, '').trim();
    if (prop.startsWith('--')) continue;
    const parts = splitValue(value);
    if (
      PHYSICAL_PROP.test(prop) ||
      PHYSICAL_VALUE[prop]?.test(value) ||
      (SIDE_SHORTHAND.test(prop) && parts.length > 2) ||
      (prop === 'border-radius' && parts.filter((p) => p !== '/').length > 1)
    ) {
      found.push(`${prop}: ${value}`);
    }
  }
  return found;
}
