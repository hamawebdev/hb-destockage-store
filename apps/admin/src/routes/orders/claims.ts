// AORD-2 — call claims: a soft, expiring lock so two confirmers do not phone the same customer
// (artifacts/AORD-0/plan.md §5). A claim is not business data: it never bumps `orders.version`
// (so it never invalidates a colleague's open form), and DB-4 clears it when a call is logged.
// Every statement is a Drizzle query builder: raw `db.run(sql)` items fail inside a D1 batch.

import type { Context } from 'hono';
import { and, eq, gt, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { orders } from '@hb/db';
import { CALLABLE_STATUSES } from '@hb/shared';
import { audit } from '../../audit/audit.ts';
import type { AppEnv } from '../../env.ts';

export const CLAIM_MS = 10 * 60_000;

/** `new`, `called`, `unreachable` from @hb/shared, as bound parameters. */
const CALLABLE = sql.join(CALLABLE_STATUSES.map((st) => sql`${st}`), sql`, `);

/** The claim is free, expired, or already mine. */
export const claimable = (userId: number, now: number): SQL =>
  or(isNull(orders.claimedUntil), lt(orders.claimedUntil, now), eq(orders.claimedByUserId, userId)) as SQL;

type Changes = { meta?: { changes?: number } };
const changed = (r: unknown) => ((r as Changes).meta?.changes ?? 0) > 0;

/** My active claim on another order, if any. */
async function currentClaim(c: Context<AppEnv>, now: number, except: number): Promise<number | null> {
  const [row] = await c.var.db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.claimedByUserId, c.var.user.id), gt(orders.claimedUntil, now), ne(orders.id, except)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Claims `orderId` for the current user for CLAIM_MS (renews my own claim), releasing my claim on
 * any other order in the same batch (one claim per user). Each audit row comes right before its
 * UPDATE with the identical condition, so inside the batch (one transaction) the row is written
 * exactly when the change is. Returns false when the order is not callable or someone else's claim
 * is still running.
 */
export async function claimOrder(c: Context<AppEnv>, orderId: number, now = Date.now()): Promise<boolean> {
  const db = c.var.db;
  const me = c.var.user.id;
  const until = now + CLAIM_MS;
  const prev = await currentClaim(c, now, orderId);

  const canClaim = sql`exists (select 1 from orders where id = ${orderId} and status in (${CALLABLE}) and (claimed_until is null or claimed_until < ${now} or claimed_by_user_id = ${me}))`;
  const claimAudit = audit(
    c,
    { action: 'order.claim', entity: 'orders', entityId: orderId, before: null, after: { claimedByUserId: me, claimedUntil: until } },
    { when: canClaim },
  );
  const claim = db.update(orders).set({ claimedByUserId: me, claimedUntil: until }).where(and(eq(orders.id, orderId), canClaim));

  if (prev === null) {
    const results = await db.batch([claimAudit, claim]);
    return changed(results[1]);
  }
  const releasePrev = sql`${canClaim} and exists (select 1 from orders where id = ${prev} and claimed_by_user_id = ${me})`;
  const releaseAudit = audit(
    c,
    { action: 'order.release', entity: 'orders', entityId: prev, before: { claimedByUserId: me }, after: { claimedByUserId: null, reason: 'claimed_other' } },
    { when: releasePrev },
  );
  const release = db.update(orders).set({ claimedByUserId: null, claimedUntil: null }).where(and(eq(orders.id, prev), releasePrev));
  const results = await db.batch([releaseAudit, release, claimAudit, claim]);
  return changed(results[3]);
}

/** Releases a claim: my own, or anyone's for the owner. False when there was nothing to release. */
export async function releaseOrder(c: Context<AppEnv>, orderId: number): Promise<boolean> {
  const db = c.var.db;
  const me = c.var.user.id;
  const [row] = await db.select({ by: orders.claimedByUserId }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!row || row.by === null) return false;
  const holder = row.by;
  if (c.var.user.role !== 'owner' && holder !== me) return false;
  const cond = sql`exists (select 1 from orders where id = ${orderId} and claimed_by_user_id = ${holder})`;
  const releaseAudit = audit(
    c,
    { action: 'order.release', entity: 'orders', entityId: orderId, before: { claimedByUserId: holder }, after: { claimedByUserId: null } },
    { when: cond },
  );
  const release = db.update(orders).set({ claimedByUserId: null, claimedUntil: null }).where(and(eq(orders.id, orderId), cond));
  const results = await db.batch([releaseAudit, release]);
  return changed(results[1]);
}
