// Media views (ACAT-3): the Photos section shown on product and category edit pages, the recent
// list, and the delete confirm page. No JS: reorder with up/down buttons, upload with a plain
// multipart form (CSRF token added by the kit's Form).
import type { Image } from '@hb/db';
import { useUi } from '../../ui/context.ts';
import { StatusBadge } from '../../ui/badge.tsx';
import { Bdi } from '../../ui/format.tsx';
import { ErrorSummary, Form, FormActions, LocalizedField, Submit, type FieldErrors } from '../../ui/form.tsx';
import { CardField } from '../products/lib/card-field.tsx';
import { fieldMessages } from '../products/lib/field-messages.ts';
import type { BindChoices, Owner } from './data.ts';
import { RECOMMENDED_WIDTH } from './data.ts';
import { m } from './messages.ts';

const ownerToken = (o: Owner) => `${o.kind}:${o.id}`;

/** 160 px wide thumbnail of the original (sized by attributes, so no CSS is needed and 360 px never scrolls). */
export const THUMB_WIDTH = 160;
function Thumb(props: { img: Image; alt: string }) {
  const h = Math.max(1, Math.round((THUMB_WIDTH * props.img.height) / props.img.width));
  return (
    <a href={`/media/${props.img.id}/original`}>
      <img src={`/media/${props.img.id}/original`} width={THUMB_WIDTH} height={h} alt={props.alt} loading="lazy" decoding="async" class="thumb" />
    </a>
  );
}

export function PhotosSection(props: { owner: Owner; images: readonly Image[]; choices?: BindChoices | undefined; errors?: FieldErrors | undefined }) {
  const { lang, t } = useUi();
  const tm = m(lang);
  const tf = fieldMessages(lang);
  const bindOptions = props.choices
    ? [
        { value: '', label: tm('bind.product') },
        ...props.choices.values.map((x) => ({ value: `o:${x.id}`, label: tm('bind.value', { value: lang === 'ar' ? x.labelAr : x.labelFr }) })),
        ...props.choices.variants.map((x) => ({ value: `v:${x.id}`, label: tm('bind.variant', { sku: x.sku }) })),
      ]
    : null;
  return (
    <section class="panel" aria-labelledby="sec-photos" id="photos">
      <h2 id="sec-photos">{tm('section')}</h2>
      <ErrorSummary errors={props.errors} />
      {props.images.length === 0 ? <p class="empty">{tm('empty')}</p> : null}
      <ol class="photo-list">
        {props.images.map((img, i) => {
          const values: Record<string, string> = { alt_fr: img.altFr, alt_ar: img.altAr };
          const bind = img.variantId !== null ? `v:${img.variantId}` : img.optionValueId !== null ? `o:${img.optionValueId}` : '';
          return (
            <li>
              <Thumb img={img} alt={lang === 'ar' ? img.altAr : img.altFr} />
              <p class="muted">
                {tm('size', { width: img.width, height: img.height })} · <Bdi ltr>{img.r2Key}</Bdi>
                {img.placeholder ? <> <StatusBadge tone="warning" label={tf('common.placeholder')} /></> : null}
              </p>
              {img.width < RECOMMENDED_WIDTH ? <p class="field__hint"><strong>⚠ </strong>{tm('warn.small')}</p> : null}
              {/* One card per photo: ids carry the image id (CardField), so labels never point into another card. */}
              <Form action={`/media/${img.id}`}>
                <CardField name="alt_fr" idKey={img.id} label={`${tm('alt')} (${t('common.fr')})`} value={values['alt_fr']} maxlength={200} required dir="ltr" lang="fr" />
                <CardField name="alt_ar" idKey={img.id} label={`${tm('alt')} (${t('common.ar')})`} value={values['alt_ar']} maxlength={200} required dir="rtl" lang="ar" />
                {bindOptions ? <CardField name="bind" idKey={img.id} label={tm('bind')} value={bind} options={bindOptions} /> : null}
                <div class="field field--check">
                  <input type="checkbox" class="check" id={`f-placeholder-${img.id}`} name="placeholder" value="1" checked={img.placeholder} />
                  <label for={`f-placeholder-${img.id}`}>{tf('common.placeholder')}</label>
                </div>
                <Submit variant="secondary">{t('common.save')}</Submit>
              </Form>
              <div class="form-actions">
                {i > 0 ? (
                  <Form action={`/media/${img.id}/move`} class="inline-form">
                    <input type="hidden" name="dir" value="up" />
                    <Submit variant="secondary">{tm('move.up')}</Submit>
                  </Form>
                ) : null}
                {i < props.images.length - 1 ? (
                  <Form action={`/media/${img.id}/move`} class="inline-form">
                    <input type="hidden" name="dir" value="down" />
                    <Submit variant="secondary">{tm('move.down')}</Submit>
                  </Form>
                ) : null}
                <a class="btn btn--danger" href={`/media/${img.id}/delete`}>{tm('delete')}</a>
              </div>
            </li>
          );
        })}
      </ol>
      <Form action="/media/upload" enctype="multipart/form-data">
        <h3>{tm('upload')}</h3>
        <input type="hidden" name="owner" value={ownerToken(props.owner)} />
        <div class="field">
          <label class="field__label" for="f-files">{tm('upload.files')}</label>
          <p class="field__hint" id="f-files-hint">{tm('upload.hint')}</p>
          <input
            id="f-files"
            class="input"
            type="file"
            name="files"
            multiple
            required
            accept="image/jpeg,image/png,image/webp,image/avif"
            aria-describedby="f-files-hint"
          />
        </div>
        <LocalizedField name="alt" label={tm('alt')} values={{}} maxlength={200} required />
        {/* The details form on the same page already has a `placeholder` checkbox (kit id f-placeholder). */}
        <div class="field field--check">
          <input type="checkbox" class="check" id="f-placeholder-upload" name="placeholder" value="1" />
          <label for="f-placeholder-upload">{tf('common.placeholder')}</label>
        </div>
        <FormActions>
          <Submit>{tm('upload.button')}</Submit>
        </FormActions>
      </Form>
    </section>
  );
}

export function RecentList(props: { images: readonly Image[] }) {
  const { lang } = useUi();
  const tm = m(lang);
  if (props.images.length === 0) return <p class="empty">{tm('empty')}</p>;
  return (
    <ol class="photo-list">
      {props.images.map((img) => (
        <li>
          <Thumb img={img} alt={lang === 'ar' ? img.altAr : img.altFr} />
          <p>
            <a href={img.productId !== null ? `/products/${img.productId}#sec-photos` : `/categories/${img.categoryId}#sec-photos`}>
              <Bdi ltr>{img.r2Key}</Bdi>
            </a>
          </p>
        </li>
      ))}
    </ol>
  );
}

export function DeletePage(props: { img: Image; back: string }) {
  const { lang, t } = useUi();
  const tm = m(lang);
  return (
    <Form action={`/media/${props.img.id}/delete`}>
      <Thumb img={props.img} alt={lang === 'ar' ? props.img.altAr : props.img.altFr} />
      <p>{tm('delete.confirm')}</p>
      <FormActions>
        <Submit variant="danger">{tm('delete')}</Submit>
        <a class="btn btn--secondary" href={props.back}>{t('common.cancel')}</a>
      </FormActions>
    </Form>
  );
}
