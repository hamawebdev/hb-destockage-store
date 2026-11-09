// AORD-1 / UX-2 — orders list (server-rendered). Status tabs with counts, today's numbers, search
// and filter chips (one GET form), the table, and a bulk bar for the actions that exist.
import type { Child } from 'hono/jsx';
import { ORDER_STATUSES, formatPhoneDisplay, type OrderStatus } from '@hb/shared';
import type { Lang } from '../../i18n/index.ts';
import { StatusBadge } from '../../ui/badge.tsx';
import { Form } from '../../ui/form.tsx';
import { Bdi, DateTime, Money, Num } from '../../ui/format.tsx';
import { BulkBar, FilterChip, Pick, PickAll, SearchField, Stats, Tabs, type TabItem } from '../../ui/kit.tsx';
import { CursorPagination } from '../../ui/pagination.tsx';
import { Table, type Column } from '../../ui/table.tsx';
import type { OrderListRow, OrdersPage, OrdersToday } from './list-data.ts';
import type { InvalidField, ParsedOrdersFilter } from './list-query.ts';
import { m, orderFlagTone, orderStatusLabel, orderStatusTone, type OrdersMessages } from './messages.ts';

const ALGIERS_OFFSET_MS = 60 * 60 * 1000;

/** ms (start of an Algiers day) → `YYYY-MM-DD` for `<input type="date">`. */
function dayValue(ms: number | null): string {
  if (ms === null) return '';
  return new Date(ms + ALGIERS_OFFSET_MS).toISOString().slice(0, 10);
}

function DateField(props: { name: string; label: string; value: string }) {
  const id = `f-${props.name}`;
  return (
    <div class="field">
      <label class="field__label" for={id}>{props.label}</label>
      <input id={id} class="input" type="date" name={props.name} value={props.value} dir="ltr" />
    </div>
  );
}

function CheckRow(props: { id: string; name: string; value: string; checked: boolean; label: string }) {
  return (
    <div class="field field--check">
      <input type="checkbox" class="check" id={props.id} name={props.name} value={props.value} checked={props.checked} />
      <label for={props.id}>{props.label}</label>
    </div>
  );
}

function Notices(props: { tm: OrdersMessages; lang: Lang; parsed: ParsedOrdersFilter }) {
  const { tm, lang, parsed } = props;
  const f = parsed.filter;
  const notes: Child[] = [];
  if (parsed.defaulted && f.statuses.length > 0) {
    notes.push(tm('filter.defaulted', { statuses: f.statuses.map((s) => orderStatusLabel(lang, s)).join(', ') }));
  }
  if (f.search?.kind === 'phone') {
    notes.push(<>{tm('filter.search.phone')} <Bdi>{formatPhoneDisplay(f.search.e164)}</Bdi></>);
  } else if (f.search?.kind === 'ref') {
    notes.push(<>{tm('filter.search.ref')} <Bdi>{f.search.ref}</Bdi></>);
  } else if (f.search?.kind === 'refOrName') {
    notes.push(<>{tm('filter.search.ref')} <Bdi>{f.search.ref}</Bdi> · {tm('filter.search.name', { term: f.search.term })}</>);
  } else if (f.search?.kind === 'name') {
    notes.push(tm('filter.search.name', { term: f.search.term }));
  }
  return (
    <div role="status" aria-live="polite">
      {parsed.invalid.length > 0 ? (
        <p class="flash flash--danger">
          {tm('filter.invalid', { fields: parsed.invalid.map((k: InvalidField) => tm(`filter.invalid.${k}`)).join(', ') })}
        </p>
      ) : null}
      {notes.map((n) => (
        <p class="muted list-note">{n}</p>
      ))}
    </div>
  );
}

