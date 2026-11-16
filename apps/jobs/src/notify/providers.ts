import { EmailProvider, type EmailMessageFactory, type SendEmailBinding } from './email.ts';
import type { NotificationProvider } from './provider.ts';

export interface NotifyEnv {
  NOTIFY_EMAIL?: SendEmailBinding;
  NOTIFY_EMAIL_FROM?: string;
  NOTIFY_EMAIL_TO?: string;
}

const set = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

export function emailEnabled(env: NotifyEnv): boolean {
  return env.NOTIFY_EMAIL !== undefined && set(env.NOTIFY_EMAIL_FROM) && set(env.NOTIFY_EMAIL_TO);
}

/**
 * Builds only the providers whose secrets/bindings are all present. With nothing set the list is
 * empty and the consumer makes no network call. Email only: Telegram is configured in the admin
 * and has its own path (./telegram.ts, TGS-2), it is not an env-driven provider any more.
 */
export function buildProviders(
  env: NotifyEnv,
  opts: { makeEmailMessage?: EmailMessageFactory } = {},
): NotificationProvider[] {
  const out: NotificationProvider[] = [];
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
