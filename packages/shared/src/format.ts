/**
 * `Intl` formatters for `ar-DZ` and `fr-DZ` (STACK-REPORT §5). No i18n runtime.
 * Formatters are created lazily on first use and cached per language; importing this module has
 * no side effects.
 *
 * Node 24 (ICU 77.1, CLDR 47) output:
 *   formatPrice(189000, 'ar') → '‏189.000 د.ج.‏'   (RLM-wrapped, Western digits)
 *   formatPrice(189000, 'fr') → '189 000 DA'
 *   formatDate(…15 Jan 2026…, 'ar') → '15 جانفي 2026'
 * SHARED-5 pins these against the Workers runtime as well.
 */

import { intlLocale, type Lang } from './lang.ts';
import type { Dzd } from './money.ts';

/** Algeria's time zone; dates are shown in local time wherever the code runs (Worker = UTC). */
export const DZ_TIME_ZONE = 'Africa/Algiers';

const priceFormatters = /* @__PURE__ */ new Map<Lang, Intl.NumberFormat>();
const numberFormatters = /* @__PURE__ */ new Map<Lang, Intl.NumberFormat>();
const dateFormatters = /* @__PURE__ */ new Map<Lang, Intl.DateTimeFormat>();
const mediumDateFormatters = /* @__PURE__ */ new Map<Lang, Intl.DateTimeFormat>();
const timeFormatters = /* @__PURE__ */ new Map<Lang, Intl.DateTimeFormat>();

/**
 * Separator between date and time in `formatDateTime`. Fixed here rather than taken from CLDR's
 * dateTime pattern, which differs between runtimes: for ar-DZ, Node 24 / workerd (ICU 77) put
 * "، " and Chrome 143 puts " " (artifacts/SHARED-5/chrome.json). The date and time parts
 * themselves are identical everywhere.
 */
const DATE_TIME_SEPARATOR: { readonly [L in Lang]: string } = { ar: '\u060C ', fr: ', ' };

function cached<F>(map: Map<Lang, F>, lang: Lang, make: () => F): F {
  let f = map.get(lang);
  if (f === undefined) {
    f = make();
    map.set(lang, f);
  }
  return f;
}

/** Integer DZD with currency, e.g. `189.000 د.ج.` (ar) / `189 000 DA` (fr). */
export function formatPrice(dzd: Dzd, lang: Lang): string {
  return cached(priceFormatters, lang, () =>
    new Intl.NumberFormat(intlLocale(lang), {
      style: 'currency',
      currency: 'DZD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }),
  ).format(dzd);
}

/** Plain grouped integer, e.g. quantities and counts. */
export function formatNumber(value: number, lang: Lang): string {
  return cached(numberFormatters, lang, () =>
    new Intl.NumberFormat(intlLocale(lang), { maximumFractionDigits: 0 }),
  ).format(value);
}

/** Long date in Algeria's time zone, e.g. `15 جانفي 2026` / `15 janvier 2026`. */
export function formatDate(at: number | Date, lang: Lang): string {
  return cached(dateFormatters, lang, () =>
    new Intl.DateTimeFormat(intlLocale(lang), { dateStyle: 'long', timeZone: DZ_TIME_ZONE }),
  ).format(at);
}

/**
 * Medium date and 24-hour time in Algeria's time zone (admin lists, order events), e.g.
 * `15‏/07‏/2026، 13:00` / `15 juil. 2026, 13:00`. Same string in Node, workerd and browsers.
 */
export function formatDateTime(at: number | Date, lang: Lang): string {
  const date = cached(mediumDateFormatters, lang, () =>
    new Intl.DateTimeFormat(intlLocale(lang), { dateStyle: 'medium', timeZone: DZ_TIME_ZONE }),
  ).format(at);
  const time = cached(timeFormatters, lang, () =>
    new Intl.DateTimeFormat(intlLocale(lang), { timeStyle: 'short', hourCycle: 'h23', timeZone: DZ_TIME_ZONE }),
  ).format(at);
  return `${date}${DATE_TIME_SEPARATOR[lang]}${time}`;
}