function Filters(props: { tm: OrdersMessages; lang: Lang; parsed: ParsedOrdersFilter; page: OrdersPage; q: string; sensitive: boolean }) {
  const { tm, lang, parsed, page } = props;
  const f = parsed.filter;
  const selected = parsed.defaulted ? [] : f.statuses;
  const wilaya = f.wilaya === null ? undefined : page.wilayas.find((w) => w.code === f.wilaya);
  const from = dayValue(f.fromMs);
  const to = dayValue(f.toMs === null ? null : f.toMs - 86_400_000);
  const riskCount = [f.flagged, f.duplicate, f.blockedCustomer].filter(Boolean).length;
  const anyFilter = selected.length > 0 || f.wilaya !== null || from !== '' || to !== '' || riskCount > 0 || props.q !== '';
  return (
    <Form action="/orders" method="get" class="filters">
      {/* On the All tab, filtering must not fall back to the role's default statuses. */}
      {!parsed.defaulted && f.statuses.length === 0 ? <input type="hidden" name="status" value="any" /> : null}
      <SearchField name="q" label={tm('filter.q')} placeholder={tm('filter.q.hint')} value={props.q} maxlength={64} />
      <div class="chips">
        <FilterChip label={tm('filter.status')} value={selected.length > 0 ? String(selected.length) : undefined} apply={tm('filter.submit')}>
          <fieldset class="field">
            <legend class="field__label">{tm('filter.status')}</legend>
            {ORDER_STATUSES.map((s) => (
              <CheckRow id={`f-status-${s}`} name="status" value={s} checked={selected.includes(s)} label={orderStatusLabel(lang, s)} />
            ))}
          </fieldset>
        </FilterChip>
        <FilterChip label={tm('filter.wilaya')} value={wilaya ? (lang === 'ar' ? wilaya.nameAr : wilaya.nameFr) : undefined} apply={tm('filter.submit')}>
          <div class="field">
            <label class="field__label" for="f-wilaya">{tm('filter.wilaya')}</label>
            <select id="f-wilaya" class="input input--select" name="wilaya">
              <option value="">{tm('filter.wilaya.any')}</option>
              {page.wilayas.map((w) => (
                <option value={String(w.code)} selected={w.code === f.wilaya}>
                  {`${String(w.code).padStart(2, '0')} — ${lang === 'ar' ? w.nameAr : w.nameFr}`}
                </option>
              ))}
            </select>
          </div>
        </FilterChip>
        <FilterChip label={tm('chip.period')} value={from !== '' || to !== '' ? `${from || '…'} → ${to || '…'}` : undefined} apply={tm('filter.submit')}>
          <DateField name="from" label={tm('filter.from')} value={from} />
          <DateField name="to" label={tm('filter.to')} value={to} />
        </FilterChip>
        {props.sensitive ? (
          <FilterChip label={tm('chip.risk')} value={riskCount > 0 ? String(riskCount) : undefined} apply={tm('filter.submit')}>
            <CheckRow id="f-flagged" name="flagged" value="1" checked={f.flagged} label={tm('filter.flagged')} />
            <CheckRow id="f-duplicate" name="duplicate" value="1" checked={f.duplicate} label={tm('filter.duplicate')} />
            <CheckRow id="f-blocked" name="blocked" value="1" checked={f.blockedCustomer} label={tm('filter.blocked')} />
          </FilterChip>
        ) : null}
        {anyFilter ? <a class="chips__clear" href="/orders">{tm('filter.reset')}</a> : null}
      </div>
    </Form>
  );
}

/** Known flags get a label; an unknown flag (added later by `web`) is shown as its raw code. */
export function flagLabel(tm: OrdersMessages, flag: string): string {
  const key = `flag.${flag}`;
  const label = tm(key as Parameters<OrdersMessages>[0]);
  return label === key ? flag : label;
}

/** Rows a bulk action applies to: slips print for confirmed and shipped orders. */
const PICKABLE: readonly OrderStatus[] = ['confirmed', 'shipped'];

