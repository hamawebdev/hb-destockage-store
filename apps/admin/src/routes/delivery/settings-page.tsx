// /delivery/settings views (SHIP-2). Credentials are write-only: no value is ever rendered, only
// whether a field is set and, for long values, its last four characters.
import type { CourierAdapter } from '@hb/couriers';
import type { CourierAccount } from '@hb/db';
import { Bdi } from '../../ui/format.tsx';
import { useUi } from '../../ui/context.ts';
import { StatusBadge, type Tone } from '../../ui/badge.tsx';
import { DateTime } from '../../ui/format.tsx';
import { Checkbox, ErrorSummary, Form, FormActions, Select, Submit, TextInput, fieldId, type FieldErrors, type Option } from '../../ui/form.tsx';
import { Table } from '../../ui/table.tsx';
import type { KeyState } from './keys.ts';
import { WEBHOOK_SECRET_FIELD } from './keys.ts';
import { hasDeliveryMessage, m, type DeliveryMessage } from './messages.ts';

type KeyProblem = Extract<KeyState, { ok: false }>['reason'] | null;

export interface AccountView {
  adapter: CourierAdapter;
  account: CourierAccount | undefined;
  /** Stored keys exist but cannot be opened with the current encryption key. */
  unreadable: boolean;
}

function stateOf(v: AccountView): { tone: Tone; key: DeliveryMessage } {
  if (v.unreadable) return { tone: 'danger', key: 'state.unreadable' };
  if (!v.account?.credentialsCipher) return { tone: 'neutral', key: 'state.noKeys' };
  return v.account.enabled ? { tone: 'success', key: 'state.on' } : { tone: 'warning', key: 'state.off' };
}

function KeyBanner(props: { problem: KeyProblem }) {
  const tm = m(useUi().lang);
  if (!props.problem) return null;
  return (
    <div class="callout callout--warning" role="status">
      <p>{tm(props.problem === 'missing' ? 'key.missing' : 'key.invalid')}</p>
    </div>
  );
}

function checkLabel(tm: ReturnType<typeof m>, result: CourierAccount['lastCheckResult'] | undefined): string {
  return result ? tm(`check.${result}`) : tm('check.never');
}

export function SettingsListPage(props: { views: readonly AccountView[]; q: string; keyProblem: KeyProblem }) {
  const tm = m(useUi().lang);
  return (
    <>
      <KeyBanner problem={props.keyProblem} />
      <p>{tm('settings.intro')}</p>
      <Form action="/delivery/settings" method="get" class="form form--inline">
        <TextInput name="q" type="search" label={tm('settings.search')} value={props.q} />
        <FormActions>
          <Submit variant="secondary">{tm('settings.searchBtn')}</Submit>
        </FormActions>
      </Form>
      <Table
        caption={tm('settings.caption')}
        rows={props.views}
        rowKey={(v) => v.adapter.id}
        stack
        empty={tm('settings.empty')}
        columns={[
          { key: 'courier', header: tm('col.courier'), cell: (v) => <Bdi>{v.adapter.displayName}</Bdi> },
          {
            key: 'state',
            header: tm('col.state'),
            cell: (v) => {
              const s = stateOf(v);
              return <StatusBadge tone={s.tone} label={tm(s.key)} />;
            },
          },
          { key: 'check', header: tm('col.check'), cell: (v) => checkLabel(tm, v.account?.lastCheckResult) },
          { key: 'action', header: tm('col.action'), cell: (v) => <a class="btn btn--secondary" href={`/delivery/settings/${v.adapter.id}`}>{tm('action.manage')}</a> },
        ]}
      />
    </>
  );
}

/** Password inputs: browsers and screens never show the value, and it is never pre-filled. */
function SecretInput(props: { name: string; label: string; hint: string; error: string | undefined }) {
  const id = fieldId(props.name);
  return (
    <div class={props.error ? 'field field--invalid' : 'field'}>
      <label class="field__label" for={id}>{props.label}</label>
      <p class="field__hint" id={`${id}-hint`}>{props.hint}</p>
      <input
        id={id}
        class="input"
        name={props.name}
        type="password"
        dir="ltr"
        autocomplete="new-password"
        maxlength={500}
        aria-describedby={`${id}-hint`}
        aria-invalid={props.error ? 'true' : undefined}
      />
      {props.error ? <p class="field__error">{props.error}</p> : null}
    </div>
  );
}

export interface AccountPageProps {
  view: AccountView;
  keyProblem: KeyProblem;
  wilayas: readonly Option[];
  errors?: FieldErrors;
  /** Full webhook URL or path, on the one response that generated it. */
  webhookOnce?: string;
}

