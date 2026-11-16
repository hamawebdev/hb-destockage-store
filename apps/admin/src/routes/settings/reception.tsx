// "Order reception" on /settings (TGS-4): where new orders arrive besides the admin. Two read-only
// cards, Telegram and Google Sheets, each saying in plain words what is on, what went wrong and the
// one thing to do, with the button that does it. Owner only (the cards follow the two permissions).
// Reads only; every action posts to the feature's own routes (/telegram, /sheets).
import type { Context } from 'hono';
import type { SheetsConnection } from '@hb/db';
import { confirmedTelegramChats } from '@hb/shared/telegram';
import { can } from '../../auth/permissions.ts';
import type { AppEnv } from '../../env.ts';
import { StatusBadge, type Tone } from '../../ui/badge.tsx';
import { Form, Submit } from '../../ui/form.tsx';
import { Bdi, DateTime, Num } from '../../ui/format.tsx';
import { Card } from '../../ui/kit.tsx';
import { errorText, lastWrittenAt, pendingCount, readConnection, sheetLink, sheetsConfigured } from '../sheets/index.tsx';
import { m as sheetsMessages } from '../sheets/messages.ts';
import { readTelegramState, type TelegramState } from '../telegram/data.ts';
import { tm as telegramMessages } from '../telegram/messages.ts';
import { problemText } from '../telegram/view.tsx';
import { rm } from './reception-messages.ts';

type Ctx = Context<AppEnv>;

export interface SheetsCardData {
  configured: boolean;
  conn: SheetsConnection;
  lastWritten: number | null;
  pending: number | null;
  link: string | null;
}

export interface ReceptionData {
  telegram: TelegramState | null;
  sheets: SheetsCardData | null;
}

export async function loadReception(c: Ctx): Promise<ReceptionData> {
  const user = c.var.user;
  let sheets: SheetsCardData | null = null;
  if (can(user, 'sheets.settings')) {
    const conn = await readConnection(c);
    const off = conn.status === 'disconnected';
    sheets = {
      configured: await sheetsConfigured(c.env),
      conn,
      lastWritten: off ? null : await lastWrittenAt(c, conn.generation),
      pending: conn.status === 'connected' ? await pendingCount(c, conn.generation) : null,
      link: conn.spreadsheetId ? sheetLink(c.env, conn.spreadsheetId) : null,
    };
  }
  return { telegram: can(user, 'telegram.settings') ? await readTelegramState(c) : null, sheets };
}

function TelegramCard(props: { c: Ctx; state: TelegramState }) {
  const tm = telegramMessages(props.c.var.lang);
  const t = rm(props.c.var.lang);
  const { settings: s, status } = props.state;
  const confirmed = confirmedTelegramChats(s).length;
  return (
    <Card title={tm('title')} id="reception-telegram">
      <div data-reception="telegram" data-state={s.enabled ? 'on' : 'off'}>
        <p>{tm('card.what')}</p>
        <dl class="details">
          <dt>{t('state')}</dt>
          <dd>
            <StatusBadge tone={s.enabled ? 'success' : 'neutral'} label={tm(s.enabled ? 'state.on' : 'state.off')} />
          </dd>
          <dt>{tm('card.bot')}</dt>
          <dd>{s.bot ? <Bdi>@{s.bot.username}</Bdi> : tm('card.noBot')}</dd>
          <dt>{tm('card.chats')}</dt>
          <dd><Num value={confirmed} /></dd>
          <dt>{tm('card.fields')}</dt>
          <dd>{s.fields.map((f) => tm(`field.${f}`)).join(props.c.var.lang === 'ar' ? '، ' : ', ')}</dd>
          <dt>{tm('state.lastOk')}</dt>
          <dd>{status.lastOkAt ? <DateTime ms={status.lastOkAt} /> : tm('state.never')}</dd>
        </dl>
        {s.enabled && confirmed === 0 ? <div class="callout callout--warning"><p>{tm('state.noChats')}</p></div> : null}
        {status.lastErrorCode ? (
          <div class="callout callout--warning" data-reception-problem={status.lastErrorCode}>
            <p>
              <strong>{tm('state.problem')} :</strong> {problemText(tm, status.lastErrorCode)}
              {status.lastErrorAt ? <> (<DateTime ms={status.lastErrorAt} />)</> : null}
            </p>
          </div>
        ) : null}
        <div class="form-actions">
          <a class="btn btn--primary" href="/telegram">{tm('card.manage')}</a>
        </div>
      </div>
    </Card>
  );
}

