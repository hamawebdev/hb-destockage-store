// /fees views (ACAT-4). Owners get an editable 69-row table (kit fields, idSuffix = wilaya code;
// a stacking table: cards below 600 px); confirmer/logistics get the same table as text.
import { useUi } from '../../ui/context.ts';
import { StatusBadge } from '../../ui/badge.tsx';
import { DateTime, Money } from '../../ui/format.tsx';
import { Checkbox, ErrorSummary, Form, FormActions, MoneyInput, Select, Submit, TextInput, type FieldErrors, type FormValues } from '../../ui/form.tsx';
import { Table } from '../../ui/table.tsx';
import type { Change } from './core.ts';
import type { FeeTableRow } from './data.ts';
import { m } from './messages.ts';

const nameOf = (r: { nameFr: string; nameAr: string }, lang: 'fr' | 'ar') => (lang === 'ar' ? r.nameAr : r.nameFr);
const other = (lang: 'fr' | 'ar') => (lang === 'ar' ? 'fr' : 'ar');

function WilayaCell(props: { r: FeeTableRow }) {
  const { lang } = useUi();
  const o = other(lang);
  return (
    <>
      {nameOf(props.r, lang)}
      <br />
      <span lang={o} dir={o === 'ar' ? 'rtl' : 'ltr'} class="muted">{nameOf(props.r, o)}</span>
    </>
  );
}

function Placeholder(props: { r: FeeTableRow }) {
  const tm = m(useUi().lang);
  return props.r.fee?.placeholder ? <StatusBadge tone="warning" label={tm('placeholder.badge')} /> : null;
}

export function Notes(props: { placeholders: number }) {
  const tm = m(useUi().lang);
  return (
    <>
      {props.placeholders > 0 ? (
        <div class="callout callout--warning" role="status">
          <p><strong>{tm('placeholder.banner', { count: props.placeholders })}</strong></p>
        </div>
      ) : null}
      <p class="callout">{tm('note.orders')} {tm('note.storefront')}</p>
    </>
  );
}

export function FeeTableReadonly(props: { rows: readonly FeeTableRow[] }) {
  const { lang } = useUi();
  const tm = m(lang);
  return (
    <>
      <p class="callout">{tm('readonly')}</p>
      <Table
        stack
        caption={tm('caption')}
        rows={props.rows}
        rowKey={(r) => r.code}
        columns={[
          { key: 'code', header: tm('col.code'), numeric: true, cell: (r) => r.code },
          { key: 'wilaya', header: tm('col.wilaya'), cell: (r) => <WilayaCell r={r} /> },
          { key: 'fee', header: tm('col.fee'), numeric: true, cell: (r) => (r.fee === null ? tm('notSet') : <><Money dzd={r.fee.feeDzd} /> <Placeholder r={r} /></>) },
          { key: 'available', header: tm('col.available'), cell: (r) => (r.fee?.available ? '✓' : '—') },
        ]}
      />
    </>
  );
}

