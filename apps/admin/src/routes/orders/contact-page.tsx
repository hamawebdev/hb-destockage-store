// AORD-6 — contact/address edit pages (no JS). Step 1 "edit": the form. Step 2 "review": old → new
// values with the re-quoted fee and total, then "Save". A wilaya change without JS: pick the wilaya,
// press "Check"; the server answers with that wilaya's communes.
import type { Child } from 'hono/jsx';
import { formatPhoneDisplay } from '@hb/shared';
import type { Lang } from '../../i18n/index.ts';
import { ErrorSummary, Form, FormActions, PhoneInput, Select, Submit, TextInput } from '../../ui/form.tsx';
import { Bdi, Money } from '../../ui/format.tsx';
import type { OrderDetail } from './detail-data.ts';
import type { WilayaOption } from './list-data.ts';
import type { ContactInput, ContactPreview } from './contact.ts';
import { m } from './messages.ts';

export interface CommuneOption {
  id: number;
  nameFr: string;
  nameAr: string;
}

const pick = (lang: Lang, fr: string, ar: string) => (lang === 'ar' ? ar : fr);

export function ContactEditPage(props: {
  lang: Lang;
  order: OrderDetail;
  wilayas: readonly WilayaOption[];
  communes: readonly CommuneOption[];
  values: Readonly<Record<string, string | undefined>>;
  errors?: Readonly<Record<string, string>>;
}) {
  const tm = m(props.lang);
  const { order, values, errors } = props;
  const top = errors?.['_form'];
  return (
    <>
      <p>
        <Bdi>{order.ref}</Bdi> · <a href={`/orders/${order.ref}`}>{tm('contact.back')}</a>
      </p>
      {top ? <p class="flash flash--danger" role="alert">{top}</p> : null}
      <Form action={`/orders/${order.ref}/contact`}>
        {errors ? <ErrorSummary errors={Object.fromEntries(Object.entries(errors).filter(([k]) => k !== '_form'))} /> : null}
        <input type="hidden" name="version" value={values['version'] ?? String(order.version)} />
        <input type="hidden" name="step" value="review" />
        <TextInput name="name" label={tm('contact.name')} value={values['name']} maxlength={120} dir="auto" required error={errors?.['name']} />
        <PhoneInput name="phone" label={tm('contact.phone')} hint={tm('contact.phoneHint')} value={values['phone']} required error={errors?.['phone']} />
        <Select
          name="wilaya"
          label={tm('filter.wilaya')}
          value={values['wilaya']}
          required
          error={errors?.['wilaya']}
          options={props.wilayas.map((w) => ({ value: String(w.code), label: `${String(w.code).padStart(2, '0')} — ${pick(props.lang, w.nameFr, w.nameAr)}` }))}
        />
        <Select
          name="commune"
          label={tm('contact.commune')}
          hint={tm('contact.communeHint')}
          value={values['commune']}
          placeholder={tm('call.choose')}
          required
          error={errors?.['commune']}
          options={props.communes.map((c) => ({ value: String(c.id), label: pick(props.lang, c.nameFr, c.nameAr) }))}
        />
        <TextInput name="address" label={tm('detail.address')} value={values['address']} maxlength={300} dir="auto" error={errors?.['address']} />
        <FormActions>
          <Submit>{tm('contact.check')}</Submit>
          <a class="btn btn--secondary" href={`/orders/${order.ref}`}>{tm('contact.cancel')}</a>
        </FormActions>
      </Form>
    </>
  );
}

export function ContactReviewPage(props: {
  lang: Lang;
  order: OrderDetail;
  input: ContactInput;
  preview: Extract<ContactPreview, { ok: true }>;
  newPlace: { wilayaFr: string; wilayaAr: string; communeFr: string; communeAr: string };
  /** The fee/total moved between the review and the save. */
  priceChanged?: boolean;
}) {
  const tm = m(props.lang);
  const { order, input, preview, lang } = props;
  const place = (w: string, c: string) => `${w} / ${c}`;
  const rows: [string, Child, Child][] = [];
  if (preview.changed.includes('name')) rows.push([tm('contact.name'), <Bdi ltr={false}>{order.name}</Bdi>, <Bdi ltr={false}>{preview.name}</Bdi>]);
  if (preview.changed.includes('phone'))
    rows.push([tm('contact.phone'), <Bdi>{formatPhoneDisplay(order.phoneE164)}</Bdi>, <Bdi>{formatPhoneDisplay(preview.phoneE164)}</Bdi>]);
  if (preview.changed.includes('address')) rows.push([tm('detail.address'), order.address ?? '—', input.address ?? '—']);
  if (preview.areaChanged) {
    rows.push([
      tm('list.col.place'),
      place(pick(lang, order.wilayaFr, order.wilayaAr), pick(lang, order.communeFr, order.communeAr)),
      place(pick(lang, props.newPlace.wilayaFr, props.newPlace.wilayaAr), pick(lang, props.newPlace.communeFr, props.newPlace.communeAr)),
    ]);
    rows.push([tm('detail.fee'), <Money dzd={order.feeDzd} />, <Money dzd={preview.feeDzd} />]);
    rows.push([tm('detail.total'), <Money dzd={order.totalDzd} />, <strong><Money dzd={preview.totalDzd} /></strong>]);
  }
  const hidden: Record<string, string> = {
    version: String(input.version),
    name: input.name,
    phone: input.phone,
    wilaya: String(input.wilaya),
    commune: String(input.commune),
    address: input.address ?? '',
    previewTotal: String(preview.totalDzd),
  };
  return (
    <>
      <p>
        <Bdi>{order.ref}</Bdi>
      </p>
      {props.priceChanged ? <p class="flash flash--danger" role="alert">{tm('contact.err.priceChanged')}</p> : null}
      <div class="table-wrap" role="region" aria-label={tm('contact.reviewTitle')} tabindex={0}>
        <table class="table">
          <caption class="table__caption">{tm('contact.reviewTitle')}</caption>
          <thead>
            <tr>
              <th scope="col">{tm('contact.field')}</th>
              <th scope="col">{tm('contact.before')}</th>
              <th scope="col">{tm('contact.after')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, a, b]) => (
              <tr>
                <th scope="row">{label}</th>
                <td>{a}</td>
                <td>{b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.areaChanged && preview.totalDzd !== order.totalDzd ? <p>{tm('contact.totalChangesHint')}</p> : null}
      <Form action={`/orders/${order.ref}/contact`}>
        {Object.entries(hidden).map(([k, val]) => (
          <input type="hidden" name={k} value={val} />
        ))}
        <FormActions>
          <Submit name="step" value="save">{tm('contact.save')}</Submit>
          <Submit name="step" value="edit" variant="secondary">{tm('contact.edit')}</Submit>
        </FormActions>
      </Form>
    </>
  );
}
