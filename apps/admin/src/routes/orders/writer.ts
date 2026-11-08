// AORD-2 — the write seam between the orders handlers and DB-4 (`@hb/db` orders.ts).
//
// `applyChange` turns a workflow plan (workflow.ts) into DB-4's `applyOrderChange(db, change, extra)`
// with admin-core's audit row as the `extra` item, guarded by the same `orders.version` condition
// (`orderGuard`), so a 409 writes nothing at all — no event, no stock, no audit row
// (artifacts/AORD-0/plan.md §6; artifacts/DB-4/plan.md §4).

import type { Context } from 'hono';
import { applyOrderChange, orderGuard, type ApplyOrderChangeResult, type OrderChange } from '@hb/db';
import { audit } from '../../audit/audit.ts';
import type { AppEnv } from '../../env.ts';
import type { OrderChangePlan } from './workflow.ts';

export type ApplyResult = ApplyOrderChangeResult;
export { orderGuard };

/** The DB-4 change for a plan (exported for tests). */
export function changeOf(c: Context<AppEnv>, orderId: number, plan: OrderChangePlan, now: number): OrderChange {
  return {
    orderId,
    expectedVersion: plan.expectedVersion,
    actor: { userId: c.var.user.id, role: c.var.user.role },
    hops: plan.hops,
    patch: plan.patch,
    now,
    ...(plan.callAttempt ? { callAttempt: plan.callAttempt } : {}),
    ...(plan.outcome !== undefined ? { outcome: plan.outcome } : {}),
    ...(plan.note !== undefined ? { note: plan.note } : {}),
  };
}

export const orderWriter = {
  async applyChange(c: Context<AppEnv>, orderId: number, plan: OrderChangePlan, now: number): Promise<ApplyResult> {
    const row = audit(
      c,
      { action: plan.audit.action, entity: 'orders', entityId: orderId, before: plan.audit.before, after: plan.audit.after },
      { when: orderGuard(orderId, plan.expectedVersion) },
    );
    return applyOrderChange(c.var.db, changeOf(c, orderId, plan, now), [row]);
  },
};