export function FeeForm(props: { rows: readonly FeeTableRow[]; values: FormValues; errors?: FieldErrors | undefined }) {
  const { lang, t } = useUi();
  const tm = m(lang);
  const checked = (k: string) => props.values[k] !== undefined && props.values[k] !== '';
  return (
    <Form action="/fees/preview">
      <ErrorSummary errors={props.errors} />
      <p>
        {tm('quick')} <a href="/fees?sel=all">{tm('quick.all')}</a> · <a href="/fees">{tm('quick.none')}</a> · <a href="/fees?sel=notset">{tm('quick.notSet')}</a> ·{' '}
        <a href="/fees?sel=placeholder">{tm('quick.placeholder')}</a>
      </p>
      <Table
        stack
        caption={tm('caption')}
        rows={props.rows}
        rowKey={(r) => r.code}
        columns={[
          { key: 'code', header: tm('col.code'), numeric: true, cell: (r) => r.code },
          { key: 'wilaya', header: tm('col.wilaya'), cell: (r) => <><WilayaCell r={r} /> <Placeholder r={r} /></> },
          {
            key: 'fee',
            header: tm('col.fee'),
            cell: (r) => (
              <>
                <input type="hidden" name={`v_${r.code}`} value={props.values[`v_${r.code}`] ?? ''} />
                <MoneyInput name={`fee_${r.code}`} label={`${tm('col.fee')} — ${r.code}`} hint={r.fee === null ? tm('notSet') : undefined} value={props.values[`fee_${r.code}`]} error={props.errors?.[`fee_${r.code}`]} />
              </>
            ),
          },
          { key: 'available', header: tm('col.available'), cell: (r) => <Checkbox name={`avail_${r.code}`} label={`${tm('col.available')} — ${r.code}`} checked={checked(`avail_${r.code}`)} /> },
          {
            key: 'confirm',
            header: tm('col.confirm'),
            cell: (r) => (r.fee?.placeholder ? <Checkbox name={`confirm_${r.code}`} label={`${tm('col.confirm')} — ${r.code}`} checked={checked(`confirm_${r.code}`)} /> : null),
          },
          { key: 'select', header: tm('col.select'), cell: (r) => <Checkbox name={`sel_${r.code}`} label={`${tm('col.select')} — ${r.code}`} checked={checked(`sel_${r.code}`)} /> },
          {
            key: 'updated',
            header: tm('col.updated'),
            cell: (r) => (r.fee === null ? '—' : <><DateTime ms={r.fee.updatedAt} />{r.fee.updatedByEmail ? <> · <bdi dir="ltr">{r.fee.updatedByEmail}</bdi></> : null}</>),
          },
        ]}
      />
      <fieldset class="localized">
        <legend class="localized__legend">{tm('bulk.title')}</legend>
        <TextInput name="range" label={tm('bulk.range')} value={props.values['range']} error={props.errors?.['range']} dir="ltr" maxlength={200} />
        <MoneyInput name="bulk_fee" label={tm('bulk.fee')} value={props.values['bulk_fee']} error={props.errors?.['bulk_fee']} />
        <Select
          name="bulk_avail"
          label={tm('bulk.available')}
          value={props.values['bulk_avail'] ?? ''}
          options={[
            { value: '', label: tm('bulk.keep') },
            { value: 'on', label: tm('bulk.on') },
            { value: 'off', label: tm('bulk.off') },
          ]}
        />
        <Checkbox name="bulk_confirm" label={tm('bulk.confirm')} checked={checked('bulk_confirm')} />
      </fieldset>
      <FormActions>
        <Submit>{tm('preview')}</Submit>
        <a class="btn btn--secondary" href="/fees">{t('common.cancel')}</a>
      </FormActions>
    </Form>
  );
}

export interface SampleQuote {
  wilaya: string;
  product: string;
  now: { feeDzd: number | null; totalDzd: number | null };
  after: { feeDzd: number | null; totalDzd: number | null };
}

function ChangeTable(props: { changes: readonly Change[]; names: ReadonlyMap<number, FeeTableRow> }) {
  const { lang } = useUi();
  const tm = m(lang);
  const fee = (f: { feeDzd: number; available: boolean } | null) => (f === null ? tm('notSet') : <><Money dzd={f.feeDzd} />{f.available ? '' : ` (${tm('col.available')} : —)`}</>);
  return (
    <Table
      stack
      caption={tm('preview.title')}
      rows={props.changes}
      rowKey={(ch) => ch.code}
      columns={[
        { key: 'code', header: tm('col.code'), numeric: true, cell: (ch) => ch.code },
        { key: 'wilaya', header: tm('col.wilaya'), cell: (ch) => { const r = props.names.get(ch.code); return r ? nameOf(r, lang) : String(ch.code); } },
        { key: 'before', header: tm('preview.before'), cell: (ch) => fee(ch.before) },
        { key: 'after', header: tm('preview.after'), cell: (ch) => fee(ch.after) },
        {
          key: 'check',
          header: tm('preview.check'),
          cell: (ch) => (
            <>
              {ch.toZero ? <StatusBadge tone="warning" label={tm('preview.toZero')} /> : null}
              {ch.riseOver3x ? <StatusBadge tone="warning" label={tm('preview.rise')} /> : null}
            </>
          ),
        },
      ]}
    />
  );
}