function columns(tm: OrdersMessages, lang: Lang, sensitive: boolean, bulk: boolean): Column<OrderListRow>[] {
  const cols: Column<OrderListRow>[] = [];
  if (bulk) {
    cols.push({
      key: 'pick',
      header: <PickAll label={tm('bulk.all')} />,
      label: '',
      class: 'c-pick',
      cell: (r) =>
        PICKABLE.includes(r.status) ? (
          <>
            <Pick name="ref" value={r.ref} label={tm('ship.selectRef', { ref: r.ref })} />
            <input type="hidden" name={`version_${r.ref}`} value={String(r.version)} />
          </>
        ) : null,
    });
  }
  cols.push(
    {
      key: 'ref',
      header: tm('list.col.ref'),
      class: 'c-ref',
      cell: (r) => (
        <>
          <a class="row-link" href={`/orders/${r.ref}`}><Bdi>{r.ref}</Bdi></a>
          <span class="cell-sub"><DateTime ms={r.createdAt} /></span>
        </>
      ),
    },
    {
      key: 'customer',
      header: tm('list.col.customer'),
      class: 'c-cust',
      cell: (r) => (
        <>
          <span class="cell-main"><Bdi ltr={false}>{r.name}</Bdi></span>
          <span class="cell-sub"><Bdi>{formatPhoneDisplay(r.phoneE164)}</Bdi></span>
          {r.customerBlocked ? <StatusBadge tone="danger" label={tm('list.blocked')} /> : null}
        </>
      ),
    },
    {
      key: 'place',
      header: tm('list.col.place'),
      class: 'c-place',
      cell: (r) => (
        <>
          {lang === 'ar' ? r.wilayaAr : r.wilayaFr}
          <span class="cell-sub">{lang === 'ar' ? r.communeAr : r.communeFr}</span>
        </>
      ),
    },
    {
      key: 'items',
      header: tm('list.col.items'),
      class: 'c-items',
      cell: (r) => {
        const first = lang === 'ar' ? r.firstItemAr : r.firstItemFr;
        if (first === null) return '—';
        const label = `${first} ${tm('list.qty', { qty: r.firstItemQty ?? 1 })}`;
        return r.itemCount > 1 ? tm('list.items.more', { first: label, count: r.itemCount - 1 }) : label;
      },
    },
    {
      key: 'total',
      header: tm('list.col.total'),
      numeric: true,
      class: 'c-total',
      cell: (r) => (
        <>
          <span class="cell-main"><Money dzd={r.totalDzd} /></span>
          <span class="cell-sub">{tm('list.col.fee')} <Money dzd={r.feeDzd} /></span>
        </>
      ),
    },
    {
      key: 'status',
      header: tm('list.col.status'),
      class: 'c-status',
      cell: (r) => (
        <>
          <StatusBadge tone={orderStatusTone(r.status)} label={orderStatusLabel(lang, r.status)} />
          {r.callAttempts !== undefined && r.callAttempts > 0 && (r.status === 'called' || r.status === 'unreachable') ? (
            <span class="cell-sub">{tm('status.attempt', { n: r.callAttempts })}</span>
          ) : null}
          {r.courierName ? (
            <span class="cell-sub">
              <Bdi ltr={false}>{r.courierName}</Bdi>
              {r.courierTracking ? <> · <Bdi>{r.courierTracking}</Bdi></> : null}
            </span>
          ) : null}
          {sensitive && r.flags && r.flags.length > 0 ? (
            <span class="cell-flags">
              {r.flags.map((fl) => (
                <StatusBadge tone={orderFlagTone(fl)} label={flagLabel(tm, fl)} />
              ))}
            </span>
          ) : null}
        </>
      ),
    },
  );
  return cols;
}

/** Status tabs per role; each one is a `status=` filter, and the role's default view is one of them. */
function tabSets(role: 'owner' | 'confirmer' | 'logistics' | 'content'): readonly (readonly [string, readonly OrderStatus[]])[] {
  const toCall = ['tab.toCall', ['new', 'called', 'unreachable']] as const;
  const all = ['tab.all', []] as const;
  const confirmed = ['tab.confirmed', ['confirmed']] as const;
  const shipped = ['tab.shipped', ['shipped']] as const;
  const delivered = ['tab.delivered', ['delivered']] as const;
  const returned = ['tab.returned', ['returned']] as const;
  const cancelled = ['tab.cancelled', ['cancelled']] as const;
  if (role === 'confirmer') return [toCall, confirmed, shipped, delivered, returned, cancelled, all];
  if (role === 'logistics') return [['tab.inProgress', ['confirmed', 'shipped']], confirmed, shipped, delivered, returned, all];
  return [all, toCall, confirmed, shipped, delivered, returned, cancelled];
}

