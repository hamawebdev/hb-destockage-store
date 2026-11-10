// AORD-2 — order detail page: customer, items, money, flags, timeline, and the action forms the
// user's role allows (cosmetic: every POST re-checks). No JS: the call form has one submit button
// per outcome, so the clicked button's `outcome` value is what the server receives.
import type { Child } from 'hono/jsx';
import { CALLABLE_STATUSES, formatPhoneDisplay, type OrderStatus } from '@hb/shared';
import { can } from '../../auth/permissions.ts';
import type { CurrentUser } from '../../env.ts';
import type { Lang } from '../../i18n/index.ts';
import { toAlgiersInput } from '../../lib/time.ts';
import { StatusBadge } from '../../ui/badge.tsx';
import { Checkbox, ErrorSummary, Form, FormActions, Submit, TextInput, Textarea } from '../../ui/form.tsx';
import { Bdi, DateTime, Money } from '../../ui/format.tsx';
import { Icon } from '../../ui/icons.tsx';
import { Table } from '../../ui/table.tsx';
import { groupTimeline, type OrderAuditRow, type OrderDetail, type OrderEventRow, type OrderItemRow } from './detail-data.ts';
import { flagLabel } from './list-page.tsx';
import { m, orderFlagTone, orderStatusLabel, orderStatusTone, type OrdersMessages } from './messages.ts';
import { CALL_CANCEL_REASONS, MANUAL_CANCEL_REASONS, manualTargets } from './workflow.ts';
import { canEditContact } from './contact.ts';

export type FormKind = 'call' | 'transition' | 'note';

export interface DetailProps {
  lang: Lang;
  user: CurrentUser;
  now: number;
  order: OrderDetail;
  items: readonly OrderItemRow[];
  events: readonly OrderEventRow[];
  audit: readonly OrderAuditRow[];
  /** Re-render after a 422: which form, what was typed, translated errors. */
  form?: { kind: FormKind; to?: string; values: Readonly<Record<string, string>>; errors: Readonly<Record<string, string>> };
  /** Re-render after a 409. */
  conflict?: { name: string | null; at: number };
  /** Re-render after a change refused because a parcel is being sent. */
  shipmentBusy?: boolean;
}

/** Errors that belong to a field of the form (the rest are shown at the top of the page). */
function fieldErrors(errors: Readonly<Record<string, string>>): Record<string, string> {
  const { _form: _a, to: _b, ...rest } = errors;
  return rest;
}

const CALL_BUTTONS = ['confirmed', 'no_answer', 'busy', 'callback', 'wrong_number', 'cancelled'] as const;

function Section(props: { title: string; id?: string; children: Child }) {
  return (
    <section class="card" aria-labelledby={props.id}>
      <div class="card__head">
        <h2 class="card__title" id={props.id}>{props.title}</h2>
      </div>
      <div class="card__body">{props.children}</div>
    </section>
  );
}

/** `<input type="datetime-local">` / `<select>` with the kit's field classes (not in the kit). */
function RawField(props: { name: string; label: string; hint?: string; error?: string | undefined; children: (id: string, describedBy: string | undefined) => Child }) {
  const id = `f-${props.name}`;
  const hintId = props.hint ? `${id}-hint` : undefined;
  const errId = props.error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div class={props.error ? 'field field--invalid' : 'field'}>
      <label class="field__label" for={id}>{props.label}</label>
      {props.hint ? <p class="field__hint" id={hintId}>{props.hint}</p> : null}
      {props.children(id, describedBy)}
      {props.error ? <p class="field__error" id={errId}>{props.error}</p> : null}
    </div>
  );
}

function ReasonSelect(props: { tm: OrdersMessages; name: string; label: string; hint?: string; reasons: readonly string[]; value: string | undefined; error: string | undefined }) {
  return (
    <RawField name={props.name} label={props.label} {...(props.hint ? { hint: props.hint } : {})} error={props.error}>
      {(id, describedBy) => (
        <select id={id} class="input input--select" name="reason" aria-describedby={describedBy} aria-invalid={props.error ? 'true' : undefined}>
          <option value="">{props.tm('call.choose')}</option>
          {props.reasons.map((r) => (
            <option value={r} selected={props.value === r}>
              {props.tm(`reason.${r}` as Parameters<OrdersMessages>[0])}
            </option>
          ))}
        </select>
      )}
    </RawField>
  );
}

