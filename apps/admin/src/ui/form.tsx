// Form kit. Every <Form method="post"> carries the CSRF token automatically. Inputs get ids,
// labels, `aria-describedby` hints/errors and `aria-invalid`. Values and errors come from
// `parseForm` (lib/forms.ts) so a 422 re-render keeps what the user typed.
import type { Child } from 'hono/jsx';
import { useUi } from './context.ts';

export type FieldErrors = Readonly<Record<string, string | undefined>>;
export type FormValues = Readonly<Record<string, string | undefined>>;

export function Form(props: {
  action: string;
  method?: 'get' | 'post';
  enctype?: 'multipart/form-data';
  class?: string;
  /** `data-confirm` text: admin.js asks before submitting (no-JS: submits directly). */
  confirm?: string;
  children: Child;
}) {
  const { csrfToken } = useUi();
  const method = props.method ?? 'post';
  return (
    <form
      action={props.action}
      method={method}
      enctype={props.enctype}
      class={props.class ?? 'form'}
      data-confirm={props.confirm}
      novalidate={method === 'post' ? true : undefined}
    >
      {method === 'post' ? <input type="hidden" name="_csrf" value={csrfToken} /> : null}
      {props.children}
    </form>
  );
}

export function ErrorSummary(props: { errors: FieldErrors | undefined; labels?: Readonly<Record<string, string>> }) {
  const { t } = useUi();
  const entries = Object.entries(props.errors ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string');
  if (entries.length === 0) return null;
  return (
    <div class="error-summary" role="alert" tabindex={-1}>
      <h2 class="error-summary__title">{t('form.errorSummary', { count: entries.length })}</h2>
      <ul>
        {entries.map(([name, msg]) => (
          <li><a href={`#f-${name}`}>{props.labels?.[name] ? `${props.labels[name]} : ${msg}` : msg}</a></li>
        ))}
      </ul>
    </div>
  );
}

interface BaseFieldProps {
  name: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
}

function Field(props: BaseFieldProps & { children: (a: { id: string; describedBy: string | undefined; invalid: boolean }) => Child }) {
  const id = `f-${props.name}`;
  const hintId = props.hint ? `${id}-hint` : undefined;
  const errId = props.error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div class={props.error ? 'field field--invalid' : 'field'}>
      <label class="field__label" for={id}>
        {props.label}
        {props.required ? <span class="field__req" aria-hidden="true"> *</span> : null}
      </label>
      {props.hint ? <p class="field__hint" id={hintId}>{props.hint}</p> : null}
      {props.children({ id, describedBy, invalid: Boolean(props.error) })}
      {props.error ? <p class="field__error" id={errId}>{props.error}</p> : null}
    </div>
  );
}

type TextType = 'text' | 'email' | 'search' | 'url' | 'tel' | 'date';

export function TextInput(
  props: BaseFieldProps & {
    value?: string | undefined;
    type?: TextType;
    maxlength?: number | undefined;
    dir?: 'ltr' | 'rtl' | 'auto';
    lang?: string;
    inputmode?: 'text' | 'numeric' | 'tel' | 'email' | 'decimal' | 'search' | 'url';
    autocomplete?: string;
    pattern?: string;
  },
) {
  return (
    <Field {...props}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          class="input"
          name={props.name}
          type={props.type ?? 'text'}
          value={props.value ?? ''}
          maxlength={props.maxlength}
          dir={props.dir}
          lang={props.lang}
          inputmode={props.inputmode}
          autocomplete={props.autocomplete ?? 'off'}
          pattern={props.pattern}
          required={props.required}
          aria-describedby={describedBy}
          aria-invalid={invalid ? 'true' : undefined}
        />
      )}
    </Field>
  );
}

/** Integer DZD. Text input so Eastern-Arabic digits are accepted (normalised server-side). */
export function MoneyInput(props: BaseFieldProps & { value?: string | undefined }) {
  return <TextInput {...props} inputmode="numeric" dir="ltr" maxlength={12} />;
}

