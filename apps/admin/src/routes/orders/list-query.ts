// AORD-1 — orders list: filter parsing, search classification and the SQL conditions.
// Pure (no I/O): the route handler runs the query; tests check the generated SQL.
// Plan: artifacts/AORD-0/plan.md §2.1 and §9 (indexes from DB-1).

import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { customers, orders } from '@hb/db';
import {
  ORDER_STATUSES,
  isOrderStatus,
  isWilayaCode,
  normalizePhone,
  type AdminRole,
  type OrderRef,
  type OrderStatus,
  type PhoneE164,
  type WilayaCode,
} from '@hb/shared';
import { decodeCursor, type Cursor } from '../../lib/pagination.ts';

export const ORDERS_PAGE_SIZE = 50;

/** Longest search term kept. Name search uses `instr()`, which has no D1 pattern-length limit
 * (D1 rejects LIKE/GLOB patterns over ~50 bytes: artifacts/DB-2/d1-smoke.log part 2). */
export const SEARCH_MAX_CHARS = 64;

/** Algeria is UTC+1 all year (no DST since 1981). Calendar-day filters use Algiers days. */
const ALGIERS_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Keyset position `(created_at, id)`; encoded by admin-core's `encodeCursor` as `<at>.<id>`. */
export type OrdersCursor = Cursor;

export type OrdersSearch =
  | { readonly kind: 'phone'; readonly e164: PhoneE164 }
  | { readonly kind: 'ref'; readonly ref: OrderRef }
  /** Five letters, no digit, no `HB` prefix (e.g. "karim"): could be either, so match both. */
  | { readonly kind: 'refOrName'; readonly ref: OrderRef; readonly term: string }
  | { readonly kind: 'name'; readonly term: string };

export type OrdersFilter = {
  /** Empty = every status. */
  readonly statuses: readonly OrderStatus[];
  readonly wilaya: WilayaCode | null;
  /** Inclusive lower bound, ms (start of the Algiers day). */
  readonly fromMs: number | null;
  /** Exclusive upper bound, ms (start of the Algiers day after `to`). */
  readonly toMs: number | null;
  readonly flagged: boolean;
  readonly duplicate: boolean;
  readonly blockedCustomer: boolean;
  readonly search: OrdersSearch | null;
  readonly after: OrdersCursor | null;
};

/** Query-string field that held a value we could not use (shown as a notice; never a 4xx). */
export type InvalidField = 'status' | 'wilaya' | 'from' | 'to' | 'range' | 'after';

export type ParsedOrdersFilter = {
  readonly filter: OrdersFilter;
  readonly invalid: readonly InvalidField[];
  /** True when the role's default statuses were applied (no `status` and no search given). */
  readonly defaulted: boolean;
};

/** What each role sees when it opens the list without choosing statuses (plan §2.1). */
export function defaultStatuses(role: AdminRole): readonly OrderStatus[] {
  switch (role) {
    case 'confirmer':
      return ['new', 'called', 'unreachable'];
    case 'logistics':
      return ['confirmed', 'shipped'];
    default:
      return [];
  }
}

/** `YYYY-MM-DD` (a real calendar date) → ms at 00:00 Africa/Algiers, else null. */
export function algiersDayStartMs(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const check = new Date(utc);
  if (y < 2000 || check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return utc - ALGIERS_OFFSET_MS;
}

/** `HB-7K2Q9`, `hb7k2q9`, `7k2q9`, `HB 7K2Q9` → `HB-7K2Q9`. Crockford look-alikes O→0, I/L→1. */
export function normalizeOrderRef(input: string): OrderRef | null {
  let s = input.toUpperCase().replace(/[\s‎‏⁦-⁩]/g, '');
  s = s.replace(/^HB-?/, '');
  if (s.length !== 5) return null;
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{5}$/.test(s) ? (`HB-${s}` as OrderRef) : null;
}

/**
 * Phone (any accepted form, Eastern-Arabic digits ok) → exact E.164. A ref typed with the `HB`
 * prefix or containing a digit → exact ref. Five letters without either → ref or name. Else name.
 */
export function classifySearch(raw: string): OrdersSearch | null {
  const term = raw.normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, SEARCH_MAX_CHARS);
  if (term === '') return null;
  const phone = normalizePhone(term);
  if (phone.ok) return { kind: 'phone', e164: phone.e164 };
  const ref = normalizeOrderRef(term);
  if (ref) {
    return /^\s*hb/i.test(term) || /\d/.test(term) ? { kind: 'ref', ref } : { kind: 'refOrName', ref, term };
  }
  return { kind: 'name', term };
}

