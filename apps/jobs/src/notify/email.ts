import { TransientError, type NotificationProvider, type StaffNotification } from './provider.ts';

/** Minimal surface of the Workers `send_email` binding. */
export interface SendEmailBinding {
  send(message: unknown): Promise<unknown>;
}

/** `new EmailMessage(from, to, raw)` from `cloudflare:email`; injected so this module runs in Node tests. */
export type EmailMessageFactory = (from: string, to: string, raw: string) => unknown;

export interface EmailConfig {
  binding: SendEmailBinding;
  from: string;
  to: string;
  makeMessage: EmailMessageFactory;
  /** Domain for Message-ID; defaults to the sender's domain. */
  messageIdDomain?: string;
  now?: () => Date;
}

/**
 * Cloudflare Email Routing `send_email` binding: delivers to a verified staff address,
 * no third-party provider, no API key. Constructed only when binding + from + to are set.
 */
export class EmailProvider implements NotificationProvider {
  readonly channel = 'email';
  readonly #cfg: EmailConfig;

  constructor(cfg: EmailConfig) {
    if (!cfg.from || !cfg.to) throw new Error('EmailProvider requires from and to');
    this.#cfg = cfg;
  }

  async send(n: StaffNotification): Promise<void> {
    const raw = buildMime({
      from: this.#cfg.from,
      to: this.#cfg.to,
      subject: n.subject,
      text: n.text,
      messageId: `<${n.id}.email@${this.#cfg.messageIdDomain ?? domainOf(this.#cfg.from)}>`,
      date: (this.#cfg.now ?? (() => new Date()))(),
    });
    try {
      await this.#cfg.binding.send(this.#cfg.makeMessage(this.#cfg.from, this.#cfg.to, raw));
    } catch {
      // The binding does not tell transient from permanent failures; retries end in the DLQ.
      throw new TransientError('email: send failed');
    }
  }
}

function domainOf(addr: string): string {
  const at = addr.lastIndexOf('@');
  return at >= 0 ? addr.slice(at + 1).replace(/[<>\s]/g, '') : 'localhost';
}

function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function headerSafe(s: string): string {
  if (/[\r\n]/.test(s)) throw new Error('header injection');
  return s;
}

export function buildMime(p: {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  date: Date;
}): string {
  const body = b64utf8(p.text).replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${headerSafe(p.from)}`,
    `To: ${headerSafe(p.to)}`,
    `Subject: =?UTF-8?B?${b64utf8(p.subject)}?=`,
    `Message-ID: ${headerSafe(p.messageId)}`,
    `Date: ${p.date.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}
