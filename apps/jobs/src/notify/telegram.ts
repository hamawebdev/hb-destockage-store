import { PermanentError, TransientError, type NotificationProvider, type StaffNotification } from './provider.ts';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Telegram Bot API sendMessage. Constructed only when both secrets are set. */
export class TelegramProvider implements NotificationProvider {
  readonly channel = 'telegram';
  readonly #cfg: TelegramConfig;

  constructor(cfg: TelegramConfig) {
    if (!cfg.botToken || !cfg.chatId) throw new Error('TelegramProvider requires botToken and chatId');
    this.#cfg = cfg;
  }

  async send(n: StaffNotification): Promise<void> {
    const doFetch = this.#cfg.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`https://api.telegram.org/bot${this.#cfg.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.#cfg.chatId, text: n.text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(this.#cfg.timeoutMs ?? 10_000),
      });
    } catch {
      // Network error or timeout. Never echo the error: it may contain the URL (bot token).
      throw new TransientError('telegram: network error');
    }
    if (res.ok) {
      await res.body?.cancel();
      return;
    }
    let retryAfter: number | undefined;
    try {
      const body = (await res.json()) as { parameters?: { retry_after?: unknown } };
      const ra = body.parameters?.retry_after;
      if (typeof ra === 'number' && ra > 0) retryAfter = ra;
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`telegram: HTTP ${res.status}`, retryAfter);
    }
    throw new PermanentError(`telegram: HTTP ${res.status}`);
  }
}
