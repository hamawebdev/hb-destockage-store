// AORD-3 — call queue page (confirmer view). One order at a time; everything needed for the call on
// one screen; keyboard order = reading order: the phone link first, then the outcome buttons
// (no access keys: they clash with screen readers). Actions are AORD-2's: claim, call, release.
import { formatPhoneDisplay } from '@hb/shared';
import type { CurrentUser } from '../../env.ts';
import type { Lang } from '../../i18n/index.ts';
import { StatusBadge } from '../../ui/badge.tsx';
import { Form, FormActions, Submit } from '../../ui/form.tsx';
import { Bdi, DateTime, Money } from '../../ui/format.tsx';
import type { OrderDetail, OrderEventRow, OrderItemRow } from './detail-data.ts';
import { CallForm, ClaimButtons } from './detail-page.tsx';
import { flagLabel } from './list-page.tsx';
import { m, orderFlagTone, orderStatusLabel, orderStatusTone, type OrdersMessages } from './messages.ts';
import type { QueueBucket } from './queue.ts';

export function QueueEmptyPage(props: { lang: Lang; counts: Record<QueueBucket, number>; nothingFree?: boolean }) {
  const tm = m(props.lang);
  const total = props.counts.due + props.counts.new + props.counts.unreachable;
  return (
    <>
      <ul>
        <li>{tm('queue.count.due', { count: props.counts.due })}</li>
        <li>{tm('queue.count.new', { count: props.counts.new })}</li>
        <li>{tm('queue.count.unreachable', { count: props.counts.unreachable })}</li>
      </ul>
      {props.nothingFree ? <p class="flash flash--danger" role="alert">{tm('queue.nothingFree')}</p> : null}
      {total === 0 ? (
        <p class="empty">{tm('queue.empty')}</p>
      ) : (
        <Form action="/orders/queue/next">
          <FormActions>
            <Submit>{tm('queue.next')}</Submit>
          </FormActions>
        </Form>
      )}
    </>
  );
}

function LastCalls(props: { tm: OrdersMessages; events: readonly OrderEventRow[] }) {
  const calls = props.events.filter((e) => e.type === 'call_attempt').slice(-3).reverse();
  if (calls.length === 0) return null;
  return (
    <>
      <h3>{props.tm('queue.lastCalls')}</h3>
      <ul>
        {calls.map((e) => (
          <li>
            <DateTime ms={e.at} /> · {props.tm(`outcome.${e.outcome}` as Parameters<OrdersMessages>[0])}
            {e.note ? <> · <span dir="auto">{e.note}</span></> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

export function QueueCallPage(props: {
  lang: Lang;
  user: CurrentUser;
  now: number;
  order: OrderDetail;
  items: readonly OrderItemRow[];
  events: readonly OrderEventRow[];
}) {
  const tm = m(props.lang);
  const { order, lang } = props;
  const name = (fr: string, ar: string) => (lang === 'ar' ? ar : fr);
  // The queue is for callers (owner, confirmer), who always receive the risk fields.
  const risk = order.risk ?? { callAttempts: 0, nextCallAt: null, flags: [], customerBlocked: false };
  const detail = { lang, user: props.user, now: props.now, order, items: props.items, events: props.events, audit: [] };
  return (
    <>
      <p>
        <a class="btn btn--primary" href={`tel:${order.phoneE164}`}>
          {tm('detail.call')} <Bdi>{formatPhoneDisplay(order.phoneE164)}</Bdi>
        </a>
      </p>
      {risk.customerBlocked ? <p class="flash flash--danger" role="alert">{tm('detail.blocked')}</p> : null}
      <p>
        <Bdi>{order.ref}</Bdi> · <Bdi ltr={false}>{order.name}</Bdi> ·{' '}
        <StatusBadge tone={orderStatusTone(order.status)} label={orderStatusLabel(lang, order.status)} />{' '}
        {risk.callAttempts > 0 ? <span class="muted">{tm('status.attempt', { n: risk.callAttempts })}</span> : null}
      </p>
      {risk.nextCallAt !== null && order.status === 'called' ? (
        <p>
          {tm('queue.callbackAt')} <DateTime ms={risk.nextCallAt} />
        </p>
      ) : null}
      <p>
        {String(order.wilayaCode).padStart(2, '0')} — {name(order.wilayaFr, order.wilayaAr)} / {name(order.communeFr, order.communeAr)}
        {order.address ? <> · <span dir="auto">{order.address}</span></> : null}
      </p>
      <ul>
        {props.items.map((i) => (
          <li>
            {name(i.nameFr, i.nameAr)}
            {(lang === 'ar' ? i.variantLabelAr : i.variantLabelFr) ? <> — {lang === 'ar' ? i.variantLabelAr : i.variantLabelFr}</> : null} × {i.qty}{' '}
            <Bdi>{i.sku}</Bdi>
          </li>
        ))}
      </ul>
      <p>
        {tm('detail.total')} : <strong><Money dzd={order.totalDzd} /></strong> <span class="muted">({tm('detail.fee')} <Money dzd={order.feeDzd} />)</span>
      </p>
      {risk.flags.length > 0 ? (
        <ul>
          {risk.flags.map((f) => {
            const help = tm(`flagHelp.${f}` as Parameters<OrdersMessages>[0]);
            return (
              <li>
                <StatusBadge tone={orderFlagTone(f)} label={flagLabel(tm, f)} />
                {help !== `flagHelp.${f}` ? <> {help}</> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <LastCalls tm={tm} events={props.events} />
      <CallForm {...detail} tm={tm} returnTo="queue" />
      <ClaimButtons {...detail} tm={tm} claimActive returnTo="queue" />
      <p>
        <a href={`/orders/${order.ref}`}>{tm('queue.openOrder')}</a>
      </p>
    </>
  );
}
