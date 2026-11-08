import { EmailProvider, type EmailMessageFactory, type SendEmailBinding } from './email.ts';
import type { NotificationProvider } from './provider.ts';
import { TelegramProvider } from './telegram.ts';

export interface NotifyEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  NOTIFY_EMAIL?: SendEmailBinding;
  NOTIFY_EMAIL_FROM?: string;
  NOTIFY_EMAIL_TO?: string;
}

const set = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

export function telegramEnabled(env: NotifyEnv): boolean {
  return set(env.TELEGRAM_BOT_TOKEN) && set(env.TELEGRAM_CHAT_ID);
}

export function emailEnabled(env: NotifyEnv): boolean {
  return env.NOTIFY_EMAIL !== undefined && set(env.NOTIFY_EMAIL_FROM) && set(env.NOTIFY_EMAIL_TO);
}

/**
 * Builds only the providers whose secrets/bindings are all present. With nothing set the list is
 * empty and the consumer makes no network call.
 */
export function buildProviders(
  env: NotifyEnv,
  opts: { fetch?: typeof fetch; makeEmailMessage?: EmailMessageFactory } = {},
): NotificationProvider[] {
  const out: NotificationProvider[] = [];
  if (telegramEnabled(env)) {
    out.push(
      new TelegramProvider({
        botToken: env.TELEGRAM_BOT_TOKEN!.trim(),
        chatId: env.TELEGRAM_CHAT_ID!.trim(),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      }),
    );
  }
  if (emailEnabled(env)) {
    if (!opts.makeEmailMessage) throw new Error('email enabled but no EmailMessage factory');
    out.push(
      new EmailProvider({
        binding: env.NOTIFY_EMAIL!,
        from: env.NOTIFY_EMAIL_FROM!.trim(),
        to: env.NOTIFY_EMAIL_TO!.trim(),
        makeMessage: opts.makeEmailMessage,
      }),
    );
  }
  return out;
}
