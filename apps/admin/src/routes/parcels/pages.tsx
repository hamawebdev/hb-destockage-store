// UX-8 delayed parcels and UX-10 delivery success rate: server-rendered, no JS.
import type { Child } from 'hono/jsx';
import { formatPhoneDisplay } from '@hb/shared';
import type { Lang } from '../../i18n/index.ts';
import { EmptyState, StatusBadge, type Tone } from '../../ui/badge.tsx';
import { Form } from '../../ui/form.tsx';
import { Bdi, DateTime, Num } from '../../ui/format.tsx';
import { FilterChip, Stats, Tabs } from '../../ui/kit.tsx';
import { Table, type Column } from '../../ui/table.tsx';
import {
  DELAY_CHOICES,
  DELAYED_PAGE_SIZE,
  MIN_SAMPLE,
  PERIODS,
  courierName,
  successRate,
  totals,
  type DelayedRow,
  type Period,
  type RateRow,
} from './data.ts';
import { pm, type ParcelsMessages } from './messages.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
export const daysSince = (now: number, at: number) => Math.max(0, Math.floor((now - at) / DAY_MS));

const CS_TONE: Record<string, Tone> = { pending: 'neutral', in_transit: 'info', returning: 'warning', exception: 'danger', unknown: 'danger' };

function CourierStatus(props: { tm: ParcelsMessages; status: string | null; raw: string | null }) {
  const key = props.status ?? 'none';
  const label = props.tm(`cs.${key}` as Parameters<ParcelsMessages>[0]);
  return (
    <>
      <StatusBadge tone={CS_TONE[key] ?? 'neutral'} label={label.startsWith('cs.') ? key : label} />
      {props.raw ? <span class="cell-sub" dir="auto">{props.raw}</span> : null}
    </>
  );
}

function Radio(props: { id: string; name: string; value: string; checked: boolean; children: Child }) {
  return (
    <div class="field field--check">
      <input type="radio" class="check" id={props.id} name={props.name} value={props.value} checked={props.checked} />
      <label for={props.id}>{props.children}</label>
    </div>
  );
}

