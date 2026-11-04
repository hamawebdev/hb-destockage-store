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
const dateTimeFormatters = /* @__PURE__ */ new Map<Lang, Intl.DateTimeFormat>();

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

/** Date and 24-hour time in Algeria's time zone (admin lists, order events). */
export function formatDateTime(at: number | Date, lang: Lang): string {
  return cached(dateTimeFormatters, lang, () =>
    new Intl.DateTimeFormat(intlLocale(lang), {
      dateStyle: 'medium',
      timeStyle: 'short',
      hourCycle: 'h23',
      timeZone: DZ_TIME_ZONE,
    }),
  ).format(at);
}
