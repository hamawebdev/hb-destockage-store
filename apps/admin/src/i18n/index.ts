// Admin i18n: two static dictionaries, no runtime library.
//
//   const t = translator('ar');           // chrome strings (fr.ts / ar.ts)
//   t('nav.orders')                       // → «الطلبات»
//   t('form.tooLong', { max: 120 })
//
// Feature strings stay in the feature's folder (owned by its builder):
//
//   // routes/orders/messages.ts
//   export const m = defineMessages({
//     fr: { 'list.title': 'Commandes' },
//     ar: { 'list.title': 'الطلبات' },
//   });
//   // in a handler: const tm = m(c.var.lang); tm('list.title')
//
// Message syntax: `{name}` interpolation and `{count, plural, one {…} other {…}}` with `#` for the
// number (Intl.PluralRules categories). Values are inserted as text; escaping happens in JSX.

import { ar } from './ar.ts';
import { fr } from './fr.ts';

export const LANGS = ['fr', 'ar'] as const;
export type Lang = (typeof LANGS)[number];

export const DEFAULT_LANG: Lang = 'fr';

export function isLang(x: unknown): x is Lang {
  return x === 'fr' || x === 'ar';
}

export function dirOf(lang: Lang): 'ltr' | 'rtl' {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

/** Intl locale for a UI language (Latin digits in both: `ar-DZ` uses `latn`). */
export function localeOf(lang: Lang): 'fr-DZ' | 'ar-DZ' {
  return lang === 'ar' ? 'ar-DZ' : 'fr-DZ';
}

export type MessageKey = keyof typeof fr;
/** Shape every language must satisfy: same keys as French, string values. */
export type Dict = { readonly [K in MessageKey]: string };

export type Params = Readonly<Record<string, string | number>>;
export type Translator<K extends string = MessageKey> = (key: K, params?: Params) => string;

const DICTS: Readonly<Record<Lang, Dict>> = { fr, ar };

const pluralRules = new Map<Lang, Intl.PluralRules>();
function plural(lang: Lang, n: number): Intl.LDMLPluralRule {
  let r = pluralRules.get(lang);
  if (!r) {
    r = new Intl.PluralRules(localeOf(lang));
    pluralRules.set(lang, r);
  }
  return r.select(n);
}

const PLURAL_RE = /\{(\w+), plural,((?:\s*(?:=\d+|zero|one|two|few|many|other)\s*\{[^{}]*\})+)\s*\}/g;
const BRANCH_RE = /(=\d+|zero|one|two|few|many|other)\s*\{([^{}]*)\}/g;
const VAR_RE = /\{(\w+)\}/g;

/** Formats one message. Exported for tests. */
export function format(lang: Lang, message: string, params: Params = {}): string {
  const nf = new Intl.NumberFormat(localeOf(lang));
  const withPlurals = message.replace(PLURAL_RE, (_all, name: string, body: string) => {
    const raw = params[name];
    const n = typeof raw === 'number' ? raw : Number(raw);
    const branches = new Map<string, string>();
    for (const m of body.matchAll(BRANCH_RE)) branches.set(m[1]!, m[2]!);
    const text = branches.get(`=${n}`) ?? branches.get(plural(lang, n)) ?? branches.get('other') ?? '';
    return text.replaceAll('#', nf.format(n));
  });
  return withPlurals.replace(VAR_RE, (all, name: string) => {
    const val = params[name];
    if (val === undefined) return all;
    return typeof val === 'number' ? nf.format(val) : val;
  });
}

/** Translator for the admin chrome dictionary. */
export function translator(lang: Lang): Translator {
  const dict = DICTS[lang];
  return (key, params) => format(lang, dict[key], params);
}

/**
 * Feature dictionaries. The type forces `ar` to have exactly the keys of `fr`:
 * a missing or extra key is a compile error.
 */
export function defineMessages<
  const F extends Readonly<Record<string, string>>,
  const A extends { readonly [K in keyof F]: string },
>(dicts: {
  fr: F;
  ar: A & { readonly [K in Exclude<keyof A, keyof F>]: never };
}): (lang: Lang) => Translator<Extract<keyof F, string>> {
  return (lang) => {
    const dict = (lang === 'ar' ? dicts.ar : dicts.fr) as Readonly<Record<string, string>>;
    return (key, params) => format(lang, dict[key] ?? key, params);
  };
}
