// AORD-3 — call queue page (confirmer view). One order at a time; everything needed for the call on
// one screen; keyboard order = reading order: the phone link first, then the outcome buttons
// (no access keys: they clash with screen readers). Actions are AORD-2's: claim, call, release.
import { formatPhoneDisplay } from '@hb/shared';
import type { CurrentUser } from '../../env.ts';
import type { Lang } from '../../i18n/index.ts';
import { EmptyState, StatusBadge } from '../../ui/badge.tsx';
import { Form, Submit } from '../../ui/form.tsx';
import { Bdi, DateTime, Money } from '../../ui/format.tsx';
import { Icon } from '../../ui/icons.tsx';
import { Card } from '../../ui/kit.tsx';
import type { OrderDetail, OrderEventRow, OrderItemRow } from './detail-data.ts';
import { CallForm, ClaimButtons } from './detail-page.tsx';
import { flagLabel } from './list-page.tsx';
import { m, orderFlagTone, orderStatusLabel, orderStatusTone, type OrdersMessages } from './messages.ts';
import type { QueueBucket } from './queue.ts';
import { HistoryBlock, ReturnerBadge } from './history-card.tsx';
import type { CustomerHistory } from './history.ts';

export function QueueEmptyPage(props: { lang: Lang; counts: Record<QueueBucket, number>; nothingFree?: boolean }) {
  const tm = m(props.lang);
  const total = props.counts.due + props.counts.new + props.counts.unreachable;
  return (
    <>
      {props.nothingFree ? <p class="flash flash--danger" role="alert">{tm('queue.nothingFree')}</p> : null}
      <div class="queue-start">
        <ul class="queue-counts">
          <li>{tm('queue.count.due', { count: props.counts.due })}</li>
          <li>{tm('queue.count.new', { count: props.counts.new })}</li>
          <li>{tm('queue.count.unreachable', { count: props.counts.unreachable })}</li>
        </ul>
        {total === 0 ? (
          <EmptyState icon="phone">{tm('queue.empty')}</EmptyState>
        ) : (
          <Form action="/orders/queue/next" class="queue-start__action">
            <Submit>{tm('queue.next')}</Submit>
          </Form>
        )}
      </div>
    </>
  );
}

function LastCalls(props: { tm: OrdersMessages; events: readonly OrderEventRow[] }) {
  const calls = props.events.filter((e) => e.type === 'call_attempt').slice(-3).reverse();
  if (calls.length === 0) return null;
  return (
    <Card title={props.tm('queue.lastCalls')}>
      <ul class="plain-list">
        {calls.map((e) => (
          <li>
            <DateTime ms={e.at} /> · {props.tm(`outcome.${e.outcome}` as Parameters<OrdersMessages>[0])}
            {e.note ? <> · <span dir="auto">{e.note}</span></> : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function QueueCallPage(props: {
  lang: Lang;
  user: CurrentUser;
  now: number;
  order: OrderDetail;
  items: readonly OrderItemRow[];
  events: readonly OrderEventRow[];
  history?: CustomerHistory;
}) {
  const tm = m(props.lang);
  const { order, lang } = props;
  const name = (fr: string, ar: string) => (lang === 'ar' ? ar : fr);
  // The queue is for callers (owner, confirmer), who always receive the risk fields.
  const risk = order.risk ?? { callAttempts: 0, nextCallAt: null, flags: [], customerBlocked: false };
  const detail = { lang, user: props.user, now: props.now, order, items: props.items, events: props.events, audit: [] };
  return (
    <>
      {risk.customerBlocked ? <p class="flash flash--danger" role="alert">{tm('detail.blocked')}</p> : null}
      <div class="order-head">
        <div class="order-head__who">
          <p class="order-head__name"><Bdi ltr={false}>{order.name}</Bdi></p>
          <p class="order-head__meta"><Bdi>{order.ref}</Bdi> · <Bdi>{formatPhoneDisplay(order.phoneE164)}</Bdi></p>
        </div>
        <div class="order-head__status">
          <StatusBadge tone={orderStatusTone(order.status)} label={orderStatusLabel(lang, order.status)} />
          <ReturnerBadge tm={tm} risk={order.risk} />
          {risk.callAttempts > 0 ? <span class="muted">{tm('status.attempt', { n: risk.callAttempts })}</span> : null}
          {risk.nextCallAt !== null && order.status === 'called' ? (
            <span class="muted">{tm('queue.callbackAt')} <DateTime ms={risk.nextCallAt} /></span>
          ) : null}
        </div>
        <a class="btn btn--primary order-head__call" href={`tel:${order.phoneE164}`}>
          <Icon name="phone" />
          {tm('detail.call')}
        </a>
      </div>
      <div class="order-grid">
        <div class="order-main">
          <CallForm {...detail} tm={tm} returnTo="queue" />
          <ClaimButtons {...detail} tm={tm} claimActive returnTo="queue" />
        </div>
        <div class="order-rail">
          <Card title={tm('detail.items')}>
            <ul class="plain-list">
              {props.items.map((i) => (
                <li>
                  {name(i.nameFr, i.nameAr)}
                  {(lang === 'ar' ? i.variantLabelAr : i.variantLabelFr) ? <> — {lang === 'ar' ? i.variantLabelAr : i.variantLabelFr}</> : null} × {i.qty}{' '}
                  <span class="cell-sub"><Bdi>{i.sku}</Bdi></span>
                </li>
              ))}
            </ul>
            <p class="queue-total">
              {tm('detail.total')} <strong><Money dzd={order.totalDzd} /></strong>
              <span class="cell-sub">{tm('detail.fee')} <Money dzd={order.feeDzd} /></span>
            </p>
          </Card>
          {order.risk ? (
            <Card title={tm('history.title')}>
              <HistoryBlock tm={tm} lang={lang} risk={order.risk} history={props.history} customerId={order.customer.id} />
            </Card>
          ) : null}
          <Card title={tm('detail.delivery')}>
            <p>
              {String(order.wilayaCode).padStart(2, '0')} — {name(order.wilayaFr, order.wilayaAr)} / {name(order.communeFr, order.communeAr)}
            </p>
            {order.address ? <p dir="auto">{order.address}</p> : null}
          </Card>
          {risk.flags.length > 0 ? (
            <Card title={tm('detail.flags')}>
              <ul class="flag-list">
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
            </Card>
          ) : null}
          <LastCalls tm={tm} events={props.events} />
          <p>
            <a href={`/orders/${order.ref}`}>{tm('queue.openOrder')}</a>
          </p>
        </div>
      </div>
    </>
  );
}
