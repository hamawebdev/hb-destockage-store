// Notification channel interface. Providers are constructed only when their secrets are set
// (see providers.ts); a provider that exists is enabled.

export interface StaffNotification {
  /** Stable id of the event, e.g. 'order-42' or 'backup-20261104T020000Z'; used for the email Message-ID. */
  id: string;
  subject: string;
  text: string;
}

export interface NotificationProvider {
  /** Stable channel id, part of the dedupe key. */
  readonly channel: string;
  send(n: StaffNotification): Promise<void>;
}

/** Failure that may succeed later (network, 5xx, 429). */
export class TransientError extends Error {
  override readonly name = 'TransientError';
  constructor(
    message: string,
    /** Provider-requested wait, seconds (e.g. Telegram retry_after). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Failure that retrying will not fix (bad token, unknown chat, rejected sender). */
export class PermanentError extends Error {
  override readonly name = 'PermanentError';
}
