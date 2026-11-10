// The /meta page (MSET-2). Rendering only: no reads, no writes. The token input is never prefilled.
import { can } from '../../auth/permissions.ts';
import { StatusBadge, type Tone } from '../../ui/badge.tsx';
import { useUi } from '../../ui/context.ts';
import { ErrorSummary, fieldId, Form, FormActions, Submit, TextInput } from '../../ui/form.tsx';
import { Card } from '../../ui/kit.tsx';
import type { mm } from './messages.ts';

type Tm = ReturnType<typeof mm>;

export interface MetaView {
  readonly pixelId: string | null;
  readonly consentRequired: boolean;
  readonly testEventCode: string | null;
  /** set: readable, with its hint; unreadable: the key opens nothing; locked: no usable key. */
  readonly token: { readonly kind: 'absent' } | { readonly kind: 'set'; readonly hint: string } | { readonly kind: 'unreadable' } | { readonly kind: 'locked' };
  readonly keyOk: boolean;
}

export type MetaErrors = Readonly<Record<string, string | undefined>>;

type ServerState = 'on' | 'noPixel' | 'noToken' | 'noKey' | 'unreadable';

function serverState(view: MetaView): ServerState {
  if (view.pixelId === null) return 'noPixel';
  if (view.token.kind === 'absent') return 'noToken';
  if (!view.keyOk) return 'noKey';
  if (view.token.kind !== 'set') return 'unreadable';
  return 'on';
}

const SERVER_TONE: Readonly<Record<ServerState, Tone>> = { on: 'success', noPixel: 'neutral', noToken: 'warning', noKey: 'danger', unreadable: 'danger' };

/** A write-only secret field: never carries a value. */
function SecretInput(props: { name: string; label: string; hint: string; error?: string | undefined }) {
  const id = fieldId(props.name);
  const hintId = `${id}-hint`;
  const errId = props.error ? `${id}-err` : undefined;
  return (
    <div class={props.error ? 'field field--invalid' : 'field'}>
      <label class="field__label" for={id}>{props.label}</label>
      <p class="field__hint" id={hintId}>{props.hint}</p>
      <input
        id={id}
        class="input"
        name={props.name}
        type="password"
        value=""
        dir="ltr"
        autocomplete="off"
        spellcheck={false}
        maxlength={1000}
        aria-describedby={[hintId, errId].filter(Boolean).join(' ')}
        aria-invalid={props.error ? 'true' : undefined}
      />
      {props.error ? <p class="field__error" id={errId}>{props.error}</p> : null}
    </div>
  );
}

function ConsentRadios(props: { tm: Tm; value: string; error?: string | undefined }) {
  const { tm } = props;
  const opt = (value: 'required' | 'off', label: string) => (
    <div class="field field--check">
      <input type="radio" class="check" id={fieldId('consent', value)} name="consent" value={value} checked={props.value === value} />
      <label for={fieldId('consent', value)}>{label}</label>
    </div>
  );
  return (
    <fieldset class={props.error ? 'field field--invalid' : 'field'} id={fieldId('consent')} aria-describedby={`${fieldId('consent')}-hint`}>
      <legend class="field__label">{tm('consent.legend')}</legend>
      <p class="field__hint" id={`${fieldId('consent')}-hint`}>{tm('consent.hint')}</p>
      {opt('required', tm('consent.required'))}
      {opt('off', tm('consent.off'))}
      {props.error ? <p class="field__error">{props.error}</p> : null}
    </fieldset>
  );
}

export function MetaPage(props: { view: MetaView; errors: MetaErrors | undefined; values: Readonly<Record<string, string>>; tm: Tm }) {
  const { view, tm } = props;
  const { user } = useUi();
  const errors = props.errors ?? {};
  const state = serverState(view);
  const tokenLine =
    view.token.kind === 'absent'
      ? tm('token.absent')
      : view.token.kind === 'set'
        ? tm('token.set', { hint: '⁨' + view.token.hint + '⁩' })
        : tm('token.setLocked');
  const pixelValue = props.values['pixelId'] ?? view.pixelId ?? '';
  const consentValue = props.values['consent'] ?? (view.consentRequired ? 'required' : 'off');
  const testValue = props.values['testEventCode'] ?? view.testEventCode ?? '';
  return (
    <>
      <p>{tm('intro')}</p>
      <ErrorSummary errors={errors} />
      {view.testEventCode !== null ? (
        <div class="callout callout--warning" role="status">
          <p>{tm('testWarning')}</p>
        </div>
      ) : null}

      <Card title={tm('status.title')} id="meta-status">
        <dl class="meta">
          <dt>{tm('status.browser')}</dt>
          <dd>
            <StatusBadge tone={view.pixelId ? 'info' : 'neutral'} label={view.pixelId ? tm('browser.on') : tm('browser.off')} />
            {view.pixelId && can(user, 'publish.run') ? (
              <>
                {' '}
                <a href="/publish">{tm('publish.link')}</a>
              </>
            ) : null}
          </dd>
          <dt>{tm('status.server')}</dt>
          <dd>
            <StatusBadge tone={SERVER_TONE[state]} label={tm(`server.${state}`)} />
          </dd>
        </dl>
      </Card>

      <Card title={tm('pixel.title')} id="meta-pixel">
        <Form action="/meta/pixel">
          <TextInput
            name="pixelId"
            label={tm('pixel.label')}
            hint={tm('pixel.hint')}
            value={pixelValue}
            error={errors['pixelId']}
            dir="ltr"
            inputmode="numeric"
            maxlength={32}
            required
          />
          <ConsentRadios tm={tm} value={consentValue} error={errors['consent']} />
          <FormActions>
            <Submit>{tm('pixel.save')}</Submit>
          </FormActions>
        </Form>
        {view.pixelId ? (
          <Form action="/meta/pixel/remove" confirm={tm('pixel.removeConfirm')}>
            <FormActions>
              <Submit variant="danger">{tm('pixel.remove')}</Submit>
            </FormActions>
          </Form>
        ) : null}
      </Card>

      <Card title={tm('token.title')} id="meta-token">
        <dl class="meta">
          <dt>{tm('token.state')}</dt>
          <dd>{tokenLine}</dd>
        </dl>
        <Form action="/meta/token">
          <SecretInput name="token" label={tm('token.label')} hint={tm('token.hint')} error={errors['token']} />
          <FormActions>
            <Submit>{tm('token.save')}</Submit>
          </FormActions>
        </Form>
        {view.token.kind !== 'absent' ? (
          <Form action="/meta/token/remove" confirm={tm('token.removeConfirm')}>
            <FormActions>
              <Submit variant="danger">{tm('token.remove')}</Submit>
            </FormActions>
          </Form>
        ) : null}
      </Card>

      <Card title={tm('test.title')} id="meta-test">
        <Form action="/meta/test-code">
          <TextInput
            name="testEventCode"
            label={tm('test.label')}
            hint={tm('test.hint')}
            value={testValue}
            error={errors['testEventCode']}
            dir="ltr"
            maxlength={64}
          />
          <FormActions>
            <Submit>{tm('test.save')}</Submit>
          </FormActions>
        </Form>
        {view.testEventCode !== null ? (
          <Form action="/meta/test-code/remove">
            <FormActions>
              <Submit variant="danger">{tm('test.remove')}</Submit>
            </FormActions>
          </Form>
        ) : null}
      </Card>
    </>
  );
}
