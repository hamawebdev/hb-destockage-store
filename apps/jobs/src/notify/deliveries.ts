// Per-(order, channel) delivery ledger over DB-1's `notification_deliveries`. Makes the consumer
// idempotent across Queue redelivery, retries and concurrent consumers. At-least-once: a crash
// between send and markSent can repeat one notification; nothing else does.

export type ClaimResult =
  /** This consumer owns the delivery and must send, then markSent or release. */
  | 'claimed'
  /** Already delivered: skip. */
  | 'sent'
  /** Given up and dead-lettered (JOBS-6, DB-7): terminal, shown in the admin; skip. */
  | 'dead'
  /** Another consumer holds a live lease: retry the message later. */
  | 'busy';

export interface DeliveryStore {
  claim(orderId: number, channel: string, now: number, leaseMs: number): Promise<ClaimResult>;
  markSent(orderId: number, channel: string, now: number): Promise<void>;
  /**
   * Give the lease back after a failure so a later delivery can claim it. `error` is a fixed,
   * data-free label (e.g. 'telegram: HTTP 400'), stored in `last_error` for the admin.
   */
  release(orderId: number, channel: string, error: string): Promise<void>;
}

export class D1DeliveryStore implements DeliveryStore {
  constructor(private readonly db: D1Database) {}

  async claim(orderId: number, channel: string, now: number, leaseMs: number): Promise<ClaimResult> {
    // Atomic: insert a new claim, or take over a released/expired one. A live lease or a 'sent'
    // row fails the upsert's WHERE, so RETURNING yields nothing.
    const won = await this.db
      .prepare(
        `INSERT INTO notification_deliveries (order_id, channel, status, attempts, lease_until)
         VALUES (?1, ?2, 'sending', 1, ?3)
         ON CONFLICT (order_id, channel) DO UPDATE SET
           attempts = notification_deliveries.attempts + 1,
           lease_until = excluded.lease_until
         WHERE notification_deliveries.status = 'sending'
           AND (notification_deliveries.lease_until IS NULL OR notification_deliveries.lease_until <= ?4)
         RETURNING status`,
      )
      .bind(orderId, channel, now + leaseMs, now)
      .first<{ status: string }>();
    if (won) return 'claimed';
    const row = await this.db
      .prepare('SELECT status FROM notification_deliveries WHERE order_id = ?1 AND channel = ?2')
      .bind(orderId, channel)
      .first<{ status: string }>();
    if (row?.status === 'sent' || row?.status === 'dead') return row.status;
    return 'busy';
  }

  async markSent(orderId: number, channel: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE notification_deliveries SET status = 'sent', sent_at = ?3, lease_until = NULL, last_error = NULL
         WHERE order_id = ?1 AND channel = ?2`,
      )
      .bind(orderId, channel, now)
      .run();
  }

  async release(orderId: number, channel: string, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE notification_deliveries SET lease_until = NULL, last_error = ?3
         WHERE order_id = ?1 AND channel = ?2 AND status = 'sending'`,
      )
      .bind(orderId, channel, error.slice(0, 200))
      .run();
  }
}

/** In-memory store with the same semantics, for tests. */
export class MemoryDeliveryStore implements DeliveryStore {
  readonly rows = new Map<string, { status: 'sending' | 'sent' | 'dead'; attempts: number; leaseUntil: number | null; lastError: string | null }>();

  async claim(orderId: number, channel: string, now: number, leaseMs: number): Promise<ClaimResult> {
    const k = `${orderId}:${channel}`;
    const r = this.rows.get(k);
    if (!r) {
      this.rows.set(k, { status: 'sending', attempts: 1, leaseUntil: now + leaseMs, lastError: null });
      return 'claimed';
    }
    if (r.status === 'sent' || r.status === 'dead') return r.status;
    if (r.leaseUntil !== null && r.leaseUntil > now) return 'busy';
    r.attempts += 1;
    r.leaseUntil = now + leaseMs;
    return 'claimed';
  }
  async markSent(orderId: number, channel: string): Promise<void> {
    const r = this.rows.get(`${orderId}:${channel}`);
    if (r) Object.assign(r, { status: 'sent', leaseUntil: null, lastError: null });
  }
  async release(orderId: number, channel: string, error: string): Promise<void> {
    const r = this.rows.get(`${orderId}:${channel}`);
    if (r && r.status === 'sending') Object.assign(r, { leaseUntil: null, lastError: error });
  }
}
