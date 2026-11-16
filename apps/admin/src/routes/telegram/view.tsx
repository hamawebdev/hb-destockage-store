// The /telegram page (TGS-4). Rendering only: no reads, no writes. The token input never carries a
// value. Chat titles come from Telegram users: text nodes only (escaped by JSX), inside <bdi>.
import { confirmedTelegramChats, formatTelegramOrder, TELEGRAM_FIELDS, TELEGRAM_MAX_CHATS, TELEGRAM_SAMPLE_ORDER, type TelegramChat, type TelegramSettings, type TelegramStatus } from '@hb/shared/telegram';
import { StatusBadge } from '../../ui/badge.tsx';
import { ErrorSummary, fieldId, Form, FormActions, Select, Submit } from '../../ui/form.tsx';
import { DateTime } from '../../ui/format.tsx';
import { Card } from '../../ui/kit.tsx';
import type { ChatDelivery } from './data.ts';
import type { Tm, TmKey } from './messages.ts';

export type TelegramErrors = Readonly<Record<string, string | undefined>>;

export interface TestResult {
  chat: TelegramChat;
  ok: boolean;
  /** Plain words, already translated. */
  problem: string | null;
}

export interface TelegramPageProps {
  tm: Tm;
  settings: TelegramSettings;
  status: TelegramStatus;
  hasToken: boolean;
  /** COURIER_KEYS_KEY is usable. */
  keyOk: boolean;
  /** A Telegram address exists for this server (always true in production). */
  reachable: boolean;
  deliveries: ReadonlyMap<string, ChatDelivery>;
  errors?: TelegramErrors | undefined;
  /** Translated result of the last action. */
  notice?: { tone: 'success' | 'warning'; text: string } | undefined;
  testResults?: readonly TestResult[] | undefined;
}

/** Plain words for a `jobs.telegram_status` code. */
export function problemText(tm: Tm, code: string): string {
  const known = ['token_rejected', 'unreachable', 'rate_limited', 'key_missing', 'chat_rejected', 'conflict'];
  return tm((known.includes(code) ? `problem.${code}` : 'problem.other') as TmKey);
}

/** Plain words for a chat's stored delivery error label. */
export function chatProblemText(tm: Tm, label: string): string {
  return tm(label.includes('chat_rejected') ? 'chatProblem.chat_rejected' : 'chatProblem.other');
}

const ChatTitle = (props: { chat: TelegramChat; tm: Tm }) => (
  <p class="tg-chat__title">
    <bdi>{props.chat.title}</bdi> <span class="tg-chat__type">({props.tm(`type.${props.chat.type}`)})</span>
  </p>
);

function ChatAction(props: { action: string; chatId: string; label: string; variant?: 'primary' | 'secondary' | 'danger'; confirm?: string }) {
  return (
    <Form action={props.action} class="tg-inline" {...(props.confirm ? { confirm: props.confirm } : {})}>
      <input type="hidden" name="chatId" value={props.chatId} />
      <Submit variant={props.variant ?? 'secondary'}>{props.label}</Submit>
    </Form>
  );
}

/** A write-only secret field: never carries a value. */
function TokenInput(props: { label: string; hint: string; error?: string | undefined }) {
  const id = fieldId('token');
  const hintId = `${id}-hint`;
  const errId = props.error ? `${id}-err` : undefined;
  return (
    <div class={props.error ? 'field field--invalid' : 'field'}>
      <label class="field__label" for={id}>{props.label}</label>
      <p class="field__hint" id={hintId}>{props.hint}</p>
      <input
        id={id}
        class="input"
        name="token"
        type="password"
        value=""
        dir="ltr"
        autocomplete="off"
        spellcheck={false}
        maxlength={120}
        aria-describedby={[hintId, errId].filter(Boolean).join(' ')}
        aria-invalid={props.error ? 'true' : undefined}
      />
      {props.error ? <p class="field__error" id={errId}>{props.error}</p> : null}
    </div>
  );
}

