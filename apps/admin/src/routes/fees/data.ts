/**
 * Delivery-fee reads and the apply batch (ACAT-4, plan §2). One D1 batch: per changed wilaya a
 * version guard (lib/guard.ts: aborts the whole batch if the row moved since the form was rendered,
 * or appeared for a wilaya that had none), the UPDATE / INSERT, and its `fee.update` audit row.
 */
import { asc, eq, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Context } from 'hono';
import { adminUsers, deliveryFees, wilayas } from '@hb/db';
import { audit } from '../../audit/audit.ts';
import type { AppEnv } from '../../env.ts';
import { bumpUpdatedAt } from '../products/lib/diff.ts';
import { guard, versionGuard } from '../products/lib/guard.ts';
import type { Change, CurrentRow } from './core.ts';

type Ctx = Context<AppEnv>;

export interface FeeTableRow {
  code: number;
  nameFr: string;
  nameAr: string;
  fee: (CurrentRow & { updatedAt: number; updatedByEmail: string | null }) | null;
}

/** All 69 wilayas, with their fee row when there is one. */
export async function loadFeeTable(c: Ctx): Promise<FeeTableRow[]> {
  const rows = await c.var.db
    .select({
      code: wilayas.code,
      nameFr: wilayas.nameFr,
      nameAr: wilayas.nameAr,
      feeDzd: deliveryFees.feeDzd,
      available: deliveryFees.available,
      placeholder: deliveryFees.placeholder,
      updatedAt: deliveryFees.updatedAt,
      updatedByEmail: adminUsers.email,
    })
    .from(wilayas)
    .leftJoin(deliveryFees, eq(deliveryFees.wilayaCode, wilayas.code))
    .leftJoin(adminUsers, eq(adminUsers.id, deliveryFees.updatedBy))
    .orderBy(asc(wilayas.code));
  return rows.map((r) => ({
    code: r.code,
    nameFr: r.nameFr,
    nameAr: r.nameAr,
    fee:
      r.feeDzd === null || r.updatedAt === null
        ? null
        : { code: r.code, feeDzd: r.feeDzd, available: r.available === true, placeholder: r.placeholder === true, version: r.updatedAt, updatedAt: r.updatedAt, updatedByEmail: r.updatedByEmail },
  }));
}

export function currentMap(table: readonly FeeTableRow[]): Map<number, CurrentRow> {
  return new Map(table.flatMap((r) => (r.fee === null ? [] : [[r.code, r.fee] as const])));
}

/** Applies the changes in one batch. Throws a guard abort (→ 409) when any row moved meanwhile. */
export async function applyFees(c: Ctx, changes: readonly Change[]): Promise<void> {
  const db = c.var.db;
  const user = c.var.user.id;
  const guards: BatchItem<'sqlite'>[] = [];
  const writes: BatchItem<'sqlite'>[] = [];
  const audits: BatchItem<'sqlite'>[] = [];
  for (const ch of changes) {
    if (ch.before === null) {
      guards.push(guard(db, sql`not exists (select 1 from ${deliveryFees} where ${deliveryFees.wilayaCode} = ${ch.code})`));
      writes.push(db.insert(deliveryFees).values({ wilayaCode: ch.code, feeDzd: ch.after.feeDzd, available: ch.after.available, placeholder: false, updatedBy: user }));
    } else {
      guards.push(versionGuard(db, 'delivery_fees', 'wilaya_code', ch.code, ch.version));
      writes.push(
        db
          .update(deliveryFees)
          .set({ feeDzd: ch.after.feeDzd, available: ch.after.available, placeholder: ch.after.placeholder, updatedBy: user, updatedAt: bumpUpdatedAt() })
          .where(eq(deliveryFees.wilayaCode, ch.code)),
      );
    }
    audits.push(audit(c, { action: 'fee.update', entity: 'delivery_fees', entityId: ch.code, before: ch.before, after: ch.after }));
  }
  if (writes.length === 0) return;
  await db.batch([...guards, ...writes, ...audits] as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}
