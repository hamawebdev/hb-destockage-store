// AORD-4 — customers pages (server-rendered, no JS). Sensitive sections render only from data that
// was selected (customerColumns(user)); logistics sees name, phone and the date it became a customer.
import type { Child } from 'hono/jsx';
import { formatPhoneDisplay } from '@hb/shared';
import type { Lang } from '../../i18n/index.ts';
import { StatusBadge } from '../../ui/badge.tsx';
import { Checkbox, ErrorSummary, Form, FormActions, Submit, TextInput, Textarea } from '../../ui/form.tsx';
import { Bdi, DateTime, Money } from '../../ui/format.tsx';
import { Icon } from '../../ui/icons.tsx';
import { FilterChip, SearchField, Stats } from '../../ui/kit.tsx';
import { CursorPagination } from '../../ui/pagination.tsx';
import { Table, type Column } from '../../ui/table.tsx';
import { flagLabel } from '../orders/list-page.tsx';
import { m, orderStatusLabel, orderStatusTone } from '../orders/messages.ts';
import type { CustomersFilter, CustomerInvalid, HistoryRow } from './data.ts';
import { BLOCK_REASON_MAX, BLOCK_REASON_MIN, NOTES_MAX, cm, type CustomersMessages } from './messages.ts';

/** A customer row as selected by customerColumns(user): sensitive keys absent for logistics. */
export interface CustomerRow {
  id: number;
  name: string;
  phoneE164: string;
  createdAt: number;
  orderCount?: number;
  deliveredCount?: number;
  returnedCount?: number;
  cancelledCount?: number;
  flags?: unknown;
  blocked?: boolean;
  notes?: string | null;
  lastOrderAt?: number | null;
}

/**
 * Customer flag → label in the UI language: customer flags first (frequent_returns…), then the
 * order-flag labels; an unknown code is shown as itself rather than hidden.
 */
export function customerFlagLabel(lang: Lang, flag: string): string {
  const key = `flag.${flag}`;
  const own = cm(lang)(key as Parameters<CustomersMessages>[0]);
  return own !== key ? own : flagLabel(m(lang), flag);
}

const flagList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : []);

export function CustomersListPage(props: {
  lang: Lang;
  sensitive: boolean;
  filter: CustomersFilter;
  invalid: readonly CustomerInvalid[];
  q: string;
  rows: readonly CustomerRow[];
  next: string | null;
  url: string;
}) {
  const t = cm(props.lang);
  const cols: Column<CustomerRow>[] = [
    { key: 'name', header: t('col.name'), cell: (r) => <a href={`/customers/${r.id}`}><Bdi ltr={false}>{r.name}</Bdi></a> },
    { key: 'phone', header: t('col.phone'), cell: (r) => <Bdi>{formatPhoneDisplay(r.phoneE164)}</Bdi> },
    { key: 'created', header: t('col.created'), cell: (r) => <DateTime ms={r.createdAt} withTime={false} /> },
  ];
  if (props.sensitive) {
    cols.push(
      { key: 'orders', header: t('col.orders'), numeric: true, cell: (r) => String(r.orderCount ?? 0) },
      { key: 'delivered', header: t('col.delivered'), numeric: true, cell: (r) => String(r.deliveredCount ?? 0) },
      { key: 'returned', header: t('col.returned'), numeric: true, cell: (r) => String(r.returnedCount ?? 0) },
      { key: 'cancelled', header: t('col.cancelled'), numeric: true, cell: (r) => String(r.cancelledCount ?? 0) },
      { key: 'last', header: t('col.lastOrder'), cell: (r) => (r.lastOrderAt ? <DateTime ms={r.lastOrderAt} withTime={false} /> : '—') },
      {
        key: 'flags',
        header: t('col.flags'),
        cell: (r) => (
          <>
            {r.blocked ? <StatusBadge tone="danger" label={t('blocked')} /> : null}{' '}
            {flagList(r.flags).map((f) => (
              <>
                <StatusBadge tone="warning" label={customerFlagLabel(props.lang, f)} />{' '}
              </>
            ))}
          </>
        ),
      },
    );
  }
  const riskCount = [props.filter.blocked, props.filter.flagged, props.filter.returns].filter(Boolean).length;
  return (
    <>
      <Form action="/customers" method="get" class="filters">
        <SearchField name="q" label={t('filter.q')} placeholder={t('filter.q.hint')} value={props.q} maxlength={64} />
        {props.sensitive ? (
          <div class="chips">
            <FilterChip label={t('col.flags')} value={riskCount > 0 ? String(riskCount) : undefined} apply={t('filter.submit')}>
              <Checkbox name="blocked" label={t('filter.blocked')} checked={props.filter.blocked} />
              <Checkbox name="flagged" label={t('filter.flagged')} checked={props.filter.flagged} />
              <Checkbox name="returns" label={t('filter.returns')} checked={props.filter.returns} />
            </FilterChip>
            {riskCount > 0 || props.q !== '' ? <a class="chips__clear" href="/customers">{t('filter.reset')}</a> : null}
          </div>
        ) : null}
      </Form>
      {props.invalid.length > 0 ? (
        <p class="flash flash--danger" role="status">
          {t('filter.invalid', { fields: props.invalid.map((k) => t(`filter.invalid.${k}`)).join(', ') })}
        </p>
      ) : null}
      <Table stack caption={t('list.caption')} columns={cols} rows={props.rows} rowKey={(r) => r.id} empty={t('list.empty')} emptyIcon="users" />
      <CursorPagination next={props.next} baseUrl={props.url} isFirst={props.filter.after === null} />
    </>
  );
}

