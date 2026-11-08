// AORD-4 — customers: search, filters and the D1 reads. Plan: artifacts/AORD-4/plan.md.
// Every read selects through admin-core's customerColumns(user) (lib/projection.ts): without
// `customers.sensitive` (logistics) the counts, flags, blocked state, notes and last order date
// are never fetched.

import { and, desc, eq, gt, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { adminUsers, auditLog, customers, orders, type Db } from '@hb/db';
import { normalizePhone, type AdminRole, type OrderStatus } from '@hb/shared';
import { decodeCursor, type Cursor } from '../../lib/pagination.ts';
import { canSeeSensitive, customerColumns } from '../../lib/projection.ts';
import type { CurrentUser } from '../../env.ts';

export const CUSTOMERS_PAGE_SIZE = 50;
export const HISTORY_PAGE_SIZE = 20;
export const SEARCH_MAX_CHARS = 64;

// ---------------------------------------------------------------------------------------------
// Name normalisation — the same rule as web's duplicate check (apps/web/src/order/place.ts):
// Unicode NFC, invisible/bidi marks removed, whitespace collapsed, lower case. ("Mohamed" and
// "mohamed  " are the same name.) @hb/shared has no Arabic letter folding yet (GEO-5's lives in
// data/geo); when it does, both sides switch to it.

const INVISIBLE = /[­​-‏‪-‮⁦-⁩﻿]/g;

export function normalizeName(s: string): string {
  return s.normalize('NFC').replace(INVISIBLE, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** SQL side of normalizeName on the stored name (NFC and mark removal happen at order time). */
const NAME_KEY = sql`replace(replace(replace(lower(trim(${customers.name})), '   ', ' '), '  ', ' '), '  ', ' ')`;

export type CustomerSearch = { kind: 'phone'; e164: string } | { kind: 'name'; term: string };

export function classifyCustomerSearch(raw: string): CustomerSearch | null {
  const capped = raw.slice(0, SEARCH_MAX_CHARS);
  const phone = normalizePhone(capped);
  if (phone.ok) return { kind: 'phone', e164: phone.e164 };
  const term = normalizeName(capped);
  return term === '' ? null : { kind: 'name', term };
}

// ---------------------------------------------------------------------------------------------
// List

export type CustomerInvalid = 'after' | 'restricted';

export interface CustomersFilter {
  search: CustomerSearch | null;
  blocked: boolean;
  flagged: boolean;
  returns: boolean;
  after: Cursor | null;
}

export function parseCustomersFilter(params: URLSearchParams, role: AdminRole): { filter: CustomersFilter; invalid: CustomerInvalid[] } {
  const invalid = new Set<CustomerInvalid>();
  const sensitive = canSeeSensitive({ role });
  const flag = (name: string) => {
    const on = params.get(name) === '1';
    if (on && !sensitive) invalid.add('restricted');
    return on && sensitive;
  };
  let after: Cursor | null = null;
  const rawAfter = params.get('after') ?? '';
  if (rawAfter !== '') {
    after = decodeCursor(rawAfter);
    if (!after) invalid.add('after');
  }
  return {
    filter: {
      search: classifyCustomerSearch(params.get('q') ?? ''),
      blocked: flag('blocked'),
      flagged: flag('flagged'),
      returns: flag('returns'),
      after,
    },
    invalid: [...invalid],
  };
}

export function customersWhere(f: CustomersFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (f.search?.kind === 'phone') conds.push(eq(customers.phoneE164, f.search.e164));
  if (f.search?.kind === 'name') conds.push(sql`instr(${NAME_KEY}, ${f.search.term}) > 0`);
  if (f.blocked) conds.push(eq(customers.blocked, true));
  if (f.flagged) conds.push(sql`${customers.flags} <> '[]'`);
  if (f.returns) conds.push(gt(customers.returnedCount, 0));
  if (f.after) conds.push(or(lt(customers.createdAt, f.after.at), and(eq(customers.createdAt, f.after.at), lt(customers.id, f.after.id))) as SQL);
  return conds.length > 0 ? and(...conds) : undefined;
}

export function customersListQuery(db: Db, user: Pick<CurrentUser, 'role'>, f: CustomersFilter) {
  return db
    .select(customerColumns(user))
    .from(customers)
    .where(customersWhere(f))
    .orderBy(desc(customers.createdAt), desc(customers.id))
    .limit(CUSTOMERS_PAGE_SIZE + 1);
}

// ---------------------------------------------------------------------------------------------
// Detail

export function fetchCustomer(db: Db, user: Pick<CurrentUser, 'role'>, id: number) {
  return db.select(customerColumns(user)).from(customers).where(eq(customers.id, id)).limit(1);
}

export const BLOCK_ACTIONS = ['customer.block', 'customer.unblock'] as const;

/** Who blocked/unblocked last, when, and why (from the audit log). Sensitive roles only. */
export async function lastBlockChange(db: Db, id: number) {
  const [row] = await db
    .select({ action: auditLog.action, at: auditLog.at, after: auditLog.after, actorName: adminUsers.name, actorEmail: auditLog.actorEmail })
    .from(auditLog)
    .leftJoin(adminUsers, eq(adminUsers.id, auditLog.actorUserId))
    .where(and(eq(auditLog.entity, 'customers'), eq(auditLog.entityId, String(id)), inArray(auditLog.action, [...BLOCK_ACTIONS])))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(1);
  if (!row) return null;
  const after = (row.after ?? {}) as { reason?: unknown };
  return {
    action: row.action as (typeof BLOCK_ACTIONS)[number],
    at: row.at,
    by: row.actorName ?? row.actorEmail ?? '?',
    reason: typeof after.reason === 'string' ? after.reason : null,
  };
}

export interface HistoryRow {
  id: number;
  ref: string;
  createdAt: number;
  status: OrderStatus;
  totalDzd: number;
}

/** The customer's orders, newest first (index orders(customer_id, created_at)). Sensitive roles only. */
export function customerOrdersQuery(db: Db, customerId: number, after: Cursor | null) {
  const where = after
    ? and(eq(orders.customerId, customerId), or(lt(orders.createdAt, after.at), and(eq(orders.createdAt, after.at), lt(orders.id, after.id))))
    : eq(orders.customerId, customerId);
  return db
    .select({ id: orders.id, ref: orders.ref, createdAt: orders.createdAt, status: orders.status, totalDzd: orders.totalDzd })
    .from(orders)
    .where(where)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(HISTORY_PAGE_SIZE + 1);
}

