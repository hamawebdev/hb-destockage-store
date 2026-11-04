import type { Lang, StringTable } from '@hb/catalog';

/**
 * UI strings come from `brand/copy/strings.<lang>.json` through `layout.strings`.
 * A missing key renders as `⟦key⟧` so QA screenshots show it instead of an empty slot;
 * the template tests fail on any `⟦`.
 */
export function t(strings: StringTable, key: string, vars?: Readonly<Record<string, string | number>>): string {
  const raw = strings[key];
  if (raw === undefined) return `⟦${key}⟧`;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = vars[name];
    return v === undefined ? m : String(v);
  });
}

/**
 * Split a template around one variable so the caller can wrap the value in markup
 * (`<bdi>`, `<span class>`) without building HTML strings.
 * `parts(s, 'product.compareAt', 'price')` → `{ before: 'Au lieu de ', after: '' }`.
 */
export function parts(strings: StringTable, key: string, name: string): { before: string; after: string } {
  const raw = t(strings, key);
  const token = `{${name}}`;
  const i = raw.indexOf(token);
  if (i === -1) return { before: raw, after: '' };
  return { before: raw.slice(0, i), after: raw.slice(i + token.length) };
}

const pluralRules = new Map<Lang, Intl.PluralRules>();

/**
 * Plural string: `<base>.<zero|one|two|few|many|other>` chosen with `Intl.PluralRules`, `{count}`
 * filled with the locale-formatted number (Arabic `.one`/`.two` spell the number out and have
 * no `{count}`). Arabic `zero` is selected by the rules for 0.
 */
export function tp(
  strings: StringTable,
  lang: Lang,
  base: string,
  count: number,
  vars?: Readonly<Record<string, string | number>>,
): string {
  let r = pluralRules.get(lang);
  if (!r) {
    r = new Intl.PluralRules(lang === 'ar' ? 'ar-DZ' : 'fr-DZ');
    pluralRules.set(lang, r);
  }
  const key = `${base}.${r.select(count)}`;
  return t(strings, strings[key] === undefined ? `${base}.other` : key, { ...vars, count: formatInt(lang, count) });
}

const numberFormats = new Map<Lang, Intl.NumberFormat>();

/** Plain integer with the locale's grouping and Western digits (`ar-DZ` / `fr-DZ`). */
export function formatInt(lang: Lang, n: number): string {
  let f = numberFormats.get(lang);
  if (!f) {
    f = new Intl.NumberFormat(lang === 'ar' ? 'ar-DZ' : 'fr-DZ', { maximumFractionDigits: 0 });
    numberFormats.set(lang, f);
  }
  return f.format(n);
}

/** `lang` attribute for a Latin brand name inside the page: needed on Arabic pages only. */
export function latinLang(lang: Lang): 'fr' | undefined {
  return lang === 'ar' ? 'fr' : undefined;
}