export function TelegramPage(props: TelegramPageProps) {
  const { tm, settings: s, status } = props;
  const errors = props.errors ?? {};
  const bot = s.bot;
  const botAt = bot ? `@${bot.username}` : '';
  const confirmed = confirmedTelegramChats(s);
  const pending = s.chats.filter((chat) => !confirmed.includes(chat));
  const ready = props.hasToken && bot !== null && confirmed.length > 0;
  const full = confirmed.length >= TELEGRAM_MAX_CHATS;
  const preview = formatTelegramOrder(TELEGRAM_SAMPLE_ORDER, s.fields, s.lang);
  return (
    <>
      <p>{tm('intro')}</p>
      {props.notice ? (
        <div class={`callout callout--${props.notice.tone}`} role="status">
          <p>{props.notice.text}</p>
        </div>
      ) : null}
      <ErrorSummary errors={errors} />
      {props.reachable ? null : <div class="callout callout--warning"><p>{tm('off')}</p></div>}
      {props.keyOk ? null : <div class="callout callout--warning"><p>{tm('noKey')}</p></div>}

      {props.testResults ? (
        <Card title={tm('test.results')} id="telegram-test-results">
          <div role="status">
            <ul class="tg-chats">
              {props.testResults.map((r) => (
                <li class="tg-chat">
                  <ChatTitle chat={r.chat} tm={tm} />
                  <p>
                    <StatusBadge tone={r.ok ? 'success' : 'danger'} label={r.ok ? 'OK' : tm('chats.problem')} /> {r.ok ? tm('test.ok') : r.problem}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}

      <Card title={tm('state.title')} id="telegram-state">
        <p>
          <StatusBadge tone={s.enabled ? 'success' : 'neutral'} label={tm(s.enabled ? 'state.on' : 'state.off')} /> {tm(s.enabled ? 'state.onNote' : 'state.offNote')}
        </p>
        {s.enabled && confirmed.length === 0 ? <div class="callout callout--warning"><p>{tm('state.noChats')}</p></div> : null}
        <dl class="meta">
          <dt>{tm('state.lastOk')}</dt>
          <dd>{status.lastOkAt ? <DateTime ms={status.lastOkAt} /> : tm('state.never')}</dd>
          {status.lastErrorCode ? (
            <>
              <dt>{tm('state.problem')}</dt>
              <dd data-telegram-problem={status.lastErrorCode}>
                {problemText(tm, status.lastErrorCode)}
                {status.lastErrorAt ? <> (<DateTime ms={status.lastErrorAt} />)</> : null}
              </dd>
            </>
          ) : null}
        </dl>
        <Form action="/telegram/enabled">
          <input type="hidden" name="enabled" value={s.enabled ? 'off' : 'on'} />
          {errors['enabled'] ? <p class="field__error" id={fieldId('enabled')}>{errors['enabled']}</p> : null}
          {!s.enabled && !ready ? <p class="field__hint">{tm('state.needs')}</p> : null}
          {s.enabled ? null : <p class="field__hint">{tm('state.onFrom')}</p>}
          <FormActions>
            <Submit variant={s.enabled ? 'secondary' : 'primary'}>{tm(s.enabled ? 'state.turnOff' : 'state.turnOn')}</Submit>
          </FormActions>
        </Form>
      </Card>

      <Card title={tm('token.title')} id="telegram-token">
        <p class="field__hint">{tm('token.help')}</p>
        <dl class="meta">
          <dt>{tm('token.state')}</dt>
          <dd>
            {bot ? (
              <>
                <bdi dir="ltr">{botAt}</bdi>
                {bot.name ? <> (<bdi>{bot.name}</bdi>)</> : null}
                {s.tokenLast4 ? <>, {tm('token.endsWith')} <bdi dir="ltr">····{s.tokenLast4}</bdi></> : null}
              </>
            ) : (
              tm('token.absent')
            )}
          </dd>
        </dl>
        <Form action="/telegram/token">
          <TokenInput label={tm(bot ? 'token.labelChange' : 'token.label')} hint={tm('token.hint')} error={errors['token']} />
          <FormActions>
            <Submit>{tm('token.save')}</Submit>
          </FormActions>
        </Form>
        {props.hasToken || bot ? (
          <Form action="/telegram/token/remove" confirm={tm('token.removeConfirm')}>
            <FormActions>
              <Submit variant="danger">{tm('token.remove')}</Submit>
            </FormActions>
          </Form>
        ) : null}
      </Card>

      <Card title={tm('chats.title')} id="telegram-chats">
        {bot ? (
          <>
            <p>{tm('chats.help', { bot: botAt })}</p>
            <p>
              <a class="tg-link" href={`https://t.me/${bot.username}`} rel="noopener noreferrer" target="_blank">
                {tm('chats.open', { bot: botAt })}
              </a>
            </p>
            <Form action="/telegram/chats/find">
              <FormActions>
                <Submit variant="secondary">{tm('chats.find')}</Submit>
              </FormActions>
            </Form>
            {errors['chats'] ? <p class="field__error" id={fieldId('chats')}>{errors['chats']}</p> : null}
            {s.chats.length === 0 ? <p class="field__hint">{tm('chats.none')}</p> : null}
            {pending.length > 0 ? (
              <>
                <h3>{tm('chats.pending')}</h3>
                {full ? <p class="field__hint">{tm('chats.max', { max: TELEGRAM_MAX_CHATS })}</p> : null}
                <ul class="tg-chats" data-telegram-pending>
                  {pending.map((chat) => (
                    <li class="tg-chat">
                      <ChatTitle chat={chat} tm={tm} />
                      <div class="form-actions">
                        {full ? null : <ChatAction action="/telegram/chats/confirm" chatId={chat.id} label={tm('chats.confirm')} variant="primary" />}
                        <ChatAction action="/telegram/chats/ignore" chatId={chat.id} label={tm('chats.ignore')} />
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {confirmed.length > 0 ? (
              <>
                <h3>{tm('chats.confirmed')}</h3>
                <ul class="tg-chats" data-telegram-confirmed>
                  {confirmed.map((chat) => {
                    const d = props.deliveries.get(chat.id);
                    return (
                      <li class="tg-chat">
                        <ChatTitle chat={chat} tm={tm} />
                        <p class="field__hint">
                          {tm('chats.lastSent')} : {d?.lastSentAt ? <DateTime ms={d.lastSentAt} /> : tm('chats.neverSent')}
                        </p>
                        {d?.lastError ? (
                          <p class="field__error">
                            {tm('chats.problem')} : {chatProblemText(tm, d.lastError)}
                          </p>
                        ) : null}
                        <div class="form-actions">
                          <ChatAction action="/telegram/chats/remove" chatId={chat.id} label={tm('chats.remove')} variant="danger" confirm={tm('chats.removeConfirm')} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
          </>
        ) : (
          <p class="field__hint">{tm('chats.needToken')}</p>
        )}
      </Card>

      <Card title={tm('details.title')} id="telegram-details">
        <Form action="/telegram/details">
          <fieldset class={errors['fields'] ? 'localized field--invalid' : 'localized'} id={fieldId('fields')}>
            <legend class="localized__legend">{tm('details.legend')}</legend>
            <p class="field__hint">{tm('details.hint')}</p>
            {errors['fields'] ? <p class="field__error">{errors['fields']}</p> : null}
            {TELEGRAM_FIELDS.map((f) => (
              <div class="field field--check">
                <input type="checkbox" class="check" id={fieldId('field', f)} name={`field_${f}`} value="1" checked={s.fields.includes(f)} />
                <label for={fieldId('field', f)}>{tm(`field.${f}`)}</label>
              </div>
            ))}
          </fieldset>
          <Select
            name="lang"
            label={tm('details.lang')}
            value={s.lang}
            error={errors['lang']}
            options={[
              { value: 'fr', label: tm('lang.fr') },
              { value: 'ar', label: tm('lang.ar') },
            ]}
          />
          <FormActions>
            <Submit>{tm('details.save')}</Submit>
          </FormActions>
        </Form>
        <h3 id="telegram-preview-title">{tm('details.preview')}</h3>
        <pre class="tg-preview" dir="auto" aria-labelledby="telegram-preview-title" tabindex={0}>{preview}</pre>
      </Card>

      <Card title={tm('test.title')} id="telegram-test">
        <p class="field__hint">{tm('test.help')}</p>
        {errors['test'] ? <p class="field__error" id={fieldId('test')}>{errors['test']}</p> : null}
        {ready ? (
          <Form action="/telegram/test">
            <FormActions>
              <Submit variant="secondary">{tm('test.send')}</Submit>
            </FormActions>
          </Form>
        ) : (
          <p class="field__hint">{tm('test.needs')}</p>
        )}
      </Card>
    </>
  );
}
