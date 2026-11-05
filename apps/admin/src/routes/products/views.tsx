// Product pages (ACAT-2). Server-rendered with admin-core's UI kit; no JS, no inline style.
import type { Category } from '@hb/db';
import { productPath } from '@hb/catalog';
import { useUi } from '../../ui/context.ts';
import { StatusBadge, type Tone } from '../../ui/badge.tsx';
import { Bdi, Money, Num } from '../../ui/format.tsx';
import {
  Checkbox,
  ErrorSummary,
  Form,
  FormActions,
  LocalizedField,
  MoneyInput,
  NumberInput,
  Select,
  Submit,
  TextInput,
  type FieldErrors,
  type FormValues,
} from '../../ui/form.tsx';
import { Pagination } from '../../ui/pagination.tsx';
import { Table, type Column } from '../../ui/table.tsx';
import { orderTree } from '../categories/tree.ts';
import { fieldMessages } from './lib/field-messages.ts';
import type { MatrixPlan } from './lib/matrix.ts';
import { MAX_ORDER_TOTAL_DZD, orderCeiling } from './lib/money.ts';
import { m } from './messages.ts';
import type { ActivationIssue, ListRow, ProductAggregate } from './data.ts';
import { LIMITS, MAX_VALUE_ROWS } from './validate.ts';

const STATUS_TONE: Record<string, Tone> = { draft: 'neutral', active: 'success', archived: 'warning' };

function categoryOptions(cats: readonly Category[], lang: 'fr' | 'ar') {
  return orderTree(cats).map((o) => ({ value: String(o.node.id), label: '— '.repeat(o.depth) + (lang === 'ar' ? o.node.nameAr : o.node.nameFr) }));
}

