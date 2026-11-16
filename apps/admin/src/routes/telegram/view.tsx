// The /telegram page (TGS-4). Rendering only: no reads, no writes. The token input never carries a
// value. Chat titles come from Telegram users: text nodes only (escaped by JSX), inside <bdi>.
// Existing admin.css classes only (this branch does not own the stylesheet): `dl.details` wraps long
// values, `.plain-list` + `.callout` make the one-column chat list, `.table-wrap` keeps a long
// preview line scrolling inside its box instead of widening the page at 360 px.
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

/** Type and title as the first pair of a chat's `dl.details` (its dd wraps anywhere). */
const ChatTitle = (props: { chat: TelegramChat; tm: Tm }) => (
  <>
    <dt>{props.tm(`type.${props.chat.type}`)}</dt>
    <dd>
      <strong>
        <bdi>{props.chat.title}</bdi>
      </strong>
    </dd>
  </>
);

function ChatAction(props: { action: string; chatId: string; label: string; variant?: 'primary' | 'secondary' | 'danger'; confirm?: string }) {
  return (
    <Form action={props.action} class="form-actions" {...(props.confirm ? { confirm: props.confirm } : {})}>
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
            <ul class="plain-list">
              {props.testResults.map((r) => (
                <li class="callout">
                  <dl class="details">
                    <ChatTitle chat={r.chat} tm={tm} />
                  </dl>
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
        <dl class="details">
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
        <dl class="details">
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
              <a class="btn btn--secondary" href={`https://t.me/${bot.username}`} rel="noopener noreferrer" target="_blank">
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
                <ul class="plain-list" data-telegram-pending>
                  {pending.map((chat) => (
                    <li class="callout">
                      <dl class="details">
                        <ChatTitle chat={chat} tm={tm} />
                      </dl>
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
                <ul class="plain-list" data-telegram-confirmed>
                  {confirmed.map((chat) => {
                    const d = props.deliveries.get(chat.id);
                    return (
                      <li class="callout">
                        <dl class="details">
                          <ChatTitle chat={chat} tm={tm} />
                          <dt>{tm('chats.lastSent')}</dt>
                          <dd>{d?.lastSentAt ? <DateTime ms={d.lastSentAt} /> : tm('chats.neverSent')}</dd>
                          {d?.lastError ? (
                            <>
                              <dt>{tm('chats.problem')}</dt>
                              <dd>{chatProblemText(tm, d.lastError)}</dd>
                            </>
                          ) : null}
                        </dl>
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
        <div>
          <div class="callout table-wrap" tabindex={0} role="group" aria-labelledby="telegram-preview-title">
            <pre dir="auto" data-telegram-preview>{preview}</pre>
          </div>
        </div>
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