/** The call form (detail page and call queue). `returnTo: 'queue'` brings the user back to the queue. */
export function CallForm(props: DetailProps & { tm: OrdersMessages; returnTo?: 'queue' }) {
  const { tm, order } = props;
  const risk = order.risk;
  if (!risk) return null; // only callers (owner, confirmer) get here, and they see the risk fields
  const mine = props.form?.kind === 'call' ? props.form : undefined;
  const val = (k: string) => mine?.values[k];
  const err = (k: string) => mine?.errors[k];
  const minCallback = toAlgiersInput(props.now);
  return (
    <Section title={tm('call.title', { n: risk.callAttempts + 1 })} id="call">
      <Form action={`/orders/${order.ref}/call`}>
        <input type="hidden" name="version" value={String(order.version)} />
        {props.returnTo ? <input type="hidden" name="return" value={props.returnTo} /> : null}
        {mine ? <ErrorSummary errors={fieldErrors(mine.errors)} /> : null}
        <RawField name="callbackAt" label={tm('call.callbackAt')} hint={tm('call.callbackHint')} error={err('callbackAt')}>
          {(id, describedBy) => (
            <input id={id} class="input" type="datetime-local" name="callbackAt" min={minCallback} value={val('callbackAt') ?? ''} dir="ltr" aria-describedby={describedBy} aria-invalid={err('callbackAt') ? 'true' : undefined} />
          )}
        </RawField>
        <ReasonSelect tm={tm} name="reason" label={tm('call.reason')} hint={tm('call.reasonHint')} reasons={CALL_CANCEL_REASONS} value={val('reason')} error={err('reason')} />
        <TextInput name="address" label={tm('call.address')} hint={tm('call.addressHint')} value={val('address') ?? order.address ?? ''} maxlength={300} dir="auto" error={err('address')} />
        {risk.flags.length > 0 ? (
          <>
            <Checkbox name="flagsChecked" label={tm('call.flagsChecked')} checked={val('flagsChecked') !== undefined} />
            {err('flagsChecked') ? <p class="field__error">{err('flagsChecked')}</p> : null}
          </>
        ) : null}
        <Textarea name="note" label={tm('call.note')} value={val('note')} rows={2} maxlength={1000} dir="auto" error={err('note')} />
        <fieldset class="field">
          <legend class="field__label">{tm('call.outcomes')}</legend>
          <FormActions>
            {CALL_BUTTONS.map((o) => (
              <Submit name="outcome" value={o} variant={o === 'confirmed' ? 'primary' : o === 'cancelled' || o === 'wrong_number' ? 'danger' : 'secondary'}>
                {tm(`outcome.${o}`)}
              </Submit>
            ))}
          </FormActions>
        </fieldset>
      </Form>
    </Section>
  );
}

function TransitionForms(props: DetailProps & { tm: OrdersMessages; targets: readonly OrderStatus[] }) {
  const { tm, order } = props;
  const mine = (to: string) => (props.form?.kind === 'transition' && props.form.to === to ? props.form : undefined);
  return (
    <Section title={tm('action.title')} id="actions">
      {props.targets.map((to) => {
        const f = mine(to);
        const label =
          to === 'cancelled' ? tm('action.cancel') : to === 'shipped' ? tm('action.ship') : to === 'delivered' ? tm('action.deliver') : tm('action.return');
        const confirm = to === 'cancelled' ? tm('action.confirmCancel') : to === 'returned' ? tm('action.confirmReturn') : undefined;
        return (
          <Form action={`/orders/${order.ref}/transition`} {...(confirm ? { confirm } : {})}>
            <input type="hidden" name="version" value={String(order.version)} />
            <input type="hidden" name="to" value={to} />
            {f ? <ErrorSummary errors={fieldErrors(f.errors)} /> : null}
            {to === 'cancelled' ? (
              <ReasonSelect tm={tm} name={`reason-${to}`} label={tm('action.reason')} reasons={MANUAL_CANCEL_REASONS[order.status] ?? []} value={f?.values['reason']} error={f?.errors['reason']} />
            ) : null}
            {to === 'shipped' ? (
              <>
                <TextInput name="courierName" label={tm('detail.courier')} value={f?.values['courierName'] ?? order.courierName ?? ''} maxlength={80} dir="auto" required error={f?.errors['courierName']} />
                <TextInput name="courierTracking" label={tm('detail.tracking')} value={f?.values['courierTracking'] ?? order.courierTracking ?? ''} maxlength={80} dir="ltr" error={f?.errors['courierTracking']} />
              </>
            ) : null}
            <FormActions>
              <Submit variant={to === 'cancelled' || to === 'returned' ? 'danger' : 'primary'}>{label}</Submit>
            </FormActions>
          </Form>
        );
      })}
    </Section>
  );
}