function statusTabs(tm: OrdersMessages, role: Parameters<typeof tabSets>[0], parsed: ParsedOrdersFilter, url: string, counts: ReadonlyMap<string, number>, sensitive: boolean): TabItem[] {
  const current = [...parsed.filter.statuses].sort().join();
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return tabSets(role).map(([key, statuses]) => {
    const u = new URL(url, 'http://x');
    u.searchParams.delete('status');
    u.searchParams.delete('after');
    u.searchParams.delete('m');
    // A risk filter refused for this role was not applied: the tab links must not carry it on.
    if (!sensitive) for (const k of ['flagged', 'duplicate', 'blocked']) u.searchParams.delete(k);
    if (statuses.length === 0) u.searchParams.set('status', 'any');
    for (const s of statuses) u.searchParams.append('status', s);
    return {
      href: `${u.pathname}?${u.searchParams.toString()}`,
      label: tm(key as Parameters<OrdersMessages>[0]),
      count: statuses.length === 0 ? total : statuses.reduce((a, s) => a + (counts.get(s) ?? 0), 0),
      current: [...statuses].sort().join() === current,
    };
  });
}

export function OrdersListPage(props: {
  lang: Lang;
  role: Parameters<typeof tabSets>[0];
  parsed: ParsedOrdersFilter;
  page: OrdersPage;
  counts: ReadonlyMap<string, number>;
  today: OrdersToday;
  q: string;
  /** Current path + query (for pagination and tab links). */
  url: string;
  /** canSeeSensitive(user): risk filters and flags. */
  sensitive: boolean;
  /** can(user, 'orders.shipping'): row checkboxes and the bulk bar. */
  bulk: boolean;
}) {
  const tm = m(props.lang);
  const { parsed, page, today } = props;
  const hasPickable = props.bulk && page.rows.some((r) => PICKABLE.includes(r.status));
  const table = (
    <Table
      stack
      class="table--rows tbl-orders"
      caption={tm('list.caption')}
      columns={columns(tm, props.lang, props.sensitive, hasPickable)}
      rows={page.rows}
      rowKey={(r) => r.id}
      empty={tm('list.empty')}
      emptyIcon="inbox"
    />
  );
  return (
    <>
      <Tabs label={tm('tabs.label')} items={statusTabs(tm, props.role, parsed, props.url, props.counts, props.sensitive)} />
      <Stats
        items={[
          { label: tm('stat.today'), value: <Num value={today.total} /> },
          { label: tm('stat.toCall'), value: <Num value={today.toCall} /> },
          { label: tm('stat.confirmed'), value: <Num value={today.confirmed} /> },
          { label: tm('stat.rate'), value: today.rate === null ? '—' : `${today.rate}%`, sub: tm('stat.rateSub') },
          { label: tm('stat.cancelled'), value: <Num value={today.cancelled} /> },
        ]}
      />
      <Filters tm={tm} lang={props.lang} parsed={parsed} page={page} q={props.q} sensitive={props.sensitive} />
      <Notices tm={tm} lang={props.lang} parsed={parsed} />
      {hasPickable ? (
        <Form action="/orders/shipping/slips" class="bulk-form">
          {table}
          <BulkBar selected={tm('bulk.selected')}>
            <button type="submit" class="btn btn--secondary" formaction="/orders/shipping/slips" formtarget="_blank">{tm('ship.print')}</button>
          </BulkBar>
        </Form>
      ) : (
        table
      )}
      {page.next !== null ? <p class="muted list-note">{tm('list.more', { count: page.rows.length })}</p> : null}
      <CursorPagination next={page.next} baseUrl={props.url} isFirst={parsed.filter.after === null} />
    </>
  );
}
