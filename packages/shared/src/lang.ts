/**
 * Languages of the storefront and admin. Arabic is primary (`/ar/`, RTL), French secondary.
 * No i18n runtime: pages are built per language; this module only carries the types and the
 * few helpers every workspace needs.
 */

export const LANGS = ['ar', 'fr'] as const;
export type Lang = (typeof LANGS)[number];

/** `x-default` hreflang and the language of `/`. */
export const DEFAULT_LANG: Lang = 'ar';

export type Dir = 'rtl' | 'ltr';

/** BCP 47 locale passed to `Intl` for each language (STACK-REPORT §5). */
export type IntlLocale = 'ar-DZ' | 'fr-DZ';

/** A value given in both languages. Every content field is bilingual (CLAUDE.md). */
export type Localized<T = string> = { readonly ar: T; readonly fr: T };

export function isLang(value: unknown): value is Lang {
  return value === 'ar' || value === 'fr';
}

export function dirOf(lang: Lang): Dir {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

export function intlLocale(lang: Lang): IntlLocale {
  return lang === 'ar' ? 'ar-DZ' : 'fr-DZ';
}

export function pick<T>(value: Localized<T>, lang: Lang): T {
  return value[lang];
}

/**
 * Builds a `Localized<T>` from a DB row that stores `<key>_ar` / `<key>_fr` columns.
 * `localizedFromRow({ name_ar: 'أ', name_fr: 'a' }, 'name')` → `{ ar: 'أ', fr: 'a' }`.
 */
export function localizedFromRow<K extends string, T>(
  row: { readonly [P in `${K}_ar` | `${K}_fr`]: T },
  key: K,
): Localized<T> {
  return { ar: row[`${key}_ar`], fr: row[`${key}_fr`] };
}
