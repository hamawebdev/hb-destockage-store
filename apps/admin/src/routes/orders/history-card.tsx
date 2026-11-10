// UX-7 — the customer card's history block, shared by the order page and the call queue.
// Shown only to roles with `customers.sensitive` (the caller passes `risk`, which is null otherwise).
import type { Lang } from '../../i18n/index.ts';
import { StatusBadge } from '../../ui/badge.tsx';
import { Bdi, DateTime, Money, Num } from '../../ui/format.tsx';
import { Icon } from '../../ui/icons.tsx';
import type { OrderRisk } from './detail-data.ts';
import { deliveryRate, returnerLevel, type CustomerHistory } from './history.ts';
import { orderStatusLabel, orderStatusTone, type OrdersMessages } from './messages.ts';

type Counts = Pick<OrderRisk, 'orderCount' | 'deliveredCount' | 'returnedCount' | 'cancelledCount'>;

/** The warning shown at the top of the order when this phone returns parcels often. */
export function ReturnerBadge(props: { tm: OrdersMessages; risk: Counts | null }) {
  if (!props.risk || returnerLevel(props.risk.deliveredCount, props.risk.returnedCount) !== 'frequent') return null;
  return <StatusBadge tone="danger" label={props.tm('history.badge')} />;
}

export function HistoryBlock(props: { tm: OrdersMessages; lang: Lang; risk: Counts; history: CustomerHistory | undefined; customerId: number }) {
  const { tm, lang, risk } = props;
  const level = returnerLevel(risk.deliveredCount, risk.returnedCount);
  const rate = deliveryRate(risk.deliveredCount, risk.returnedCount);
  const rows = props.history?.rows ?? [];
  return (
    <div class="history">
      {level === 'frequent' ? (
        <div class="callout callout--danger history__warn" role="note">
          <p class="history__warn-title">
            <Icon name="alert" class="ico--sm" />
            <strong>{tm('history.frequent.title')}</strong>
          </p>
          <p>{tm('history.frequent.body', { returned: risk.returnedCount, delivered: risk.deliveredCount })}</p>
        </div>
      ) : level === 'some' ? (
        <div class="callout callout--warning history__warn" role="note">
          <p>{tm('history.some', { returned: risk.returnedCount })}</p>
        </div>
      ) : null}
      <dl class="history__counts">
        <div>
          <dt>{tm('history.orders')}</dt>
          <dd><Num value={risk.orderCount} /></dd>
        </div>
        <div>
          <dt>{tm('history.delivered')}</dt>
          <dd><Num value={risk.deliveredCount} /></dd>
        </div>
        <div class={risk.returnedCount > 0 ? 'history__count--bad' : undefined}>
          <dt>{tm('history.returned')}</dt>
          <dd><Num value={risk.returnedCount} /></dd>
        </div>
        <div>
          <dt>{tm('history.cancelled')}</dt>
          <dd><Num value={risk.cancelledCount} /></dd>
        </div>
      </dl>
      {rate !== null ? <p class="muted history__rate">{tm('history.rate', { rate })}</p> : null}
      {rows.length === 0 ? (
        <p class="muted">{tm('history.first')}</p>
      ) : (
        <>
          <h3 class="history__subtitle">{tm('history.list')}</h3>
          <ul class="history__list">
            {rows.map((o) => (
              <li class="history__item">
                <a class="history__ref" href={`/orders/${o.ref}`}><Bdi>{o.ref}</Bdi></a>
                <StatusBadge tone={orderStatusTone(o.status)} label={orderStatusLabel(lang, o.status)} />
                <span class="history__meta">
                  <DateTime ms={o.createdAt} withTime={false} /> · <Money dzd={o.totalDzd} />
                  {o.courierName ? <> · <span dir="auto">{o.courierName}</span></> : null}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <a class="btn btn--secondary" href={`/customers/${props.customerId}`}>
        {props.history?.more ? tm('history.more') : tm('detail.customerLink')}
      </a>
    </div>
  );
}
