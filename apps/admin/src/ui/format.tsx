// Display helpers. Money is integer DZD; dates are Africa/Algiers. Latin digits in both languages.
// (Will delegate to `@hb/shared` format.ts once SHARED-1 lands; the component API stays.)
import type { Child } from 'hono/jsx';
import { localeOf, type Lang } from '../i18n/index.ts';
import { ALGIERS_TZ } from '../lib/time.ts';
import { useUi } from './context.ts';

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
function nf(lang: Lang, kind: 'money' | 'num'): Intl.NumberFormat {
  const k = `${lang}:${kind}`;
  let f = cache.get(k) as Intl.NumberFormat | undefined;
  if (!f) {
    f = new Intl.NumberFormat(localeOf(lang), kind === 'money'
      ? { style: 'currency', currency: 'DZD', minimumFractionDigits: 0, maximumFractionDigits: 0 }
      : { maximumFractionDigits: 0 });
    cache.set(k, f);
  }
  return f;
}
function df(lang: Lang, withTime: boolean): Intl.DateTimeFormat {
  const k = `${lang}:date:${withTime}`;
  let f = cache.get(k) as Intl.DateTimeFormat | undefined;
  if (!f) {
    f = new Intl.DateTimeFormat(localeOf(lang), withTime
      ? { dateStyle: 'short', timeStyle: 'short', timeZone: ALGIERS_TZ }
      : { dateStyle: 'medium', timeZone: ALGIERS_TZ });
    cache.set(k, f);
  }
  return f;
}

export const formatMoney = (lang: Lang, dzd: number): string => nf(lang, 'money').format(dzd);
export const formatNumber = (lang: Lang, n: number): string => nf(lang, 'num').format(n);
export const formatDateTime = (lang: Lang, ms: number, withTime = true): string => df(lang, withTime).format(ms);

/** Isolates LTR tokens (phones, refs, SKUs, emails, Latin names) inside RTL text. */
export function Bdi(props: { children: Child; ltr?: boolean }) {
  return props.ltr === false ? <bdi>{props.children}</bdi> : <bdi dir="ltr">{props.children}</bdi>;
}

/** SKUs, order refs and other codes: LTR-isolated and never wrapped at hyphens. */
export function Code(props: { children: Child }) {
  return <bdi dir="ltr" class="code">{props.children}</bdi>;
}

export function Money(props: { dzd: number }) {
  const { lang } = useUi();
  return <span class="num">{formatMoney(lang, props.dzd)}</span>;
}

export function Num(props: { value: number }) {
  const { lang } = useUi();
  return <span class="num">{formatNumber(lang, props.value)}</span>;
}

export function DateTime(props: { ms: number; withTime?: boolean }) {
  const { lang } = useUi();
  return <time datetime={new Date(props.ms).toISOString()}>{formatDateTime(lang, props.ms, props.withTime ?? true)}</time>;
}