type SheetsState = 'off' | 'disconnected' | 'connected' | 'needs_reconnect' | 'sheet_lost' | 'layout_changed';
const SHEETS_TONE: Readonly<Record<SheetsState, Tone>> = { off: 'neutral', disconnected: 'neutral', connected: 'success', needs_reconnect: 'danger', sheet_lost: 'danger', layout_changed: 'warning' };

function SheetsCard(props: { c: Ctx; data: SheetsCardData }) {
  const { c, data } = props;
  const t = rm(c.var.lang);
  const ts = sheetsMessages(c.var.lang);
  const { conn } = data;
  const email = c.var.user.email;
  // Without a Google client on the server nothing can be connected or reconnected: say so, no dead button.
  const state: SheetsState = !data.configured ? 'off' : conn.status;
  const badge = state === 'off' || state === 'disconnected' || state === 'connected' ? state : 'stopped';
  const live = state === 'connected' || state === 'sheet_lost' || state === 'layout_changed';
  const stopped = state === 'needs_reconnect' || state === 'sheet_lost' || state === 'layout_changed';
  return (
    <Card title={t('sheets.title')} id="reception-sheets">
      <div data-reception="sheets" data-state={state}>
        <p>{t('sheets.what')}</p>
        <dl class="details">
          <dt>{t('state')}</dt>
          <dd>
            <StatusBadge tone={SHEETS_TONE[state]} label={t(`sheets.badge.${badge}`)} />
          </dd>
          {state !== 'off' && state !== 'disconnected' && conn.googleEmail ? (
            <>
              <dt>{t('sheets.account')}</dt>
              <dd><Bdi>{conn.googleEmail}</Bdi></dd>
            </>
          ) : null}
          {live ? (
            <>
              <dt>{t('sheets.lastWritten')}</dt>
              <dd data-sheets-last-written>{data.lastWritten ? <DateTime ms={data.lastWritten} /> : t('sheets.lastWritten.none')}</dd>
            </>
          ) : null}
          {state === 'connected' && data.pending !== null ? (
            <>
              <dt>{t('sheets.pending')}</dt>
              <dd><Num value={data.pending} /></dd>
            </>
          ) : null}
        </dl>
        {state === 'off' ? <div class="callout callout--warning"><p>{t('sheets.notConfigured')}</p></div> : null}
        {state === 'disconnected' ? <p class="field__hint">{t('sheets.connectHint', { email })}</p> : null}
        {state === 'connected' && conn.tabId === null ? <p class="field__hint">{t('sheets.creating')}</p> : null}
        {stopped ? (
          <div class="callout callout--warning" data-reception-problem={state}>
            <p><strong>{t('sheets.problem')} :</strong> {t(`sheets.${state}`, { email })}</p>
          </div>
        ) : null}
        {state === 'connected' && conn.lastErrorCode ? (
          <div class="callout callout--warning" data-reception-problem="last_error">
            <p>
              <strong>{t('sheets.problem')} :</strong> {t('sheets.lastError', { error: errorText(ts, conn.lastErrorCode) })} <a href="/sheets">{t('sheets.detail')}</a>
            </p>
          </div>
        ) : null}
        <div class="form-actions">
          {state === 'disconnected' ? <a class="btn btn--primary" href="/sheets/connect">{t('sheets.connect')}</a> : null}
          {state === 'needs_reconnect' ? <a class="btn btn--primary" href="/sheets/connect">{t('sheets.reconnect')}</a> : null}
          {state === 'sheet_lost' || state === 'layout_changed' ? (
            <>
              <Form action="/sheets/resync" class="form-actions">
                <Submit variant="primary">{ts('action.resync')}</Submit>
              </Form>
              <Form action="/sheets/new-sheet" class="form-actions" confirm={ts('confirm.newSheet')}>
                <Submit variant="secondary">{ts('action.newSheet')}</Submit>
              </Form>
            </>
          ) : null}
          {live && data.link ? (
            <a class="btn btn--secondary" href={data.link} rel="noopener noreferrer" target="_blank">{t('sheets.open')}</a>
          ) : null}
          {state !== 'off' && state !== 'disconnected' ? <a class="btn btn--secondary" href="/sheets">{t('sheets.manage')}</a> : null}
        </div>
      </div>
    </Card>
  );
}

export function Reception(props: { c: Ctx; data: ReceptionData }) {
  const { c, data } = props;
  if (data.telegram === null && data.sheets === null) return null;
  const t = rm(c.var.lang);
  return (
    <section id="reception" aria-labelledby="reception-title">
      <h2 id="reception-title">{t('title')}</h2>
      <p>{t('intro')}</p>
      {data.telegram ? <TelegramCard c={c} state={data.telegram} /> : null}
      {data.sheets ? <SheetsCard c={c} data={data.sheets} /> : null}
    </section>
  );
}