/** Take / release the call (claims never change the order's version: no hidden version field). */
export function ClaimButtons(props: DetailProps & { tm: OrdersMessages; claimActive: boolean; returnTo?: 'queue' }) {
  const { tm, order, user } = props;
  const mine = props.claimActive && order.risk?.claimedByUserId === user.id;
  const canRelease = props.claimActive && (mine || user.role === 'owner');
  return (
    <FormActions>
      {!mine ? (
        <Form action={`/orders/${order.ref}/claim`} class="inline-form">
          <Submit variant="secondary">{tm('claim.take')}</Submit>
        </Form>
      ) : null}
      {canRelease ? (
        <Form action={`/orders/${order.ref}/release`} class="inline-form">
          {props.returnTo ? <input type="hidden" name="return" value={props.returnTo} /> : null}
          <Submit variant="secondary">{tm('claim.release')}</Submit>
        </Form>
      ) : null}
    </FormActions>
  );
}

function NoteForm(props: DetailProps & { tm: OrdersMessages }) {
  const { tm, order } = props;
  const mine = props.form?.kind === 'note' ? props.form : undefined;
  return (
    <Section title={tm('note.title')} id="note">
      <Form action={`/orders/${order.ref}/note`}>
        <input type="hidden" name="version" value={String(order.version)} />
        <Textarea name="text" label={tm('note.text')} value={mine?.values['text']} rows={3} maxlength={1000} dir="auto" required error={mine?.errors['text']} />
        <FormActions>
          <Submit variant="secondary">{tm('note.submit')}</Submit>
        </FormActions>
      </Form>
    </Section>
  );
}

function Actor(props: { tm: OrdersMessages; e: OrderEventRow }) {
  const { tm, e } = props;
  if (e.actorType === 'customer') return <>{tm('timeline.customer')}</>;
  if (e.actorType === 'system') return <>{tm('timeline.system')}</>;
  return <>{tm('timeline.by', { name: '' })}<Bdi ltr={false}>{e.actorName ?? '?'}</Bdi></>;
}

function EventLine(props: { tm: OrdersMessages; lang: Lang; e: OrderEventRow }) {
  const { tm, lang, e } = props;
  const reason = e.outcome && e.type === 'status_change' ? tm('timeline.reason', { reason: tm(`reason.${e.outcome}` as Parameters<OrdersMessages>[0]) }) : null;
  switch (e.type) {
    case 'created':
      return <li>{tm('timeline.created')}</li>;
    case 'call_attempt':
      return (
        <li>
          {tm('timeline.call', { outcome: e.outcome ? tm(`outcome.${e.outcome}` as Parameters<OrdersMessages>[0]) : '?' })}
          {e.note ? <p dir="auto">{e.note}</p> : null}
        </li>
      );
    case 'status_change':
      return (
        <li>
          {e.fromStatus ? <StatusBadge tone={orderStatusTone(e.fromStatus)} label={orderStatusLabel(lang, e.fromStatus)} /> : null}
          {' → '}
          {e.toStatus ? <StatusBadge tone={orderStatusTone(e.toStatus)} label={orderStatusLabel(lang, e.toStatus)} /> : null}
          {reason ? <> · {reason}</> : null}
        </li>
      );
    default:
      return (
        <li>
          {tm('timeline.note')}
          {e.note ? <p dir="auto">{e.note}</p> : null}
        </li>
      );
  }
}

