// AORD-1 — orders list page (server-rendered, no JS). Filter form is a GET form.
import type { Child } from 'hono/jsx';
import { ORDER_STATUSES, formatPhoneDisplay, type OrderStatus } from '@hb/shared';
import type { Lang } from '../../i18n/index.ts';
import { StatusBadge } from '../../ui/badge.tsx';
import { Checkbox, Form, FormActions, Select, Submit, TextInput } from '../../ui/form.tsx';
import { Bdi, DateTime, Money } from '../../ui/format.tsx';
import { CursorPagination } from '../../ui/pagination.tsx';
import { Table, type Column } from '../../ui/table.tsx';
import type { OrderListRow, OrdersPage } from './list-data.ts';
import type { InvalidField, ParsedOrdersFilter } from './list-query.ts';
import { m, orderFlagTone, orderStatusLabel, orderStatusTone, type OrdersMessages } from './messages.ts';

const ALGIERS_OFFSET_MS = 60 * 60 * 1000;

/** ms (start of an Algiers day) → `YYYY-MM-DD` for `<input type="date">`. */
function dayValue(ms: number | null): string {
  if (ms === null) return '';
  return new Date(ms + ALGIERS_OFFSET_MS).toISOString().slice(0, 10);
}

/** `<input type="date">` with the kit's field classes (the kit's TextInput has no date type). */
function DateField(props: { name: string; label: string; value: string }) {
  const id = `f-${props.name}`;
  return (
    <div class="field">
      <label class="field__label" for={id}>{props.label}</label>
      <input id={id} class="input" type="date" name={props.name} value={props.value} dir="ltr" />
    </div>
  );
}

/** Status checkboxes sharing one `status` name (the kit's Checkbox derives ids from the name). */
function StatusChoices(props: { tm: OrdersMessages; lang: Lang; selected: readonly OrderStatus[] }) {
  return (
    <fieldset class="field">
      <legend class="field__label">{props.tm('filter.status')}</legend>
      {ORDER_STATUSES.map((s) => (
        <div class="field field--check">
          <input
            type="checkbox"
            class="check"
            id={`f-status-${s}`}
            name="status"
            value={s}
            checked={props.selected.includes(s)}
          />
          <label for={`f-status-${s}`}>{orderStatusLabel(props.lang, s)}</label>
        </div>
      ))}
    </fieldset>
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
          {tm('filter.invalid', {
            fields: parsed.invalid.map((k: InvalidField) => tm(`filter.invalid.${k}`)).join(', '),
          })}
        </p>
      ) : null}
      {notes.map((n) => (
        <p class="muted">{n}</p>
      ))}
    </div>
  );
}

function Filters(props: { tm: OrdersMessages; lang: Lang; parsed: ParsedOrdersFilter; page: OrdersPage; q: string; sensitive: boolean }) {
  const { tm, lang, parsed, page } = props;
  const f = parsed.filter;
  return (
    <Form action="/orders" method="get">
      <h2>{tm('filter.legend')}</h2>
      <TextInput name="q" type="search" label={tm('filter.q')} hint={tm('filter.q.hint')} value={props.q} maxlength={64} dir="auto" />
      <StatusChoices tm={tm} lang={lang} selected={parsed.defaulted ? [] : f.statuses} />
      <Select
        name="wilaya"
        label={tm('filter.wilaya')}
        placeholder={tm('filter.wilaya.any')}
        value={f.wilaya === null ? '' : String(f.wilaya)}
        options={page.wilayas.map((w) => ({
          value: String(w.code),
          label: `${String(w.code).padStart(2, '0')} — ${lang === 'ar' ? w.nameAr : w.nameFr}`,
        }))}
      />
      <DateField name="from" label={tm('filter.from')} value={dayValue(f.fromMs)} />
      <DateField name="to" label={tm('filter.to')} value={dayValue(f.toMs === null ? null : f.toMs - 86_400_000)} />
      {props.sensitive ? (
        <>
          <Checkbox name="flagged" label={tm('filter.flagged')} checked={f.flagged} />
          <Checkbox name="duplicate" label={tm('filter.duplicate')} checked={f.duplicate} />
          <Checkbox name="blocked" label={tm('filter.blocked')} checked={f.blockedCustomer} />
        </>
      ) : null}
      <FormActions>
        <Submit>{tm('filter.submit')}</Submit>
        <a class="btn btn--secondary" href="/orders">{tm('filter.reset')}</a>
      </FormActions>
    </Form>
  );
}