export function DelayedPage(props: {
  lang: Lang;
  now: number;
  days: number;
  defaultDays: number;
  courier: string | null;
  couriers: readonly string[];
  rows: readonly DelayedRow[];
  total: number;
  /** `delivery.settings`: the empty state links to the courier settings. */
  canConfigure?: boolean;
}) {
  const tm = pm(props.lang);
  const { lang, now, days } = props;
  const choices = [...new Set([...DELAY_CHOICES, props.defaultDays, days])].sort((a, b) => a - b);
  const filtered = days !== props.defaultDays || props.courier !== null;
  const oldest = props.rows[0];
  return (
    <>
      <p class="page-lead">{tm('delayed.lead', { days })}</p>
      <Form action="/parcels/delayed" method="get" class="filters">
        <div class="chips">
          <FilterChip label={tm('delayed.filter.days')} value={tm('delayed.filter.daysValue', { days })} apply={tm('delayed.filter.apply')}>
            <fieldset class="field">
              <legend class="field__label">{tm('delayed.filter.days')}</legend>
              {choices.map((d) => (
                <Radio id={`f-days-${d}`} name="days" value={String(d)} checked={d === days}>
                  {tm('delayed.filter.daysValue', { days: d })}
                  {d === props.defaultDays ? <span class="muted"> {tm('delayed.filter.default')}</span> : null}
                </Radio>
              ))}
            </fieldset>
          </FilterChip>
          {props.couriers.length > 1 || props.courier !== null ? (
            <FilterChip label={tm('delayed.filter.courier')} value={props.courier !== null ? courierName(props.courier) : undefined} apply={tm('delayed.filter.apply')}>
              <fieldset class="field">
                <legend class="field__label">{tm('delayed.filter.courier')}</legend>
                <Radio id="f-courier-all" name="courier" value="" checked={props.courier === null}>
                  {tm('delayed.filter.allCouriers')}
                </Radio>
                {props.couriers.map((c, i) => (
                  <Radio id={`f-courier-${i}`} name="courier" value={c} checked={c === props.courier}>
                    <span dir="auto">{courierName(c)}</span>
                  </Radio>
                ))}
              </fieldset>
            </FilterChip>
          ) : null}
          {filtered ? <a class="chips__clear" href="/parcels/delayed">{tm('delayed.filter.clear')}</a> : null}
        </div>
      </Form>

      {props.couriers.length === 0 && props.courier === null ? (
        <EmptyState
          icon="truck"
          title={tm('delayed.none.title')}
          {...(props.canConfigure ? { action: <a class="btn btn--secondary" href="/delivery/settings">{tm('delayed.none.configure')}</a> } : {})}
        >
          {tm('delayed.none')}
        </EmptyState>
      ) : props.total === 0 ? (
        <EmptyState icon="check" title={tm('delayed.empty.title')}>{tm('delayed.empty', { days })}</EmptyState>
      ) : (
        <>
          <Stats
            items={[
              { label: tm('delayed.stat.count'), value: <Num value={props.total} /> },
              ...(oldest ? [{ label: tm('delayed.stat.oldest'), value: tm('delayed.stat.oldestValue', { days: daysSince(now, oldest.lastUpdateAt) }) }] : []),
            ]}
          />
          <p class="callout">{tm('delayed.what')}</p>
          <Table
            stack
            class="table--rows tbl-delayed"
            caption={tm('delayed.caption')}
            rows={props.rows}
            rowKey={(r) => r.shipmentId}
            columns={[
              {
                key: 'parcel',
                header: tm('delayed.col.parcel'),
                cell: (r) => (
                  <>
                    <a class="row-link" href={`/orders/${r.ref}`}><Bdi>{r.ref}</Bdi></a>
                    <span class="cell-sub">{r.tracking ? <Bdi>{r.tracking}</Bdi> : tm('delayed.noTracking')}</span>
                  </>
                ),
              },
              { key: 'courier', header: tm('delayed.col.courier'), cell: (r) => <span dir="auto">{courierName(r.courier)}</span> },
              {
                key: 'silence',
                header: tm('delayed.col.silence'),
                cell: (r) => (
                  <>
                    <strong class="delay">{tm('delayed.silence', { days: daysSince(now, r.lastUpdateAt) })}</strong>
                    <span class="cell-sub"><DateTime ms={r.lastUpdateAt} /></span>
                  </>
                ),
              },
              { key: 'status', header: tm('delayed.col.status'), cell: (r) => <CourierStatus tm={tm} status={r.courierStatus} raw={r.courierStatusRaw} /> },
              {
                key: 'place',
                header: tm('delayed.col.place'),
                cell: (r) => (
                  <>
                    {String(r.wilayaCode).padStart(2, '0')} {lang === 'ar' ? r.wilayaAr : r.wilayaFr}
                    <span class="cell-sub">{r.deliveryType === 'stop_desk' ? tm('delayed.stopDesk') : tm('delayed.home')}</span>
                  </>
                ),
              },
              {
                key: 'customer',
                header: tm('delayed.col.customer'),
                cell: (r) => (
                  <>
                    <Bdi ltr={false}>{r.name}</Bdi>
                    <a class="cell-sub tel-link" href={`tel:${r.phoneE164}`}><Bdi>{formatPhoneDisplay(r.phoneE164)}</Bdi></a>
                  </>
                ),
              },
            ]}
          />
          {props.total > DELAYED_PAGE_SIZE ? <p class="muted list-note">{tm('delayed.more', { shown: DELAYED_PAGE_SIZE, total: props.total })}</p> : null}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Success rate
// ---------------------------------------------------------------------------------------------

export function courierLabel(tm: ParcelsMessages, key: string): string {
  if (key === '') return tm('perf.unrecorded');
  if (key.startsWith('name:')) return tm('perf.manual', { name: key.slice(5) });
  return courierName(key);
}

function Rate(props: { tm: ParcelsMessages; row: Pick<RateRow, 'delivered' | 'returned'> }) {
  const rate = successRate(props.row);
  if (rate === null) return <span class="muted">{props.tm('perf.noRate')}</span>;
  const small = props.row.delivered + props.row.returned < MIN_SAMPLE;
  return (
    <span class="rate">
      <span class="rate__value">{props.tm('perf.rateOf', { rate })}</span>
      <meter class="rate__bar" min={0} max={100} low={70} high={85} optimum={100} value={rate} aria-hidden="true" />
      {small ? <span class="cell-sub">{props.tm('perf.small')}</span> : null}
    </span>
  );
}

const perfHref = (period: Period, courier: string | null) => {
  const q = new URLSearchParams({ period: String(period) });
  if (courier !== null) q.set('courier', courier);
  return `/parcels/performance?${q}#by-wilaya`;
};

export function PerformancePage(props: { lang: Lang; period: Period; courier: string | null; byCourier: readonly RateRow[]; byWilaya: readonly RateRow[] }) {
  const tm = pm(props.lang);
  const { lang, period } = props;
  const all = totals(props.byCourier);
  const overall = successRate(all);
  const byCourier = [...props.byCourier].sort((a, b) => b.delivered + b.returned + b.inTransit - (a.delivered + a.returned + a.inTransit));
  const byWilaya = [...props.byWilaya].sort((a, b) => b.delivered + b.returned + b.inTransit - (a.delivered + a.returned + a.inTransit) || Number(a.key) - Number(b.key));
  const countCols: Column<RateRow>[] = [
    { key: 'delivered', header: tm('perf.col.delivered'), numeric: true, cell: (x) => <Num value={x.delivered} /> },
    { key: 'returned', header: tm('perf.col.returned'), numeric: true, cell: (x) => <Num value={x.returned} /> },
    { key: 'inTransit', header: tm('perf.col.inTransit'), numeric: true, cell: (x) => <Num value={x.inTransit} /> },
    { key: 'rate', header: tm('perf.col.rate'), cell: (x) => <Rate tm={tm} row={x} /> },
  ];
  return (
    <>
      <Tabs
        label={tm('perf.period')}
        items={PERIODS.map((p) => ({ href: perfHref(p, props.courier).replace('#by-wilaya', ''), label: tm(`perf.period.${p}`), current: p === period }))}
      />
      <p class="page-lead">{tm('perf.lead', { days: period })}</p>
      {all.delivered + all.returned + all.inTransit === 0 ? (
        <EmptyState icon="chart" title={tm('perf.empty.title')}>{tm('perf.empty')}</EmptyState>
      ) : (
        <>
          <Stats
            items={[
              { label: tm('perf.stat.rate'), value: overall === null ? tm('perf.noRate') : tm('perf.stat.rateValue', { rate: overall }) },
              { label: tm('perf.stat.delivered'), value: <Num value={all.delivered} /> },
              { label: tm('perf.stat.returned'), value: <Num value={all.returned} /> },
              { label: tm('perf.stat.inTransit'), value: <Num value={all.inTransit} /> },
            ]}
          />
          <section class="card" aria-labelledby="by-courier">
            <div class="card__head">
              <h2 class="card__title" id="by-courier">{tm('perf.byCourier')}</h2>
            </div>
            <div class="card__body">
              <Table
                stack
                caption={tm('perf.caption.courier')}
                rows={byCourier}
                rowKey={(r) => r.key || '-'}
                columns={[
                  {
                    key: 'courier',
                    header: tm('perf.col.courier'),
                    cell: (r) => (
                      <>
                        <span dir="auto">{courierLabel(tm, r.key)}</span>
                        {byCourier.length > 1 ? (
                          <a class="cell-sub cell-link" href={perfHref(period, r.key)} aria-current={r.key === props.courier ? 'true' : undefined}>
                            {tm('perf.byWilayaLink')}
                          </a>
                        ) : null}
                      </>
                    ),
                  },
                  ...countCols,
                ]}
              />
            </div>
          </section>
          <section class="card" id="by-wilaya" aria-labelledby="by-wilaya-title">
            <div class="card__head">
              <h2 class="card__title" id="by-wilaya-title">
                {props.courier !== null ? tm('perf.byWilayaFor', { courier: courierLabel(tm, props.courier) }) : tm('perf.byWilaya')}
              </h2>
              {props.courier !== null ? <a class="btn btn--quiet" href={perfHref(period, null)}>{tm('perf.allCouriers')}</a> : null}
            </div>
            <div class="card__body">
              <Table
                stack
                caption={tm('perf.caption.wilaya')}
                rows={byWilaya}
                rowKey={(r) => r.key}
                empty={tm('perf.empty')}
                emptyIcon="chart"
                columns={[
                  {
                    key: 'wilaya',
                    header: tm('perf.col.wilaya'),
                    cell: (r) => <>{r.key.padStart(2, '0')} {lang === 'ar' ? r.wilayaAr : r.wilayaFr}</>,
                  },
                  ...countCols,
                ]}
              />
            </div>
          </section>
        </>
      )}
    </>
  );
}