function Timeline(props: { tm: OrdersMessages; lang: Lang; events: readonly OrderEventRow[]; audit: readonly OrderAuditRow[] }) {
  const { tm, lang } = props;
  return (
    <Section title={tm('timeline.title')} id="timeline">
      <ol class="timeline">
        {groupTimeline(props.events).map((g) => (
          <li>
            <p class="muted">
              <DateTime ms={g[0]!.at} /> · <Actor tm={tm} e={g[0]!} />
            </p>
            <ul>
              {g.map((e) => (
                <EventLine tm={tm} lang={lang} e={e} />
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {props.audit.length > 0 ? (
        <details>
          <summary>{tm('timeline.audit')}</summary>
          <ul>
            {props.audit.map((a) => (
              <li>
                <DateTime ms={a.at} /> · <code dir="ltr">{a.action}</code> · <Bdi>{a.actorEmail ?? '?'}</Bdi>
                <br />
                <code dir="ltr">{JSON.stringify(a.after)}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

/** Where the order stands. Cancelled orders have no line: their badge says it all. */
const STEPS: readonly OrderStatus[] = ['new', 'called', 'confirmed', 'shipped', 'delivered'];

function Progress(props: { tm: OrdersMessages; lang: Lang; status: OrderStatus }) {
  const { lang, status } = props;
  if (status === 'cancelled') return null;
  const steps = status === 'returned' ? (['new', 'called', 'confirmed', 'shipped', 'returned'] as const) : STEPS;
  // `unreachable` is the calling stage; it is not a step of its own.
  const at = steps.indexOf(status === 'unreachable' ? 'called' : status);
  return (
    <ol class="steps">
      {steps.map((s, i) => (
        <li class={i < at ? 'step step--done' : i === at ? 'step step--now' : 'step'} aria-current={i === at ? 'step' : undefined}>
          <span class="step__dot">{i < at ? <Icon name="check" class="ico--sm" /> : null}</span>
          <span class="step__label">{orderStatusLabel(lang, s)}</span>
        </li>
      ))}
    </ol>
  );
}

export function OrderDetailPage(props: DetailProps) {
  const tm = m(props.lang);
  const { order, lang, user } = props;
  const name = (fr: string, ar: string) => (lang === 'ar' ? ar : fr);
  const risk = order.risk;
  const claimActive = risk !== null && risk.claimedUntil !== null && risk.claimedUntil > props.now && risk.claimedByUserId !== null;
  const canCall = can(user, 'orders.call') && CALLABLE_STATUSES.includes(order.status);
  const targets = manualTargets(order.status, user.role);

  // Errors not tied to a visible field (whole form, or a transition that has no form for this
  // status) go in one alert at the top.
  const topErrors = props.form ? [props.form.errors['_form'], props.form.errors['to']].filter((e): e is string => typeof e === 'string') : [];

  return (
    <>
      {topErrors.length > 0 ? (
        <div class="flash flash--danger" role="alert">
          {topErrors.map((e) => (
            <p>{e}</p>
          ))}
        </div>
      ) : null}
      {props.conflict ? (
        <div class="flash flash--danger" role="alert">
          <strong>{tm('conflict.title')}</strong>
          <p>
            {tm('conflict.body', { name: props.conflict.name ?? tm('conflict.someone') })} <DateTime ms={props.conflict.at} />
          </p>
          <p>{tm('conflict.retry')}</p>
        </div>
      ) : null}
      {props.shipmentBusy ? (
        <p class="flash flash--danger" role="alert">
          {tm('detail.shipmentBusy')} <a href="#shipment">{tm('detail.shipmentBusyLink')}</a>
        </p>
      ) : null}
      {claimActive ? (
        <p class="flash flash--success" role="status">
          {risk!.claimedByUserId === user.id
            ? tm('detail.claimMine')
            : tm('detail.claim', { name: risk!.claimedByName ?? '?' })}{' '}
          <DateTime ms={risk!.claimedUntil!} />
        </p>
      ) : null}
      {risk?.customerBlocked ? <p class="flash flash--danger" role="alert">{tm('detail.blocked')}</p> : null}

      <div class="order-head">
        <div class="order-head__who">
          <p class="order-head__name"><Bdi ltr={false}>{order.name}</Bdi></p>
          <p class="order-head__meta">
            <Bdi>{order.ref}</Bdi> · <Bdi>{formatPhoneDisplay(order.phoneE164)}</Bdi>
          </p>
        </div>
        <div class="order-head__status">
          <StatusBadge tone={orderStatusTone(order.status)} label={orderStatusLabel(lang, order.status)} />
          {risk && risk.callAttempts > 0 ? <span class="muted">{tm('status.attempt', { n: risk.callAttempts })}</span> : null}
          <span class="muted">
            {tm('detail.created')} <DateTime ms={order.createdAt} />
          </span>
        </div>
        <a class="btn btn--primary order-head__call" href={`tel:${order.phoneE164}`}>
          <Icon name="phone" />
          {tm('detail.call')}
        </a>
      </div>
      <Progress tm={tm} lang={lang} status={order.status} />
      {risk && risk.nextCallAt !== null ? (
        <p class="muted list-note">
          {tm('detail.nextCall')} : <DateTime ms={risk.nextCallAt} />
        </p>
      ) : null}

      <div class="order-grid">
        <div class="order-main">
          {canCall ? <ClaimButtons {...props} tm={tm} claimActive={claimActive} /> : null}
          {canCall ? <CallForm {...props} tm={tm} /> : null}
          {targets.length > 0 ? <TransitionForms {...props} tm={tm} targets={targets} /> : null}

          <Section title={tm('detail.items')} id="items">
            <Table
              stack
              caption={tm('detail.items')}
              rows={props.items}
              rowKey={(i) => i.id}
              columns={[
                {
                  key: 'product',
                  header: tm('detail.col.product'),
                  cell: (i) => {
                    const label = lang === 'ar' ? i.variantLabelAr : i.variantLabelFr;
                    return (
                      <>
                        {name(i.nameFr, i.nameAr)}
                        {label ? <span class="cell-sub">{label}</span> : null}
                      </>
                    );
                  },
                },
                { key: 'sku', header: tm('detail.col.sku'), cell: (i) => <Bdi>{i.sku}</Bdi> },
                { key: 'unit', header: tm('detail.col.unit'), numeric: true, cell: (i) => <Money dzd={i.unitPriceDzd} /> },
                { key: 'qty', header: tm('detail.col.qty'), numeric: true, cell: (i) => String(i.qty) },
                { key: 'line', header: tm('detail.col.line'), numeric: true, cell: (i) => <Money dzd={i.lineTotalDzd} /> },
              ]}
            />
          </Section>

          {can(user, 'orders.note') ? <NoteForm {...props} tm={tm} /> : null}
          <Timeline tm={tm} lang={lang} events={props.events} audit={props.audit} />
        </div>

        <div class="order-rail">
          <Section title={tm('detail.customer')} id="customer">
            {risk ? (
              <p class="muted">
                {tm('detail.customerCounts', {
                  orders: risk.orderCount,
                  delivered: risk.deliveredCount,
                  returned: risk.returnedCount,
                  cancelled: risk.cancelledCount,
                })}
              </p>
            ) : null}
            <p>
              <a href={`/customers/${order.customer.id}`}>{tm('detail.customerLink')}</a>
            </p>
          </Section>

          <Section title={tm('detail.delivery')} id="delivery">
            <dl class="details">
              <dt>{tm('list.col.place')}</dt>
              <dd>
                {String(order.wilayaCode).padStart(2, '0')} — {name(order.wilayaFr, order.wilayaAr)} / {name(order.communeFr, order.communeAr)}
              </dd>
              <dt>{tm('detail.address')}</dt>
              <dd dir="auto">{order.address ?? tm('detail.noAddress')}</dd>
              {order.courierName !== null ? (
                <>
                  <dt>{tm('detail.courier')}</dt>
                  <dd dir="auto">{order.courierName}</dd>
                </>
              ) : null}
              {order.courierTracking !== null ? (
                <>
                  <dt>{tm('detail.tracking')}</dt>
                  <dd><Bdi>{order.courierTracking}</Bdi></dd>
                </>
              ) : null}
              {order.stockRestoredAt !== null ? (
                <>
                  <dt>{tm('detail.stockRestored')}</dt>
                  <dd><DateTime ms={order.stockRestoredAt} /></dd>
                </>
              ) : null}
            </dl>
            {canEditContact(user.role, order.status) ? (
              <a class="btn btn--secondary" href={`/orders/${order.ref}/contact`}>{tm('contact.link')}</a>
            ) : null}
          </Section>

          <Section title={tm('detail.money')} id="money">
            <dl class="details details--money">
              <dt>{tm('detail.subtotal')}</dt>
              <dd><Money dzd={order.subtotalDzd} /></dd>
              <dt>{tm('detail.fee')}</dt>
              <dd><Money dzd={order.feeDzd} /></dd>
              <dt>{tm('detail.total')}</dt>
              <dd><strong><Money dzd={order.totalDzd} /></strong></dd>
              <dt>{tm('detail.feeSource')}</dt>
              <dd><Bdi>{order.feeSource}</Bdi></dd>
            </dl>
          </Section>

          {risk ? (
            <Section title={tm('detail.flags')} id="flags">
              {risk.flags.length === 0 ? (
                <p class="muted">{tm('detail.flagsNone')}</p>
              ) : (
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
              )}
            </Section>
          ) : null}
        </div>
      </div>
    </>
  );
}