export function NumberInput(props: BaseFieldProps & { value?: string | undefined }) {
  return <TextInput {...props} inputmode="numeric" dir="ltr" maxlength={12} />;
}

export function PhoneInput(props: BaseFieldProps & { value?: string | undefined }) {
  return <TextInput {...props} type="tel" inputmode="tel" dir="ltr" autocomplete="off" maxlength={20} />;
}

export function Textarea(
  props: BaseFieldProps & { value?: string | undefined; rows?: number; maxlength?: number | undefined; dir?: 'ltr' | 'rtl' | 'auto'; lang?: string },
) {
  return (
    <Field {...props}>
      {({ id, describedBy, invalid }) => (
        <textarea
          id={id}
          class="input input--area"
          name={props.name}
          rows={props.rows ?? 4}
          maxlength={props.maxlength}
          dir={props.dir}
          lang={props.lang}
          required={props.required}
          aria-describedby={describedBy}
          aria-invalid={invalid ? 'true' : undefined}
        >
          {props.value ?? ''}
        </textarea>
      )}
    </Field>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function Select(props: BaseFieldProps & { value?: string | undefined; options: readonly Option[]; placeholder?: string }) {
  return (
    <Field {...props}>
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          class="input input--select"
          name={props.name}
          required={props.required}
          aria-describedby={describedBy}
          aria-invalid={invalid ? 'true' : undefined}
        >
          {props.placeholder !== undefined ? <option value="">{props.placeholder}</option> : null}
          {props.options.map((o) => (
            <option value={o.value} selected={o.value === props.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function Checkbox(props: { name: string; label: string; checked?: boolean; hint?: string; value?: string }) {
  const id = `f-${props.name}`;
  return (
    <div class="field field--check">
      <input type="checkbox" class="check" id={id} name={props.name} value={props.value ?? '1'} checked={props.checked} />
      <label for={id}>{props.label}</label>
      {props.hint ? <p class="field__hint">{props.hint}</p> : null}
    </div>
  );
}

/**
 * A bilingual pair: `<name>_fr` (LTR, lang=fr) next to `<name>_ar` (RTL, lang=ar).
 * Use for every `*_fr` / `*_ar` column.
 */
export function LocalizedField(props: {
  name: string;
  label: string;
  values: FormValues;
  errors?: FieldErrors | undefined;
  multiline?: boolean;
  maxlength?: number | undefined;
  required?: boolean | undefined;
}) {
  const { t } = useUi();
  const common = { maxlength: props.maxlength, required: props.required };
  const fr = `${props.name}_fr`;
  const ar = `${props.name}_ar`;
  return (
    <fieldset class="localized">
      <legend class="localized__legend">{props.label}</legend>
      <div class="localized__pair">
        {props.multiline ? (
          <>
            <Textarea {...common} name={fr} label={t('common.fr')} value={props.values[fr]} error={props.errors?.[fr]} dir="ltr" lang="fr" />
            <Textarea {...common} name={ar} label={t('common.ar')} value={props.values[ar]} error={props.errors?.[ar]} dir="rtl" lang="ar" />
          </>
        ) : (
          <>
            <TextInput {...common} name={fr} label={t('common.fr')} value={props.values[fr]} error={props.errors?.[fr]} dir="ltr" lang="fr" />
            <TextInput {...common} name={ar} label={t('common.ar')} value={props.values[ar]} error={props.errors?.[ar]} dir="rtl" lang="ar" />
          </>
        )}
      </div>
    </fieldset>
  );
}

export function Submit(props: { children: Child; variant?: 'primary' | 'secondary' | 'danger'; name?: string; value?: string }) {
  return (
    <button type="submit" class={`btn btn--${props.variant ?? 'primary'}`} name={props.name} value={props.value}>
      {props.children}
    </button>
  );
}

export function FormActions(props: { children: Child }) {
  return <div class="form-actions">{props.children}</div>;
}