/**
 * GET query → filter. Tolerant: a value we cannot use is dropped and reported in `invalid`.
 * `status` may repeat; `status=any` means every status (overrides the role default).
 */
export function parseOrdersFilter(params: URLSearchParams, role: AdminRole): ParsedOrdersFilter {
  const invalid = new Set<InvalidField>();

  const rawStatuses = params.getAll('status').filter((s) => s !== '');
  let statuses: OrderStatus[] = [];
  let any = false;
  for (const s of rawStatuses) {
    if (s === 'any') any = true;
    else if (isOrderStatus(s)) {
      if (!statuses.includes(s)) statuses.push(s);
    } else invalid.add('status');
  }
  if (any) statuses = [];
  statuses.sort((a, b) => ORDER_STATUSES.indexOf(a) - ORDER_STATUSES.indexOf(b));

  let wilaya: WilayaCode | null = null;
  const rawWilaya = params.get('wilaya') ?? '';
  if (rawWilaya !== '') {
    const n = /^\d{1,2}$/.test(rawWilaya) ? Number(rawWilaya) : NaN;
    if (isWilayaCode(n)) wilaya = n;
    else invalid.add('wilaya');
  }

  const day = (name: 'from' | 'to'): number | null => {
    const v = params.get(name) ?? '';
    if (v === '') return null;
    const ms = algiersDayStartMs(v);
    if (ms === null) invalid.add(name);
    return ms;
  };
  let fromMs = day('from');
  const toDay = day('to');
  let toMs = toDay === null ? null : toDay + DAY_MS;
  if (fromMs !== null && toMs !== null && fromMs >= toMs) {
    invalid.add('range');
    fromMs = null;
    toMs = null;
  }

  const rawQ = params.get('q') ?? '';
  const search = classifySearch(rawQ);

  let after: OrdersCursor | null = null;
  const rawAfter = params.get('after') ?? '';
  if (rawAfter !== '') {
    after = decodeCursor(rawAfter);
    if (!after) invalid.add('after');
  }

  const flag = (name: string) => params.get(name) === '1';

  const defaulted = rawStatuses.length === 0 && search === null;
  if (defaulted) statuses = [...defaultStatuses(role)];

  return {
    filter: {
      statuses,
      wilaya,
      fromMs,
      toMs,
      flagged: flag('flagged'),
      duplicate: flag('duplicate'),
      blockedCustomer: flag('blocked'),
      search,
      after,
    },
    invalid: [...invalid],
    defaulted,
  };
}

/** SQL used by both the flagged filter and the partial index `orders_flagged_created_idx`. */
const FLAGGED = sql`${orders.flags} <> '[]'`;

/** instr(): no D1 LIKE pattern limit, no wildcard escaping. lower() folds ASCII only; Arabic has no case. */
const nameContains = (term: string): SQL => sql`instr(lower(${orders.name}), lower(${term})) > 0`;

/** WHERE for the list. Every branch is backed by a DB-1 index (plan §9). */
export function ordersWhere(f: OrdersFilter): SQL | undefined {
  const conds: SQL[] = [];

  if (f.search) {
    switch (f.search.kind) {
      case 'phone':
        conds.push(eq(orders.phoneE164, f.search.e164));
        break;
      case 'ref':
        conds.push(eq(orders.ref, f.search.ref));
        break;
      case 'refOrName':
        conds.push(or(eq(orders.ref, f.search.ref), nameContains(f.search.term)) as SQL);
        break;
      case 'name':
        conds.push(nameContains(f.search.term));
        break;
    }
  }
  if (f.statuses.length > 0) conds.push(inArray(orders.status, [...f.statuses]));
  if (f.wilaya !== null) conds.push(eq(orders.wilayaCode, f.wilaya));
  if (f.fromMs !== null) conds.push(gte(orders.createdAt, f.fromMs));
  if (f.toMs !== null) conds.push(lt(orders.createdAt, f.toMs));
  if (f.flagged || f.duplicate) conds.push(FLAGGED);
  if (f.duplicate) {
    conds.push(sql`exists (select 1 from json_each(${orders.flags}) where json_each.value = 'duplicate')`);
  }
  if (f.blockedCustomer) {
    conds.push(sql`exists (select 1 from ${customers} where ${customers.id} = ${orders.customerId} and ${customers.blocked} = 1)`);
  }
  if (f.after) {
    const a = f.after;
    conds.push(or(lt(orders.createdAt, a.at), and(eq(orders.createdAt, a.at), lt(orders.id, a.id))) as SQL);
  }
  return conds.length > 0 ? and(...conds) : undefined;
}

/** Newest first; `id` breaks ties so the keyset cursor is total. */
export const ordersOrderBy = [desc(orders.createdAt), desc(orders.id)] as const;