function Section(props: { title: string; id: string; children: Child }) {
  return (
    <section class="card" aria-labelledby={props.id}>
      <div class="card__head">
        <h2 class="card__title" id={props.id}>{props.title}</h2>
      </div>
      <div class="card__body">{props.children}</div>
    </section>
  );
}

export interface DetailExtra {
  errors?: Readonly<Record<string, string>>;
  values?: Readonly<Record<string, string>>;
  /** Which form the errors belong to. */
  form?: 'block' | 'unblock' | 'notes';
  /** A message not tied to a field (409s). */
  top?: string;
}

export function CustomerDetailPage(props: {
  lang: Lang;
  sensitive: boolean;
  canBlock: boolean;
  canUnblock: boolean;
  canEditNotes: boolean;
  customer: CustomerRow;
  lastBlock: { action: 'customer.block' | 'customer.unblock'; at: number; by: string; reason: string | null } | null;
  history: readonly HistoryRow[];
  historyNext: string | null;
  historyFirst: boolean;
  url: string;
  extra?: DetailExtra;
}) {
  const t = cm(props.lang);
  const c = props.customer;
  const x = props.extra ?? {};
  const err = (form: DetailExtra['form'], k: string) => (x.form === form ? x.errors?.[k] : undefined);
  return (
    <>
      {x.top ? <p class="flash flash--danger" role="alert">{x.top}</p> : null}
      <div class="order-head">
        <div class="order-head__who">
          <p class="order-head__name"><Bdi ltr={false}>{c.name}</Bdi></p>
          <p class="order-head__meta">
            <Bdi>{formatPhoneDisplay(c.phoneE164)}</Bdi> · {t('col.created')} <DateTime ms={c.createdAt} withTime={false} />
          </p>
        </div>
        <a class="btn btn--primary order-head__call" href={`tel:${c.phoneE164}`}>
          <Icon name="phone" />
          {t('detail.call')}
        </a>
      </div>

      {props.sensitive ? (
        <>
          {c.blocked ? <p class="flash flash--danger" role="status">{t('detail.blockedBanner')}</p> : null}
          {props.lastBlock ? (
            <p>
              {t('detail.lastBlock', { action: t(props.lastBlock.action === 'customer.block' ? 'detail.lastBlock.block' : 'detail.lastBlock.unblock') })}{' '}
              <Bdi ltr={false}>{props.lastBlock.by}</Bdi>
              {t('detail.lastBlockOn')} <DateTime ms={props.lastBlock.at} />
              {props.lastBlock.reason ? (
                <>
                  {' · '}
                  {t('detail.reason')} <bdi>{props.lastBlock.reason}</bdi>
                </>
              ) : null}
            </p>
          ) : null}

          <Section title={t('detail.counts')} id="counts">
            <Stats
              items={[
                { label: t('col.orders'), value: String(c.orderCount ?? 0) },
                { label: t('col.delivered'), value: String(c.deliveredCount ?? 0) },
                { label: t('col.returned'), value: String(c.returnedCount ?? 0) },
                { label: t('col.cancelled'), value: String(c.cancelledCount ?? 0) },
                { label: t('col.lastOrder'), value: c.lastOrderAt ? <DateTime ms={c.lastOrderAt} withTime={false} /> : '—' },
              ]}
            />
          </Section>

          <Section title={t('detail.flags')} id="flags">
            {flagList(c.flags).length === 0 ? (
              <p class="muted">{t('detail.flagsNone')}</p>
            ) : (
              <ul>
                {flagList(c.flags).map((f) => (
                  <li>{customerFlagLabel(props.lang, f)}</li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={t('detail.notes')} id="notes">
            {props.canEditNotes ? (
              <Form action={`/customers/${c.id}/notes`}>
                {x.form === 'notes' && x.errors ? <ErrorSummary errors={x.errors} /> : null}
                <input type="hidden" name="seen" value={c.notes ?? ''} />
                <Textarea name="notes" label={t('detail.notes')} value={x.form === 'notes' ? x.values?.['notes'] : (c.notes ?? '')} rows={4} maxlength={NOTES_MAX} dir="auto" error={err('notes', 'notes')} />
                <FormActions>
                  <Submit variant="secondary">{t('notes.submit')}</Submit>
                </FormActions>
              </Form>
            ) : (
              <p dir="auto">{c.notes ?? t('detail.notesNone')}</p>
            )}
          </Section>

          {props.canBlock && !c.blocked ? (
            <Section title={t('block.title')} id="block">
              <Form action={`/customers/${c.id}/block`} confirm={t('block.confirm')}>
                {x.form === 'block' && x.errors ? <ErrorSummary errors={x.errors} /> : null}
                <TextInput name="reason" label={t('block.reason')} hint={t('block.reasonHint', { min: BLOCK_REASON_MIN })} value={x.form === 'block' ? x.values?.['reason'] : ''} maxlength={BLOCK_REASON_MAX} dir="auto" required error={err('block', 'reason')} />
                <FormActions>
                  <Submit variant="danger">{t('block.submit')}</Submit>
                </FormActions>
              </Form>
            </Section>
          ) : null}
          {props.canUnblock && c.blocked ? (
            <Section title={t('unblock.title')} id="unblock">
              <Form action={`/customers/${c.id}/unblock`} confirm={t('unblock.confirm')}>
                {x.form === 'unblock' && x.errors ? <ErrorSummary errors={x.errors} /> : null}
                <TextInput name="reason" label={t('unblock.reason')} hint={t('block.reasonHint', { min: BLOCK_REASON_MIN })} value={x.form === 'unblock' ? x.values?.['reason'] : ''} maxlength={BLOCK_REASON_MAX} dir="auto" required error={err('unblock', 'reason')} />
                <FormActions>
                  <Submit>{t('unblock.submit')}</Submit>
                </FormActions>
              </Form>
            </Section>
          ) : null}

          <Section title={t('detail.orders')} id="orders">
            <Table
              stack
              caption={t('detail.orders')}
              rows={props.history}
              rowKey={(o) => o.id}
              columns={[
                { key: 'ref', header: t('col.ref'), cell: (o) => <a href={`/orders/${o.ref}`}><Bdi>{o.ref}</Bdi></a> },
                { key: 'date', header: t('col.created'), cell: (o) => <DateTime ms={o.createdAt} /> },
                { key: 'status', header: t('col.status'), cell: (o) => <StatusBadge tone={orderStatusTone(o.status)} label={orderStatusLabel(props.lang, o.status)} /> },
                { key: 'total', header: t('col.total'), numeric: true, cell: (o) => <Money dzd={o.totalDzd} /> },
              ]}
            />
            <CursorPagination next={props.historyNext} baseUrl={props.url} isFirst={props.historyFirst} />
          </Section>
        </>
      ) : null}
    </>
  );
}

export type { CustomersMessages };
