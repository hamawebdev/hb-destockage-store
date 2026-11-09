// The sending page (one or many orders) and its results. Reachable without JS: "Check" re-renders
// the page with the chosen values, "Send" does the real send.
import type { CourierCommune, CourierStopDesk } from '@hb/couriers';
import { useUi } from '../../ui/context.ts';
import { StatusBadge, type Tone } from '../../ui/badge.tsx';
import { Bdi, Money } from '../../ui/format.tsx';
import { ErrorSummary, Form, FormActions, Select, Submit, TextInput, type Option } from '../../ui/form.tsx';
import { Table } from '../../ui/table.tsx';
import { SEND_LIMITS, type SendFields, type SendOrder, type SendOutcome } from './send.ts';
import { sm, type SendMessage } from './send-messages.ts';

export interface SendRow {
  order: SendOrder;
  fields: SendFields;
  /** `prepare` result for these values; null when ready. */
  problem: { code: string; detail?: string } | null;
  communes: readonly CourierCommune[];
  stopDesks: readonly CourierStopDesk[];
  rowError?: string;
}

export interface SendPageProps {
  couriers: readonly Option[];
  courier: string | null;
  rows: readonly SendRow[];
  /** Refs and versions carried through when no courier is chosen yet. */
  carry: readonly { ref: string; version: string }[];
  canStopDesk: boolean;
  error?: string;
  canConfigure: boolean;
}

function problemText(tm: ReturnType<typeof sm>, code: string): string {
  return tm(`refused.${code}` as SendMessage);
}

function OrderRow(props: { row: SendRow; canStopDesk: boolean }) {
  const { lang } = useUi();
  const tm = sm(lang);
  const { order, fields, problem, communes, stopDesks, rowError } = props.row;
  const ref = order.ref;
  const deskOptions: Option[] = stopDesks.map((d) => ({ value: d.id, label: `${d.name} (${d.communeName})` }));
  const communeOptions: Option[] = communes.map((co) => ({ value: co.name, label: co.name }));
  return (
    <fieldset class="send-row">
      <legend>
        <a href={`/orders/${ref}`}><Bdi>{ref}</Bdi></a> · <Bdi>{order.name}</Bdi> · <Bdi ltr>{order.phoneE164}</Bdi>
      </legend>
      <p>
        {lang === 'ar' ? `${order.communeAr}، ${order.wilayaAr}` : `${order.communeFr}, ${order.wilayaFr}`} · {tm('col.cod')}: <Money dzd={order.totalDzd} />
      </p>
      <input type="hidden" name="ref" value={ref} />
      <input type="hidden" name={`version_${ref}`} value={String(fields.version)} />
      <TextInput name={`address_${ref}`} label={tm('field.address')} value={fields.address ?? ''} maxlength={SEND_LIMITS.ADDRESS_MAX} error={rowError} />
      {props.canStopDesk ? (
        <Select
          name={`type_${ref}`}
          label={tm('field.type')}
          value={fields.deliveryType}
          options={[
            { value: 'home', label: tm('type.home') },
            { value: 'stop_desk', label: tm('type.stop_desk') },
          ]}
        />
      ) : (
        <input type="hidden" name={`type_${ref}`} value="home" />
      )}
      {props.canStopDesk && fields.deliveryType === 'stop_desk' ? (
        <Select name={`desk_${ref}`} label={tm('field.desk')} placeholder={tm('field.desk.pick')} value={fields.stopDeskId ?? undefined} options={deskOptions} />
      ) : null}
      {problem?.code === 'commune_unmapped' && communeOptions.length > 0 ? (
        <Select name={`commune_${ref}`} label={tm('field.commune')} placeholder={tm('field.commune.pick')} value={fields.communeName ?? undefined} options={communeOptions} />
      ) : fields.communeName ? (
        <input type="hidden" name={`commune_${ref}`} value={fields.communeName} />
      ) : null}
      <p>{problem ? <StatusBadge tone="warning" label={problemText(tm, problem.code)} /> : <StatusBadge tone="success" label={tm('preview.ok')} />}</p>
    </fieldset>
  );
}

export function SendPage(props: SendPageProps) {
  const { lang } = useUi();
  const tm = sm(lang);
  return (
    <>
      {props.error ? <ErrorSummary errors={{ _form: props.error }} /> : null}
      <p>{tm('intro')}</p>
      {props.couriers.length === 0 ? (
        <div class="callout callout--warning" role="status">
          <p>{tm('courier.none')}</p>
          {props.canConfigure ? <p><a href="/delivery/settings">{tm('courier.settings')}</a></p> : null}
        </div>
      ) : (
        <Form action="/delivery/send/confirm">
          <Select name="courier" label={tm('courier')} placeholder={tm('courier.pick')} value={props.courier ?? undefined} options={props.couriers} />
          {props.courier === null ? (
            <>
              {props.carry.map((c) => (
                <>
                  <input type="hidden" name="ref" value={c.ref} />
                  <input type="hidden" name={`version_${c.ref}`} value={c.version} />
                </>
              ))}
              <button class="btn btn--primary" type="submit" formaction="/delivery/send">{tm('courier.apply')}</button>
            </>
          ) : (
            <>
              {props.rows.map((row) => <OrderRow row={row} canStopDesk={props.canStopDesk} />)}
              <FormActions>
                <button class="btn btn--secondary" type="submit" formaction="/delivery/send">{tm('check')}</button>
                <Submit>{tm('send')}</Submit>
              </FormActions>
            </>
          )}
        </Form>
      )}
    </>
  );
}

function outcomeView(tm: ReturnType<typeof sm>, o: SendOutcome): { tone: Tone; text: string } {
  switch (o.outcome) {
    case 'sent':
      return { tone: 'success', text: tm('outcome.sent') };
    case 'awaiting_validation':
      return { tone: 'warning', text: tm(`outcome.awaiting.${o.reason}`) };
    case 'rejected':
      return { tone: 'danger', text: `${tm('outcome.rejected')} : ${o.detail}` };
    case 'uncertain':
      return { tone: 'warning', text: tm('outcome.uncertain') };
    case 'refused':
      return { tone: 'danger', text: problemText(tm, o.code) };
    case 'not_attempted':
      return { tone: 'neutral', text: tm(`outcome.not_attempted.${o.reason}`) };
  }
}

export function SendResultsPage(props: { results: readonly SendOutcome[]; backHref: string }) {
  const tm = sm(useUi().lang);
  return (
    <>
      <Table
        caption={tm('results.caption')}
        rows={props.results}
        rowKey={(o) => o.ref}
        stack
        columns={[
          { key: 'ref', header: tm('col.order'), cell: (o) => <a href={`/orders/${o.ref}`}><Bdi>{o.ref}</Bdi></a> },
          {
            key: 'result',
            header: tm('col.result'),
            cell: (o) => {
              const v = outcomeView(tm, o);
              return <StatusBadge tone={v.tone} label={v.text} />;
            },
          },
          { key: 'tracking', header: tm('col.tracking'), cell: (o) => ('tracking' in o ? <Bdi ltr>{o.tracking}</Bdi> : null) },
          { key: 'waybill', header: tm('col.waybill'), cell: (o) => ('tracking' in o ? <a href={`/delivery/shipments/${o.shipmentId}/waybill`}>{tm('waybill.open')}</a> : null) },
        ]}
      />
      <p><a class="btn btn--secondary" href={props.backHref}>{tm('back')}</a></p>
    </>
  );
}