function columns(tm: OrdersMessages, lang: Lang, sensitive: boolean): Column<OrderListRow>[] {
  const cols: Column<OrderListRow>[] = [
    { key: 'ref', header: tm('list.col.ref'), cell: (r) => <a href={`/orders/${r.ref}`}><Bdi>{r.ref}</Bdi></a> },
    { key: 'date', header: tm('list.col.date'), cell: (r) => <DateTime ms={r.createdAt} /> },
    {
      key: 'customer',
      header: tm('list.col.customer'),
      cell: (r) => (
        <>
          <Bdi ltr={false}>{r.name}</Bdi>
          <br />
          <Bdi>{formatPhoneDisplay(r.phoneE164)}</Bdi>
          {r.customerBlocked ? (
            <>
              <br />
              <StatusBadge tone="danger" label={tm('list.blocked')} />
            </>
          ) : null}
        </>
      ),
    },
    {
      key: 'place',
      header: tm('list.col.place'),
      cell: (r) => (
        <>
          {lang === 'ar' ? r.wilayaAr : r.wilayaFr}
          <br />
          <span class="muted">{lang === 'ar' ? r.communeAr : r.communeFr}</span>
        </>
      ),
    },
    {
      key: 'items',
      header: tm('list.col.items'),
      cell: (r) => {
        const first = lang === 'ar' ? r.firstItemAr : r.firstItemFr;
        if (first === null) return '—';
        const label = `${first} ${tm('list.qty', { qty: r.firstItemQty ?? 1 })}`;
        return r.itemCount > 1 ? tm('list.items.more', { first: label, count: r.itemCount - 1 }) : label;
      },
    },
    { key: 'fee', header: tm('list.col.fee'), numeric: true, cell: (r) => <Money dzd={r.feeDzd} /> },
    { key: 'total', header: tm('list.col.total'), numeric: true, cell: (r) => <Money dzd={r.totalDzd} /> },
    {
      key: 'status',
      header: tm('list.col.status'),
      cell: (r) => (
        <>
          <StatusBadge tone={orderStatusTone(r.status)} label={orderStatusLabel(lang, r.status)} />
          {r.callAttempts !== undefined && r.callAttempts > 0 && (r.status === 'called' || r.status === 'unreachable') ? (
            <>
              <br />
              <span class="muted">{tm('status.attempt', { n: r.callAttempts })}</span>
            </>
          ) : null}
        </>
      ),
    },
  ];
  // Risk flags need `customers.sensitive`: the column is not rendered (and was not selected) otherwise.
  if (sensitive) {
    cols.push({
      key: 'flags',
      header: tm('list.col.flags'),
      cell: (r) =>
        !r.flags || r.flags.length === 0
          ? '—'
          : r.flags.map((fl) => (
              <>
                <StatusBadge tone={orderFlagTone(fl)} label={flagLabel(tm, fl)} />{' '}
              </>
            )),
    });
  }
  return cols;
}

/** Known flags get a label; an unknown flag (added later by `web`) is shown as its raw code. */
export function flagLabel(tm: OrdersMessages, flag: string): string {
  const key = `flag.${flag}`;
  const label = tm(key as Parameters<OrdersMessages>[0]);
  return label === key ? flag : label;
}

export function OrdersListPage(props: {
  lang: Lang;
  parsed: ParsedOrdersFilter;
  page: OrdersPage;
  q: string;
  /** Current path + query (for pagination links). */
  url: string;
  /** canSeeSensitive(user): risk filters and the flags column. */
  sensitive: boolean;
}) {
  const tm = m(props.lang);
  const { parsed, page } = props;
  return (
    <>
      <Filters tm={tm} lang={props.lang} parsed={parsed} page={page} q={props.q} sensitive={props.sensitive} />
      <Notices tm={tm} lang={props.lang} parsed={parsed} />
      <Table
        stack
        caption={tm('list.caption')}
        columns={columns(tm, props.lang, props.sensitive)}
        rows={page.rows}
        rowKey={(r) => r.id}
        empty={tm('list.empty')}
      />
      {page.next !== null ? <p class="muted">{tm('list.more', { count: page.rows.length })}</p> : null}
      <CursorPagination next={page.next} baseUrl={props.url} isFirst={parsed.filter.after === null} />
    </>
  );
}
