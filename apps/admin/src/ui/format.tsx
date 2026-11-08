// Display helpers: thin wrappers over @hb/shared format.ts (one formatting rule for the store and
// the admin). Money is integer DZD; dates are Africa/Algiers with a 24-hour clock; Latin digits.
import type { Child } from 'hono/jsx';
import { formatDate, formatDateTime as sharedDateTime, formatNumber as sharedNumber, formatPrice } from '@hb/shared';
import type { Lang } from '../i18n/index.ts';
import { useUi } from './context.ts';

export const formatMoney = (lang: Lang, dzd: number): string => formatPrice(dzd, lang);
export const formatNumber = (lang: Lang, n: number): string => sharedNumber(n, lang);
export const formatDateTime = (lang: Lang, ms: number, withTime = true): string => (withTime ? sharedDateTime(ms, lang) : formatDate(ms, lang));

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
