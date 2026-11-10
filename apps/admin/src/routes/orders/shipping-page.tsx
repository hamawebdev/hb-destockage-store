// AORD-5 — shipping screen and printable slips (no JS). One form holds the "ready to ship" table:
// its two buttons post the same ticked orders either to the bulk ship or to the slips
// (`formaction`). Slips are bilingual whatever the UI language (FR and AR side by side).
import { formatPhoneDisplay } from '@hb/shared';
import type { Lang } from '../../i18n/index.ts';
import { EmptyState } from '../../ui/badge.tsx';
import { Form, Submit, TextInput } from '../../ui/form.tsx';
import { Bdi, DateTime, Money } from '../../ui/format.tsx';
import { BulkBar, Pick, PickAll } from '../../ui/kit.tsx';
import { Table } from '../../ui/table.tsx';
import { m } from './messages.ts';
import type { ShippingRow, Slip } from './shipping-data.ts';
import { SHIPPING_PAGE_SIZE } from './shipping-data.ts';

/** National form `0XXXXXXXXX` (what couriers dial). */
export const nationalPhone = (e164: string) => e164.replace(/^\+213/, '0');

/** A refused bulk ship re-renders with what was ticked and typed. */
export interface ShipKept {
  refs: readonly string[];
  courierName: string;
  tracking: Readonly<Record<string, string>>;
}

export type ShipResult = { ref: string; outcome: 'shipped' | 'conflict' | 'forbidden' | 'notFound' | 'notConfirmed' | 'shipmentBusy' };

