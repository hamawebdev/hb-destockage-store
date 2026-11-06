// A labelled field for repeated cards/rows (stock cards, photo cards). Same markup and classes as
// the kit's Field, but the id is `f-<name>-<key>`, so N cards on one page never share an id: each
// label (and aria-describedby) points at the control in its own card, while the form field `name`
// stays the same for the handler.
// TEMPORARY: admin-core is adding an id/idSuffix option to the kit's field helpers; once that sha is
// named this file is replaced by the kit option (lead, 2026-11-07).
import type { Option } from '../../../ui/form.tsx';

export const cardId = (name: string, key: string | number): string => `f-${name}-${key}`;

export function CardField(props: {
  name: string;
  /** Unique per card on the page, e.g. the variant or image id. */
  idKey: string | number;
  label: string;
  value?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean;
  maxlength?: number;
  inputmode?: 'numeric' | 'text';
  dir?: 'ltr' | 'rtl';
  lang?: string;
  options?: readonly Option[];
}) {
  const id = cardId(props.name, props.idKey);
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
      {props.options ? (
        <select id={id} class="input input--select" name={props.name} aria-describedby={describedBy} aria-invalid={props.error ? 'true' : undefined}>
          {props.options.map((o) => (
            <option value={o.value} selected={o.value === props.value}>{o.label}</option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          class="input"
          name={props.name}
          value={props.value ?? ''}
          required={props.required}
          maxlength={props.maxlength}
          inputmode={props.inputmode}
          dir={props.dir}
          lang={props.lang}
          autocomplete="off"
          aria-describedby={describedBy}
          aria-invalid={props.error ? 'true' : undefined}
        />
      )}
      {props.error ? <p class="field__error" id={errId}>{props.error}</p> : null}
    </div>
  );
}