export function PreviewPage(props: { changes: readonly Change[]; names: ReadonlyMap<number, FeeTableRow>; hidden: Record<string, string>; sample: SampleQuote | null }) {
  const { lang } = useUi();
  const tm = m(lang);
  const confirmed = props.changes.filter((ch) => ch.confirmed);
  const others = props.changes.filter((ch) => !ch.confirmed);
  return (
    <>
      <p><strong>{props.changes.length === 0 ? tm('preview.none') : tm('preview.count', { count: props.changes.length })}</strong></p>
      <p class="callout">{tm('note.orders')} {tm('note.storefront')}</p>
      {confirmed.length > 0 ? (
        <section aria-labelledby="sec-confirmed">
          <h2 id="sec-confirmed">{tm('preview.confirmed')}</h2>
          <ChangeTable changes={confirmed} names={props.names} />
        </section>
      ) : null}
      {others.length > 0 ? <ChangeTable changes={others} names={props.names} /> : null}
      {props.sample ? (
        <p>
          {tm('preview.sample', { wilaya: props.sample.wilaya, product: props.sample.product })} — {tm('preview.sampleNow')} :{' '}
          {props.sample.now.totalDzd === null ? tm('quote.unavailable') : <Money dzd={props.sample.now.totalDzd} />} · {tm('preview.sampleAfter')} :{' '}
          {props.sample.after.totalDzd === null ? tm('quote.unavailable') : <Money dzd={props.sample.after.totalDzd} />}
        </p>
      ) : null}
      <Form action="/fees/apply">
        {Object.entries(props.hidden).map(([k, v]) => (
          <input type="hidden" name={k} value={v} />
        ))}
        <FormActions>
          {props.changes.length > 0 ? <Submit>{tm('preview.apply')}</Submit> : null}
          <a class="btn btn--secondary" href="/fees">{tm('preview.back')}</a>
        </FormActions>
      </Form>
    </>
  );
}

export function QuotePage(props: {
  variants: readonly { value: string; label: string }[];
  wilayas: readonly { value: string; label: string }[];
  values: Record<string, string>;
  result: { available: boolean; subtotalDzd: number; feeDzd: number | null; totalDzd: number | null; source: string } | null;
}) {
  const { lang } = useUi();
  const tm = m(lang);
  return (
    <>
      <Form action="/fees/quote" method="get">
        <Select name="variant" label={tm('quote.variant')} value={props.values['variant']} options={props.variants} />
        <TextInput name="qty" label={tm('quote.qty')} value={props.values['qty'] ?? '1'} inputmode="numeric" dir="ltr" maxlength={2} />
        <Select name="wilaya" label={tm('quote.wilaya')} value={props.values['wilaya']} options={props.wilayas} />
        <FormActions>
          <Submit variant="secondary">{tm('quote.go')}</Submit>
        </FormActions>
      </Form>
      {props.result ? (
        <dl class="details" role="status">
          <dt>{tm('quote.subtotal')}</dt>
          <dd><Money dzd={props.result.subtotalDzd} /></dd>
          <dt>{tm('quote.fee')}</dt>
          <dd>{props.result.feeDzd === null ? tm('quote.unavailable') : <Money dzd={props.result.feeDzd} />}</dd>
          <dt>{tm('quote.total')}</dt>
          <dd>{props.result.totalDzd === null ? '—' : <Money dzd={props.result.totalDzd} />}</dd>
          <dt>{tm('quote.sourceLabel')}</dt>
          <dd><bdi dir="ltr">{props.result.source}</bdi></dd>
        </dl>
      ) : null}
    </>
  );
}