export function ShippingPage(props: {
  lang: Lang;
  ready: readonly ShippingRow[];
  out: readonly ShippingRow[];
  counts: { confirmed: number; shipped: number };
  /** `delivery.send`: offer shipping's send page for the ticked orders. */
  send?: boolean;
  error?: string;
  results?: readonly ShipResult[];
  kept?: ShipKept;
}) {
  const tm = m(props.lang);
  const place = (r: ShippingRow) => `${String(r.wilayaCode).padStart(2, '0')} ${props.lang === 'ar' ? r.wilayaAr : r.wilayaFr} / ${props.lang === 'ar' ? r.communeAr : r.communeFr}`;
  const Head = (h: { id: string; title: string }) => (
    <div class="card__head">
      <h2 class="card__title" id={h.id}>{h.title}</h2>
    </div>
  );
  return (
    <>
      {props.error ? <p class="flash flash--danger" role="alert">{props.error}</p> : null}
      {props.results ? (
        <section class="card" aria-labelledby="ship-results">
          <Head id="ship-results" title={tm('ship.resultsTitle')} />
          <div class="card__body">
            <ul class="plain-list">
              {props.results.map((r) => (
                <li>
                  <Bdi>{r.ref}</Bdi> : {tm(`ship.result.${r.outcome}`)}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <section class="card" aria-labelledby="ship-ready">
        <Head id="ship-ready" title={tm('ship.ready', { count: props.counts.confirmed })} />
        <div class="card__body">
          {props.ready.length === 0 ? (
            <EmptyState icon="truck">{tm('ship.empty')}</EmptyState>
          ) : (
            <Form action="/orders/shipping/ship" class="bulk-form">
              <Table
                stack
                caption={tm('ship.readyCaption')}
                rows={props.ready}
                rowKey={(r) => r.id}
                columns={[
                  {
                    key: 'pick',
                    header: <PickAll label={tm('bulk.all')} />,
                    label: tm('ship.select'),
                    cell: (r) => (
                      <>
                        <Pick name="ref" value={r.ref} label={tm('ship.selectRef', { ref: r.ref })} checked={props.kept?.refs.includes(r.ref) ?? false} />
                        <input type="hidden" name={`version_${r.ref}`} value={String(r.version)} />
                      </>
                    ),
                  },
                  { key: 'ref', header: tm('list.col.ref'), cell: (r) => <><a href={`/orders/${r.ref}`}><Bdi>{r.ref}</Bdi></a><span class="cell-sub"><DateTime ms={r.createdAt} withTime={false} /></span></> },
                  {
                    key: 'to',
                    header: tm('slip.recipient'),
                    cell: (r) => (
                      <>
                        <Bdi ltr={false}>{r.name}</Bdi>
                        <span class="cell-sub"><Bdi>{formatPhoneDisplay(r.phoneE164)}</Bdi></span>
                      </>
                    ),
                  },
                  {
                    key: 'place',
                    header: tm('list.col.place'),
                    cell: (r) => (
                      <>
                        {place(r)}
                        {r.address && r.address.trim() !== '' ? <span class="cell-sub"><Bdi ltr={false}>{r.address}</Bdi></span> : null}
                      </>
                    ),
                  },
                  { key: 'items', header: tm('ship.items'), numeric: true, cell: (r) => String(r.itemCount) },
                  { key: 'amount', header: tm('ship.amount'), numeric: true, cell: (r) => <Money dzd={r.totalDzd} /> },
                  {
                    key: 'tracking',
                    header: tm('ship.tracking'),
                    cell: (r) => (
                      <input class="input" type="text" name={`tracking_${r.ref}`} value={props.kept?.tracking[r.ref] ?? ''} maxlength={80} dir="ltr" autocomplete="off" aria-label={tm('ship.trackingFor', { ref: r.ref })} />
                    ),
                  },
                ]}
              />
              {props.counts.confirmed > SHIPPING_PAGE_SIZE ? <p class="muted list-note">{tm('ship.more')}</p> : null}
              <div class="ship-fields">
                <TextInput name="courierName" label={tm('ship.courier')} value={props.kept?.courierName ?? ''} error={props.kept && props.kept.courierName.trim() === '' ? tm('err.courierRequired') : undefined} maxlength={80} dir="auto" required />
                <div class="field">
                  <label class="field__label" for="f-size">{tm('ship.size')}</label>
                  <select id="f-size" class="input input--select" name="size">
                    <option value="a6">A6</option>
                    <option value="a5">A5</option>
                  </select>
                </div>
              </div>
              <BulkBar selected={tm('bulk.selected')}>
                {/* Only "mark shipped" needs the typed courier: the other two skip the browser's required check. */}
                {props.send ? <button type="submit" class="btn btn--primary" formaction="/delivery/send" formnovalidate>{tm('bulk.send')}</button> : null}
                <button type="submit" class="btn btn--secondary" formaction="/orders/shipping/slips" formtarget="_blank" formnovalidate>{tm('ship.print')}</button>
                <Submit variant={props.send ? 'secondary' : 'primary'}>{tm('ship.markShipped')}</Submit>
              </BulkBar>
            </Form>
          )}
        </div>
      </section>

      <section class="card" aria-labelledby="ship-out">
        <Head id="ship-out" title={tm('ship.out', { count: props.counts.shipped })} />
        <div class="card__body">
          <Table
            stack
            caption={tm('ship.outCaption')}
            rows={props.out}
            rowKey={(r) => r.id}
            empty={tm('ship.outEmpty')}
            emptyIcon="truck"
            columns={[
              { key: 'ref', header: tm('list.col.ref'), cell: (r) => <a href={`/orders/${r.ref}`}><Bdi>{r.ref}</Bdi></a> },
              { key: 'to', header: tm('slip.recipient'), cell: (r) => <Bdi ltr={false}>{r.name}</Bdi> },
              { key: 'place', header: tm('list.col.place'), cell: (r) => place(r) },
              {
                key: 'courier',
                header: tm('slip.courier'),
                cell: (r) => (
                  <>
                    {r.courierName ? <Bdi ltr={false}>{r.courierName}</Bdi> : '—'}
                    {r.courierTracking ? <span class="cell-sub"><Bdi>{r.courierTracking}</Bdi></span> : null}
                  </>
                ),
              },
              { key: 'amount', header: tm('ship.amount'), numeric: true, cell: (r) => <Money dzd={r.totalDzd} /> },
              {
                key: 'act',
                header: tm('list.col.status'),
                cell: (r) => (
                  <div class="row-actions">
                    {(['delivered', 'returned'] as const).map((to) => (
                      <Form action={`/orders/${r.ref}/transition`} class="inline-form" {...(to === 'returned' ? { confirm: tm('action.confirmReturn') } : {})}>
                        <input type="hidden" name="version" value={String(r.version)} />
                        <input type="hidden" name="to" value={to} />
                        <input type="hidden" name="return" value="shipping" />
                        <Submit variant={to === 'returned' ? 'danger' : 'secondary'}>{tm(to === 'delivered' ? 'action.deliver' : 'action.return')}</Submit>
                      </Form>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        </div>
      </section>
    </>
  );
}

/** One slip: FR and AR columns; names and addresses in <bdi>, ref and phone LTR. */
function SlipCard(props: { slip: Slip; size: 'a6' | 'a5' }) {
  const fr = m('fr');
  const ar = m('ar');
  const s = props.slip;
  const both = (k: Parameters<typeof fr>[0]) => (
    <>
      <span lang="fr">{fr(k)}</span> / <span lang="ar" dir="rtl">{ar(k)}</span>
    </>
  );
  return (
    <article class={props.size === 'a5' ? 'slip slip--a5' : 'slip'}>
      <div class="slip__head">
        <span class="slip__ref" dir="ltr">{s.ref}</span>
        <span>
          <DateTime ms={s.createdAt} withTime={false} />
        </span>
      </div>
      <div>
        <span class="slip__label">{both('slip.recipient')}</span>
        <strong><bdi>{s.name}</bdi></strong>
        <br />
        <span class="slip__label">{both('slip.phone')}</span>
        <span class="slip__phone" dir="ltr">{nationalPhone(s.phoneE164)}</span>
        <br />
        <span class="slip__label">{both('slip.address')}</span>
        {/* db stores a blank address as NULL: a dash, never "null" or an empty <bdi>. */}
        {s.address && s.address.trim() !== '' ? <bdi>{s.address}</bdi> : '—'}
      </div>
      <div class="slip__cols">
        <div class="slip__col" lang="fr" dir="ltr">
          <span class="slip__label">{fr('slip.wilaya')}</span>
          <span dir="ltr">{String(s.wilayaCode).padStart(2, '0')}</span> {s.wilayaFr}
          {s.courierWilayaCode ? <> · {fr('slip.courierWilaya')} <span dir="ltr">{s.courierWilayaCode}</span></> : null}
          <span class="slip__label">{fr('slip.commune')}</span>
          {s.communeFr}
        </div>
        <div class="slip__col" lang="ar" dir="rtl">
          <span class="slip__label">{ar('slip.wilaya')}</span>
          <span dir="ltr">{String(s.wilayaCode).padStart(2, '0')}</span> {s.wilayaAr}
          {s.courierWilayaCode ? <> · {ar('slip.courierWilaya')} <span dir="ltr">{s.courierWilayaCode}</span></> : null}
          <span class="slip__label">{ar('slip.commune')}</span>
          {s.communeAr}
        </div>
      </div>
      <table class="slip__items">
        <thead>
          <tr>
            <th scope="col">{both('slip.items')}</th>
            <th scope="col">SKU</th>
            <th scope="col">{both('slip.qty')}</th>
          </tr>
        </thead>
        <tbody>
          {s.items.map((i) => (
            <tr>
              <td>
                {/* FR and AR on one line: ten lines must still fit one A5 page. */}
                <span lang="fr">{i.nameFr}{i.variantLabelFr ? ` — ${i.variantLabelFr}` : ''}</span>
                {' · '}
                <span lang="ar" dir="rtl">{i.nameAr}{i.variantLabelAr ? ` — ${i.variantLabelAr}` : ''}</span>
              </td>
              <td dir="ltr">{i.sku}</td>
              <td dir="ltr">{String(i.qty)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="slip__amount">
        {both('slip.amount')} : <span dir="ltr">{formatDzdPlain(s.totalDzd)} DA</span>
      </div>
      <div class="slip__foot">
        {both('slip.fee')} <span dir="ltr">{formatDzdPlain(s.feeDzd)} DA</span>
        {s.courierName ? <> · {both('slip.courier')} <bdi>{s.courierName}</bdi></> : null}
        {s.courierTracking ? <> · {both('slip.tracking')} <span dir="ltr">{s.courierTracking}</span></> : null}
      </div>
      <div class="slip__foot">
        <bdi>{fr('slip.store')}</bdi> · <span dir="ltr">0560417403</span>
      </div>
    </article>
  );
}

/** Integer DZD with a thin no-break space every three digits, Latin digits (same on both sides). */
export function formatDzdPlain(dzd: number): string {
  return String(dzd).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function SlipsPage(props: { lang: Lang; slips: readonly Slip[]; refused: readonly string[]; size: 'a6' | 'a5' }) {
  const tm = m(props.lang);
  return (
    <>
      {props.refused.length > 0 ? (
        <p class="flash flash--danger" role="alert">
          {tm('slip.refused')}{' '}
          {props.refused.map((r) => (
            <>
              <Bdi>{r}</Bdi>{' '}
            </>
          ))}
        </p>
      ) : null}
      <div class="slips">
        {props.slips.map((s) => (
          <SlipCard slip={s} size={props.size} />
        ))}
      </div>
    </>
  );
}