export function AccountPage(props: AccountPageProps) {
  const { lang } = useUi();
  const tm = m(lang);
  const { adapter, account, unreadable } = props.view;
  const caps = adapter.capabilities;
  const base = `/delivery/settings/${adapter.id}`;
  const hints = account?.credentialsHint ?? {};
  const config = account?.config ?? {};
  const hasKeys = Boolean(account?.credentialsCipher);
  const s = stateOf(props.view);
  const conf = adapter.confidence;
  const canWrite = props.keyProblem === null;
  const noteText = (code: string) => {
    const key = `note.${code}`;
    return hasDeliveryMessage(key) ? tm(key) : code;
  };
  return (
    <>
      <KeyBanner problem={props.keyProblem} />
      {unreadable ? (
        <div class="callout callout--warning" role="status">
          <p>{tm('key.unreadable')}</p>
        </div>
      ) : null}
      <ErrorSummary errors={props.errors} />

      <section>
        <h2>{tm('section.status')}</h2>
        <p>
          <StatusBadge tone={s.tone} label={tm(s.key)} /> {checkLabel(tm, account?.lastCheckResult)}
          {account?.lastCheckAt ? <> · <DateTime ms={account.lastCheckAt} /></> : null}
        </p>
        <div class="actions">
          {hasKeys && canWrite ? (
            <Form action={`${base}/test`}>
              <Submit variant="secondary">{tm('check.run')}</Submit>
            </Form>
          ) : null}
          {hasKeys && canWrite ? (
            account?.enabled ? (
              <Form action={`${base}/disable`}>
                <Submit variant="secondary">{tm('disable')}</Submit>
              </Form>
            ) : (
              <Form action={`${base}/enable`}>
                <Submit>{tm('enable')}</Submit>
              </Form>
            )
          ) : null}
        </div>
      </section>

      <section>
        <h2>{tm('section.keys')}</h2>
        <p class="muted">{tm('section.keysHint')}</p>
        {canWrite ? (
          <Form action={`${base}/keys`}>
            {caps.credentialFields.map((f) => {
              const hint = hints[f.key];
              return (
                <SecretInput
                  name={`cred_${f.key}`}
                  label={lang === 'ar' ? f.labelAr : f.labelFr}
                  hint={hint === undefined ? tm('field.notSet') : hint === '' ? tm('field.set') : tm('field.setHint', { hint })}
                  error={props.errors?.[`cred_${f.key}`]}
                />
              );
            })}
            {caps.webhook === 'hmac' ? (
              <SecretInput
                name={`cred_${WEBHOOK_SECRET_FIELD}`}
                label={tm('field.webhookSecret')}
                hint={`${tm('field.webhookSecretHint')} ${hints[WEBHOOK_SECRET_FIELD] === undefined ? tm('field.notSet') : hints[WEBHOOK_SECRET_FIELD] === '' ? tm('field.set') : tm('field.setHint', { hint: hints[WEBHOOK_SECRET_FIELD] })}`}
                error={props.errors?.[`cred_${WEBHOOK_SECRET_FIELD}`]}
              />
            ) : null}
            <FormActions>
              <Submit>{tm('keys.save')}</Submit>
            </FormActions>
          </Form>
        ) : null}
        {hasKeys ? (
          <Form action={`${base}/remove-keys`} confirm={tm('keys.removeConfirm')}>
            <Submit variant="danger">{tm('keys.remove')}</Submit>
          </Form>
        ) : null}
      </section>

      {caps.needsOriginWilaya || caps.needsValidation ? (
        <section>
          <h2>{tm('section.settings')}</h2>
          <Form action={`${base}/config`}>
            {caps.needsOriginWilaya ? (
              <Select
                name="originWilaya"
                label={tm('config.origin')}
                placeholder={tm('config.originPick')}
                options={props.wilayas}
                value={typeof config['originWilaya'] === 'number' ? String(config['originWilaya']) : undefined}
                error={props.errors?.['originWilaya']}
              />
            ) : null}
            {caps.needsValidation ? (
              <Checkbox name="askCollection" label={tm('config.askCollection')} hint={tm('config.askCollectionHint')} checked={config['askCollection'] === true} />
            ) : null}
            <FormActions>
              <Submit variant="secondary">{tm('config.save')}</Submit>
            </FormActions>
          </Form>
        </section>
      ) : null}

      <section>
        <h2>{tm('section.webhook')}</h2>
        {caps.webhook === 'none' ? (
          <p>{tm('webhook.noPush')}</p>
        ) : (
          <>
            {props.webhookOnce ? (
              <div class="callout callout--warning" role="status">
                <p><strong>{tm('webhook.once')}</strong></p>
                <p><code dir="ltr">{props.webhookOnce}</code></p>
              </div>
            ) : null}
            <p>{account?.webhookTokenHash ? tm('webhook.exists') : tm('webhook.none')} {tm('webhook.pollNote')}</p>
            <div class="actions">
              {account?.webhookTokenHash ? (
                <>
                  <Form action={`${base}/webhook-token`} confirm={tm('webhook.rotateConfirm')}>
                    <Submit variant="secondary">{tm('webhook.rotate')}</Submit>
                  </Form>
                  <Form action={`${base}/webhook-token/remove`} confirm={tm('webhook.removeConfirm')}>
                    <Submit variant="danger">{tm('webhook.remove')}</Submit>
                  </Form>
                </>
              ) : (
                <Form action={`${base}/webhook-token`}>
                  <Submit variant="secondary">{tm('webhook.generate')}</Submit>
                </Form>
              )}
            </div>
          </>
        )}
      </section>

      <section>
        <h2>{tm('section.confidence')}</h2>
        <ul>
          <li>{tm('confidence.url')}: {tm(`confidence.url.${conf.baseUrl}`)}</li>
          <li>{tm('confidence.list')}: {tm(`confidence.list.${conf.statusList}`)}</li>
          {conf.notes.map((code) => <li>{noteText(code)}</li>)}
        </ul>
      </section>
    </>
  );
}
