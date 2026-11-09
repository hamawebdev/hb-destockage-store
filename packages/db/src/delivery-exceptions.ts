// SHIP-5/6: delivery exceptions beyond `raiseExceptionItem` (shipments.ts). One open row per kind,
// subject and raw status (partial unique index); these helpers raise without counting a repeat, and
// close rows the system has settled by itself.
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from './index.ts';
import { deliveryExceptions } from './schema.ts';
import type { DeliveryExceptionKind } from './enums.ts';
import { clip, type RaiseException } from './shipments.ts';

/** Raises the exception if none is open for it; an open one is left exactly as it is. */
export function raiseExceptionOnceItem(db: Db, e: RaiseException) {
  return db
    .insert(deliveryExceptions)
    .values({
      kind: e.kind,
      subject: e.subject,
      shipmentId: e.shipmentId ?? null,
      orderId: e.orderId ?? null,
      courier: e.courier ?? null,
      rawStatus: e.rawStatus ?? '',
      detail: clip(e.detail),
      createdAt: e.now,
      updatedAt: e.now,
    })
    .onConflictDoUpdate({
      target: [deliveryExceptions.kind, deliveryExceptions.subject, deliveryExceptions.rawStatus],
      targetWhere: sql`state = 'open'`,
      set: { updatedAt: sql`${deliveryExceptions.updatedAt}` },
    });
}

/** The system settled it (a parcel was found, or proven absent): open rows of these kinds close. */
export function autoResolveItem(db: Db, subject: string, kinds: readonly DeliveryExceptionKind[], resolution: string, now: number, when?: SQL) {
  const where = and(eq(deliveryExceptions.subject, subject), inArray(deliveryExceptions.kind, [...kinds]), eq(deliveryExceptions.state, 'open'), when);
  return db.update(deliveryExceptions).set({ state: 'resolved', resolution, resolvedAt: now, updatedAt: now }).where(where);
}

/** A tracking a person marked as made outside this shop (`unmatched_tracking` → foreign parcel). */
export async function isForeignTracking(db: Db, courier: string, tracking: string): Promise<boolean> {
  const rows = await db
    .select({ id: deliveryExceptions.id })
    .from(deliveryExceptions)
    .where(and(eq(deliveryExceptions.kind, 'unmatched_tracking'), eq(deliveryExceptions.subject, `t:${courier}|${tracking}`), eq(deliveryExceptions.resolution, 'foreign')))
    .limit(1);
  return rows.length > 0;
}