function StatusBadges(props: { status: string; placeholder: boolean }) {
  const { lang } = useUi();
  const tm = m(lang);
  const tf = fieldMessages(lang);
  return (
    <>
      <StatusBadge tone={STATUS_TONE[props.status] ?? 'neutral'} label={tm(`status.${props.status}` as 'status.draft')} />
      {props.placeholder ? <> <StatusBadge tone="warning" label={tf('common.placeholder')} /></> : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

export function ProductList(props: {
  rows: readonly ListRow[];
  categories: readonly Category[];
  filters: Record<string, string>;
  page: number;
  pages: number;
  baseUrl: string;
}) {
  const { lang, t } = useUi();
  const tm = m(lang);
  const all = { value: '', label: tm('filter.all') };
  const columns: Column<ListRow>[] = [
    {
      key: 'name',
      header: tm('col.name'),
      cell: (r) => (
        <>
          <a href={`/products/${r.id}`}>{lang === 'ar' ? r.nameAr : r.nameFr}</a>
          {r.brandLatin ? <> <bdi lang="fr" dir="ltr">{r.brandLatin}</bdi></> : null}
        </>
      ),
    },
    { key: 'kind', header: tm('col.kind'), cell: (r) => tm(`kind.${r.kind}`) },
    { key: 'category', header: tm('col.category'), cell: (r) => (lang === 'ar' ? r.categoryNameAr : r.categoryNameFr) },
    {
      key: 'price',
      header: tm('col.price'),
      numeric: true,
      cell: (r) =>
        r.minPrice === null ? t('common.none') : r.minPrice === r.maxPrice ? <Money dzd={r.minPrice} /> : <><Money dzd={r.minPrice} /> – <Money dzd={r.maxPrice ?? r.minPrice} /></>,
    },
    { key: 'stock', header: tm('col.stock'), numeric: true, cell: (r) => (r.trackedStock === null ? t('common.none') : <Num value={r.trackedStock} />) },
    { key: 'status', header: tm('col.status'), cell: (r) => <StatusBadges status={r.status} placeholder={r.placeholder} /> },
  ];
  return (
    <>
      <Form action="/products" method="get" class="form form--filters">
        <TextInput name="q" type="search" label={tm('filter.q')} value={props.filters['q']} maxlength={100} />
        <Select name="category" label={tm('filter.category')} value={props.filters['category']} options={[all, ...categoryOptions(props.categories, lang)]} />
        <Select
          name="status"
          label={tm('filter.status')}
          value={props.filters['status']}
          options={[all, ...(['draft', 'active', 'archived'] as const).map((s) => ({ value: s, label: tm(`status.${s}`) }))]}
        />
        <Select
          name="kind"
          label={tm('filter.kind')}
          value={props.filters['kind']}
          options={[all, ...(['simple', 'variable', 'pack'] as const).map((k) => ({ value: k, label: tm(`kind.${k}`) }))]}
        />
        <FormActions>
          <Submit variant="secondary">{t('common.filter')}</Submit>
          <a class="btn btn--quiet" href="/products">{t('common.reset')}</a>
        </FormActions>
      </Form>
      <Table caption={tm('caption')} columns={columns} rows={props.rows} rowKey={(r) => r.id} empty={tm('empty')} />
      <Pagination page={props.page} pages={props.pages} baseUrl={props.baseUrl} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Details (create + edit)
// ---------------------------------------------------------------------------------------------

function DetailsFields(props: { values: FormValues; errors?: FieldErrors | undefined; categories: readonly Category[] }) {
  const { lang } = useUi();
  const tm = m(lang);
  const tf = fieldMessages(lang);
  const checked = (n: string) => props.values[n] !== undefined && props.values[n] !== '';
  return (
    <>
      <Select
        name="category_id"
        label={tm('field.category')}
        required
        value={props.values['category_id']}
        error={props.errors?.['category_id']}
        placeholder="—"
        options={categoryOptions(props.categories, lang)}
      />
      <LocalizedField name="name" label={tm('field.name')} values={props.values} errors={props.errors} maxlength={LIMITS.name} required />
      <TextInput name="brand_latin" label={tm('field.brand')} hint={tm('field.brandHint')} value={props.values['brand_latin']} error={props.errors?.['brand_latin']} dir="ltr" lang="fr" maxlength={LIMITS.brand} />
      <LocalizedField name="summary" label={tm('field.summary')} values={props.values} errors={props.errors} maxlength={LIMITS.summary} />
      <LocalizedField name="description" label={tm('field.description')} values={props.values} errors={props.errors} maxlength={LIMITS.description} multiline />
      <TextInput name="slug_fr" label={tm('field.slugFr')} hint={tf('common.slugHint')} value={props.values['slug_fr']} error={props.errors?.['slug_fr']} dir="ltr" maxlength={80} />
      <TextInput name="slug_ar" label={tm('field.slugAr')} hint={tf('common.slugHint')} value={props.values['slug_ar']} error={props.errors?.['slug_ar']} dir="ltr" maxlength={80} />
      <NumberInput name="sort" label={tm('field.sort')} value={props.values['sort']} error={props.errors?.['sort']} />
      <Checkbox name="placeholder" label={tf('common.placeholder')} hint={tf('common.placeholderHint')} checked={checked('placeholder')} />
      <Checkbox name="tp_fr" label={tf('common.translationPlaceholderFr')} checked={checked('tp_fr')} />
      <Checkbox name="tp_ar" label={tf('common.translationPlaceholderAr')} checked={checked('tp_ar')} />
    </>
  );
}

export function CreateForm(props: { values: FormValues; errors?: FieldErrors | undefined; categories: readonly Category[] }) {
  const { lang, t } = useUi();
  const tm = m(lang);
  return (
    <Form action="/products">
      <ErrorSummary errors={props.errors} />
      <Select
        name="kind"
        label={tm('field.kind')}
        hint={tm('field.kindHint')}
        value={props.values['kind'] ?? 'simple'}
        error={props.errors?.['kind']}
        options={[
          { value: 'simple', label: tm('kind.simple') },
          { value: 'variable', label: tm('kind.variable') },
          { value: 'pack', label: tm('kind.pack') },
        ]}
      />
      <DetailsFields values={props.values} errors={props.errors} categories={props.categories} />
      <TextInput name="sku" label={tm('field.baseSku')} hint={tm('field.baseSkuHint')} value={props.values['sku']} error={props.errors?.['sku']} dir="ltr" maxlength={40} required />
      <MoneyInput name="price" label={tm('field.price')} value={props.values['price']} error={props.errors?.['price']} required />
      <MoneyInput name="compare_at" label={tm('field.compareAt')} hint={tm('field.compareAtHint')} value={props.values['compare_at']} error={props.errors?.['compare_at']} />
      <NumberInput name="stock" label={tm('field.stock')} hint={tm('field.stockHint')} value={props.values['stock']} error={props.errors?.['stock']} />
      <NumberInput name="weight" label={tm('field.weight')} value={props.values['weight']} error={props.errors?.['weight']} />
      <FormActions>
        <Submit>{t('common.create')}</Submit>
        <a class="btn btn--secondary" href="/products">{t('common.cancel')}</a>
      </FormActions>
    </Form>
  );
}

export function DetailsForm(props: {
  id: number;
  values: FormValues;
  errors?: FieldErrors | undefined;
  categories: readonly Category[];
  slugWarning?: readonly string[] | undefined;
}) {
  const { lang, t } = useUi();
  const tm = m(lang);
  return (
    <section aria-labelledby="sec-details">
      <h2 id="sec-details">{tm('section.details')}</h2>
      <Form action={`/products/${props.id}`}>
        <ErrorSummary errors={props.errors} />
        {props.slugWarning ? (
          <div class="callout callout--warning" role="alert">
            <p><strong>{tm('slugChange.title')}</strong></p>
            <p>{tm('slugChange.body')}</p>
            <ul>
              {props.slugWarning.map((u) => (
                <li><Bdi ltr>{u}</Bdi></li>
              ))}
            </ul>
            <Checkbox name="confirm_slug_change" label={tm('slugChange.confirm')} />
          </div>
        ) : null}
        <input type="hidden" name="v" value={props.values['v'] ?? ''} />
        <DetailsFields values={props.values} errors={props.errors} categories={props.categories} />
        <FormActions>
          <Submit>{t('common.save')}</Submit>
        </FormActions>
      </Form>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Options (+ matrix preview)
// ---------------------------------------------------------------------------------------------

/** Form values for the options editor, from the aggregate (existing rows first, blanks after). */
export function optionValuesOf(agg: ProductAggregate, baseSku: string): Record<string, string> {
  const out: Record<string, string> = { v: String(agg.product.updatedAt), base_sku: baseSku };
  agg.options.forEach((o, i) => {
    out[`o${i}_id`] = String(o.id);
    out[`o${i}_kind`] = o.kind;
    out[`o${i}_name_fr`] = o.nameFr;
    out[`o${i}_name_ar`] = o.nameAr;
    o.values.forEach((x, j) => {
      out[`o${i}v${j}_id`] = String(x.id);
      out[`o${i}v${j}_fr`] = x.valueFr;
      out[`o${i}v${j}_ar`] = x.valueAr;
      if (x.swatchHex) out[`o${i}v${j}_hex`] = x.swatchHex;
    });
  });
  return out;
}

function countRows(values: FormValues, prefix: string, max: number): number {
  let n = 0;
  for (let j = 0; j < max; j++) if (values[`${prefix}${j}_id`] || values[`${prefix}${j}_fr`] || values[`${prefix}${j}_ar`]) n = j + 1;
  return n;
}

export function OptionsForm(props: { id: number; values: FormValues; errors?: FieldErrors | undefined; maxOptions: number }) {
  const { lang, t } = useUi();
  const tm = m(lang);
  const err = (k: string) => props.errors?.[k];
  let existing = 0;
  for (let i = 0; i < props.maxOptions; i++) if (props.values[`o${i}_id`] || props.values[`o${i}_name_fr`]) existing = i + 1;
  const optionRows = Math.min(existing + 1, props.maxOptions);
  return (
    <section aria-labelledby="sec-options">
      <h2 id="sec-options">{tm('section.options')}</h2>
      <p class="muted">{tm('opt.help')}</p>
      <Form action={`/products/${props.id}/options`}>
        <ErrorSummary errors={props.errors} />
        <input type="hidden" name="v" value={props.values['v'] ?? ''} />
        <TextInput name="base_sku" label={tm('field.baseSku')} hint={tm('field.baseSkuHint')} value={props.values['base_sku']} error={err('base_sku')} dir="ltr" maxlength={40} required />
        {Array.from({ length: optionRows }, (_, i) => {
          const id = props.values[`o${i}_id`];
          const isNew = !id;
          const valueRows = Math.min(countRows(props.values, `o${i}v`, MAX_VALUE_ROWS) + 2, MAX_VALUE_ROWS);
          return (
            <fieldset class="localized">
              <legend class="localized__legend">{isNew ? tm('opt.newOption') : `${tm('opt.name')} ${i + 1}`}</legend>
              {id ? <input type="hidden" name={`o${i}_id`} value={id} /> : null}
              {isNew ? (
                <Select
                  name={`o${i}_kind`}
                  label={tm('opt.kind')}
                  value={props.values[`o${i}_kind`] ?? 'size'}
                  error={err(`o${i}_kind`)}
                  options={(['size', 'colour', 'other'] as const).map((k) => ({ value: k, label: tm(`opt.kind.${k}`) }))}
                />
              ) : (
                <>
                  <input type="hidden" name={`o${i}_kind`} value={props.values[`o${i}_kind`] ?? 'other'} />
                  <p>{tm('opt.kind')} : {tm(`opt.kind.${(props.values[`o${i}_kind`] ?? 'other') as 'size'}`)}</p>
                </>
              )}
              <TextInput name={`o${i}_name_fr`} label={`${tm('opt.name')} (${t('common.fr')})`} value={props.values[`o${i}_name_fr`]} error={err(`o${i}_name_fr`)} dir="ltr" lang="fr" maxlength={LIMITS.optionName} />
              <TextInput name={`o${i}_name_ar`} label={`${tm('opt.name')} (${t('common.ar')})`} value={props.values[`o${i}_name_ar`]} error={err(`o${i}_name_ar`)} dir="rtl" lang="ar" maxlength={LIMITS.optionName} />
              {id ? <Checkbox name={`o${i}_remove`} label={tm('opt.remove')} /> : null}
              {Array.from({ length: valueRows }, (_, j) => {
                const k = `o${i}v${j}`;
                const vid = props.values[`${k}_id`];
                return (
                  <div class="localized__pair">
                    {vid ? <input type="hidden" name={`${k}_id`} value={vid} /> : null}
                    <TextInput name={`${k}_fr`} label={`${vid ? tm('opt.value') : tm('opt.newValue')} ${j + 1} (${t('common.fr')})`} value={props.values[`${k}_fr`]} error={err(`${k}_fr`)} dir="ltr" lang="fr" maxlength={LIMITS.value} />
                    <TextInput name={`${k}_ar`} label={`${vid ? tm('opt.value') : tm('opt.newValue')} ${j + 1} (${t('common.ar')})`} value={props.values[`${k}_ar`]} error={err(`${k}_ar`)} dir="rtl" lang="ar" maxlength={LIMITS.value} />
                    <TextInput name={`${k}_hex`} label={tm('opt.swatch')} value={props.values[`${k}_hex`]} error={err(`${k}_hex`)} dir="ltr" maxlength={7} pattern="#[0-9a-fA-F]{6}" />
                    {vid ? <Checkbox name={`${k}_remove`} label={tm('opt.remove')} /> : null}
                  </div>
                );
              })}
            </fieldset>
          );
        })}
        <FormActions>
          <Submit>{tm('opt.save')}</Submit>
        </FormActions>
      </Form>
    </section>
  );
}

/** Preview of the generator's plan; Apply re-posts the same options form (re-validated server-side). */
export function MatrixPreview(props: { id: number; values: Record<string, string>; plan: MatrixPlan | null; toSimple: boolean; deletedSkus: readonly string[] }) {
  const { lang, t } = useUi();
  const tm = m(lang);
  const created = props.plan?.rows.filter((r) => r.kind === 'create') ?? [];
  const kept = props.plan?.rows.filter((r) => r.kind === 'keep') ?? [];
  return (
    <Form action={`/products/${props.id}/options/apply`}>
      {Object.entries(props.values).map(([k, v]) => (
        <input type="hidden" name={k} value={v} />
      ))}
      <ul>
        <li>{tm('matrix.kept', { count: kept.length })}</li>
        <li>{tm('matrix.created', { count: created.length })}</li>
        <li>{tm('matrix.deleted', { count: props.deletedSkus.length })}</li>
      </ul>
      {created.length > 0 ? (
        <>
          <ul>
            {created.map((r) => (
              <li><Bdi ltr>{r.kind === 'create' ? r.sku : ''}</Bdi></li>
            ))}
          </ul>
          <p>{tm('matrix.newPrice')}</p>
        </>
      ) : null}
      {props.deletedSkus.length > 0 ? (
        <div class="callout callout--warning">
          <p><strong>{tm('matrix.deleted', { count: props.deletedSkus.length })}</strong></p>
          <ul>
            {props.deletedSkus.map((s) => (
              <li><Bdi ltr>{s}</Bdi></li>
            ))}
          </ul>
        </div>
      ) : null}
      <FormActions>
        <Submit>{tm('matrix.apply')}</Submit>
        <a class="btn btn--secondary" href={`/products/${props.id}#sec-options`}>{t('common.cancel')}</a>
      </FormActions>
    </Form>
  );
}

// ---------------------------------------------------------------------------------------------
// Variant grid
// ---------------------------------------------------------------------------------------------

export function gridValuesOf(agg: ProductAggregate): Record<string, string> {
  const out: Record<string, string> = {};
  for (const x of agg.variants) {
    out[`sku_${x.id}`] = x.sku;
    out[`price_${x.id}`] = String(x.priceDzd);
    out[`compare_${x.id}`] = x.compareAtDzd === null ? '' : String(x.compareAtDzd);
    out[`stock_${x.id}`] = x.stock === null ? '' : String(x.stock);
    out[`stockwas_${x.id}`] = x.stock === null ? '' : String(x.stock);
    out[`weight_${x.id}`] = x.weightG === null ? '' : String(x.weightG);
    if (x.active) out[`active_${x.id}`] = '1';
    out[`ver_${x.id}`] = String(x.updatedAt);
    if (x.isDefault) out['default'] = String(x.id);
  }
  return out;
}

/** Warns when a saved price runs into the order ceiling (the order flow refuses larger totals). */
function CeilingWarning(props: { price: number }) {
  const { lang } = useUi();
  const tm = m(lang);
  const r = orderCeiling(props.price);
  if (r.kind === 'ok') return null;
  return (
    <p class="field__hint">
      <strong>⚠ </strong>
      {r.kind === 'unorderable' ? tm('warn.unorderable', { max: MAX_ORDER_TOTAL_DZD }) : tm('warn.maxQty', { count: r.maxQty })}
    </p>
  );
}

export function VariantGrid(props: { agg: ProductAggregate; values: FormValues; errors?: FieldErrors | undefined }) {
  const { lang } = useUi();
  const tm = m(lang);
  const valueName = new Map(props.agg.options.flatMap((o) => o.values.map((x) => [x.id, lang === 'ar' ? x.valueAr : x.valueFr] as const)));
  const label = (vid: number, field: string) => `${field} — ${props.values[`sku_${vid}`] ?? ''}`;
  const cell = (name: string, aria: string, opts: { inputmode?: 'numeric'; maxlength: number }) => {
    const error = props.errors?.[name];
    return (
      <>
        <input
          class="input"
          id={`f-${name}`}
          name={name}
          value={props.values[name] ?? ''}
          dir="ltr"
          inputmode={opts.inputmode}
          maxlength={opts.maxlength}
          aria-label={aria}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `f-${name}-err` : undefined}
        />
        {error ? <p class="field__error" id={`f-${name}-err`}>{error}</p> : null}
      </>
    );
  };
  return (
    <section aria-labelledby="sec-variants">
      <h2 id="sec-variants">{tm('section.variants')}</h2>
      <Form action={`/products/${props.agg.product.id}/variants`}>
        <ErrorSummary errors={props.errors} />
        <div class="table-wrap" role="region" aria-label={tm('var.caption')} tabindex={0}>
          <table class="table">
            <caption class="table__caption">{tm('var.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{tm('var.combination')}</th>
                <th scope="col">SKU</th>
                <th scope="col">{tm('field.price')}</th>
                <th scope="col">{tm('field.compareAt')}</th>
                <th scope="col">{tm('field.stock')}</th>
                <th scope="col">{tm('field.weight')}</th>
                <th scope="col">{tm('var.active')}</th>
                <th scope="col">{tm('var.default')}</th>
              </tr>
            </thead>
            <tbody>
              {props.agg.variants.map((x) => (
                <tr>
                  <th scope="row">{x.links.length === 0 ? '—' : x.links.map((l) => valueName.get(l.valueId) ?? '?').join(' / ')}</th>
                  <td>{cell(`sku_${x.id}`, label(x.id, 'SKU'), { maxlength: 40 })}</td>
                  <td>
                    {cell(`price_${x.id}`, label(x.id, tm('field.price')), { inputmode: 'numeric', maxlength: 12 })}
                    <CeilingWarning price={x.priceDzd} />
                  </td>
                  <td>{cell(`compare_${x.id}`, label(x.id, tm('field.compareAt')), { inputmode: 'numeric', maxlength: 12 })}</td>
                  <td>
                    {cell(`stock_${x.id}`, label(x.id, tm('field.stock')), { inputmode: 'numeric', maxlength: 8 })}
                    <input type="hidden" name={`stockwas_${x.id}`} value={props.values[`stockwas_${x.id}`] ?? ''} />
                  </td>
                  <td>{cell(`weight_${x.id}`, label(x.id, tm('field.weight')), { inputmode: 'numeric', maxlength: 6 })}</td>
                  <td>
                    <input type="checkbox" class="check" name={`active_${x.id}`} value="1" checked={Boolean(props.values[`active_${x.id}`])} aria-label={label(x.id, tm('var.active'))} />
                  </td>
                  <td>
                    <input type="radio" class="check" name="default" value={String(x.id)} checked={props.values['default'] === String(x.id)} aria-label={label(x.id, tm('var.default'))} />
                    <input type="hidden" name={`ver_${x.id}`} value={props.values[`ver_${x.id}`] ?? ''} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <FormActions>
          <Submit>{tm('var.save')}</Submit>
        </FormActions>
      </Form>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Status, read-only, delete
// ---------------------------------------------------------------------------------------------

export function StatusSection(props: { agg: ProductAggregate; issues?: readonly ActivationIssue[] | undefined }) {
  const { lang } = useUi();
  const tm = m(lang);
  const p = props.agg.product;
  const button = (to: 'active' | 'draft' | 'archived', label: string) => (
    <Form action={`/products/${p.id}/status`} class="inline-form">
      <input type="hidden" name="to" value={to} />
      <input type="hidden" name="v" value={String(p.updatedAt)} />
      <Submit variant={to === 'active' ? 'primary' : 'secondary'}>{label}</Submit>
    </Form>
  );
  return (
    <section class="panel" aria-labelledby="sec-status">
      <h2 id="sec-status">{tm('section.status')}</h2>
      <p>{tm('status.current', { status: tm(`status.${p.status}`) })}</p>
      {props.issues && props.issues.length > 0 ? (
        <div class="callout callout--warning" role="alert" tabindex={-1}>
          <p><strong>{tm('status.activateFailed')}</strong></p>
          <ul>
            {props.issues.map((i) => (
              <li>{i.rule === 'integrity' ? tm('status.rule.integrity', { detail: i.detail }) : tm(`status.rule.${i.rule}`)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {p.status !== 'active' ? button('active', tm('status.activate')) : null}
      {p.status !== 'draft' ? button('draft', tm('status.toDraft')) : null}
      {p.status !== 'archived' ? button('archived', tm('status.archive')) : null}
      <p class="muted">{tm('status.publishNote')}</p>
      <p>
        <a class="btn btn--danger" href={`/products/${p.id}/delete`}>{tm('delete')}</a>
      </p>
    </section>
  );
}

export function ProductReadonly(props: { agg: ProductAggregate; categoryName: string }) {
  const { lang, t } = useUi();
  const tm = m(lang);
  const p = props.agg.product;
  const valueName = new Map(props.agg.options.flatMap((o) => o.values.map((x) => [x.id, lang === 'ar' ? x.valueAr : x.valueFr] as const)));
  return (
    <>
      <p class="callout">{tm('readonly')}</p>
      <dl class="details">
        <dt>{tm('field.name')} ({t('common.fr')})</dt>
        <dd lang="fr" dir="ltr">{p.nameFr}</dd>
        <dt>{tm('field.name')} ({t('common.ar')})</dt>
        <dd lang="ar" dir="rtl">{p.nameAr}</dd>
        {p.brandLatin ? <><dt>{tm('field.brand')}</dt><dd><bdi lang="fr" dir="ltr">{p.brandLatin}</bdi></dd></> : null}
        <dt>{tm('field.category')}</dt>
        <dd>{props.categoryName}</dd>
        <dt>{tm('col.status')}</dt>
        <dd><StatusBadges status={p.status} placeholder={p.placeholder} /></dd>
      </dl>
      <Table
        caption={tm('var.caption')}
        rowKey={(x) => x.id}
        rows={props.agg.variants}
        columns={[
          { key: 'combo', header: tm('var.combination'), cell: (x) => (x.links.length === 0 ? '—' : x.links.map((l) => valueName.get(l.valueId) ?? '?').join(' / ')) },
          { key: 'sku', header: 'SKU', cell: (x) => <Bdi ltr>{x.sku}</Bdi> },
          { key: 'price', header: tm('field.price'), numeric: true, cell: (x) => <Money dzd={x.priceDzd} /> },
          { key: 'stock', header: tm('field.stock'), numeric: true, cell: (x) => (x.stock === null ? t('common.none') : <Num value={x.stock} />) },
          { key: 'active', header: tm('var.active'), cell: (x) => (x.active ? t('common.yes') : t('common.no')) },
        ]}
      />
    </>
  );
}

export function DeletePage(props: { agg: ProductAggregate; referenced: boolean }) {
  const { lang, t } = useUi();
  const tm = m(lang);
  const p = props.agg.product;
  return (
    <>
      <p>
        <strong>{lang === 'ar' ? p.nameAr : p.nameFr}</strong>
      </p>
      {props.referenced ? (
        <p class="callout callout--warning" role="alert">{tm('delete.blocked')}</p>
      ) : (
        <Form action={`/products/${p.id}/delete`}>
          <p>{tm('delete.confirm')}</p>
          <FormActions>
            <Submit variant="danger">{tm('delete')}</Submit>
            <a class="btn btn--secondary" href={`/products/${p.id}`}>{t('common.cancel')}</a>
          </FormActions>
        </Form>
      )}
    </>
  );
}

export function brokenProductUrls(before: { slugFr: string; slugAr: string }, after: { slugFr: string; slugAr: string }): string[] {
  const out: string[] = [];
  if (before.slugFr !== after.slugFr) out.push(productPath('fr', before.slugFr));
  if (before.slugAr !== after.slugAr) out.push(productPath('ar', before.slugAr));
  return out;
}
