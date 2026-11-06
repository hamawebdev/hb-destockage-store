// AORD-3 — call queue: which order a confirmer calls next. Reads only; claiming reuses AORD-2's
// claimOrder (claims.ts). Priority (lead decision, AORD-0 plan §0.5):
//   1. callbacks and retries that are due: `called` with next_call_at <= now (oldest due first);
//   2. the oldest `new` order;
//   3. `unreachable` orders past their retry delay (oldest due first).
// An order someone else holds a running claim on is skipped. A `called`/`unreachable` order with no
// next_call_at (should not happen: every call sets it) counts as due, so nothing is orphaned.

import { and, asc, count, eq, gt, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import { orders, type Db } from '@hb/db';
import { CALLABLE_STATUSES, type OrderStatus } from '@hb/shared';

export type QueueBucket = 'due' | 'new' | 'unreachable';

/** Free, expired, or mine. */
const free = (me: number, now: number): SQL =>
  or(isNull(orders.claimedUntil), lte(orders.claimedUntil, now), eq(orders.claimedByUserId, me)) as SQL;
const due = (now: number): SQL => or(isNull(orders.nextCallAt), lte(orders.nextCallAt, now)) as SQL;

const BUCKETS: Record<QueueBucket, { status: OrderStatus; when: (now: number) => SQL | undefined; order: 'nextCall' | 'created' }> = {
  due: { status: 'called', when: due, order: 'nextCall' },
  new: { status: 'new', when: () => undefined, order: 'created' },
  unreachable: { status: 'unreachable', when: due, order: 'nextCall' },
};
export const QUEUE_ORDER: readonly QueueBucket[] = ['due', 'new', 'unreachable'];

/** Up to `limit` candidates per bucket, in queue order (claim tries them one by one). */
export async function queueCandidates(db: Db, me: number, now: number, limit = 3): Promise<{ id: number; ref: string; bucket: QueueBucket }[]> {
  const lists = await Promise.all(
    QUEUE_ORDER.map((b) => {
      const def = BUCKETS[b];
      return db
        .select({ id: orders.id, ref: orders.ref })
        .from(orders)
        .where(and(eq(orders.status, def.status), def.when(now), free(me, now)))
        .orderBy(...(def.order === 'nextCall' ? [asc(orders.nextCallAt), asc(orders.id)] : [asc(orders.createdAt), asc(orders.id)]))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ ...r, bucket: b })));
    }),
  );
  return lists.flat();
}

/** How many orders wait in each bucket (claimed by someone else included: it is still work). */
export async function queueCounts(db: Db, now: number): Promise<Record<QueueBucket, number>> {
  const [d, nw, u] = await Promise.all(
    QUEUE_ORDER.map((b) => {
      const def = BUCKETS[b];
      return db.select({ n: count() }).from(orders).where(and(eq(orders.status, def.status), def.when(now)));
    }),
  );
  return { due: d![0]?.n ?? 0, new: nw![0]?.n ?? 0, unreachable: u![0]?.n ?? 0 };
}

/** The order I currently hold (running claim on a callable order), if any. A manual cancel does not
 * clear the claim columns (DB-4 clears them on a logged call), hence the status filter. */
export async function myClaim(db: Db, me: number, now: number): Promise<string | null> {
  const [r] = await db
    .select({ ref: orders.ref })
    .from(orders)
    .where(and(eq(orders.claimedByUserId, me), gt(orders.claimedUntil, now), inArray(orders.status, [...CALLABLE_STATUSES])))
    .limit(1);
  return r?.ref ?? null;
}
