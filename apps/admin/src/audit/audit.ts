// Append-only audit log (ADMIN-1 contract; enforcement middleware and viewer in ADMIN-3).
//
// Every mutation writes its audit row IN THE SAME D1 BATCH (a transaction), so a change and its
// audit row exist together or not at all:
//
//   await withAudit(c, { action: 'product.update', entity: 'products', entityId: id, before, after },
//     db.update(products).set(patch).where(eq(products.id, id)));
//
// or, when you build the batch yourself (e.g. an optimistic-lock guard):
//
//   await db.batch([
//     db.insert(orderEvents).values(...),
//     audit(c, entry, { when: sql`exists (select 1 from orders where id = ${id} and version = ${v})` }),
//     db.update(orders).set({ version: v + 1 }).where(and(eq(orders.id, id), eq(orders.version, v))),
//   ]);
//
// `entityId` may be a SQL expression, e.g. the id of a row inserted earlier in the same batch:
//   entityId: sql`(select id from products where slug_fr = ${slug})`.
//
// Conventions: `action` = `<entity>.<verb>` in camelCase (`order.transition`, `user.deactivate`,
// `settings.update`); `entity` = table name; `before`/`after` = row snapshots (null on create /
// delete). Secrets are redacted; each snapshot is capped at 16 KiB.

import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { auditLog, NOW_MS, type NewAuditLogEntry } from '@hb/db';
import type { Context } from 'hono';
import type { AppEnv } from '../env.ts';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId: string | number | SQL | null;
  before?: unknown;
  after?: unknown;
}

export interface AuditOptions {
  /** Write the row only when this SQL condition holds (evaluated inside the batch). */
  when?: SQL;
}

export const AUDIT_MAX_JSON = 16 * 1024;
const ACTION_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const ENTITY_RE = /^[a-z][a-z0-9_]*$/;
const SECRET_KEY_RE = /(secret|token|password|passwd|apikey|api_key|private)/i;

/** Redacts secret-looking keys, drops functions, converts Dates; returns JSON text or null. */
export function snapshotJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const seen = new WeakSet<object>();
  const json = JSON.stringify(value, function (key, val: unknown) {
    if (key !== '' && SECRET_KEY_RE.test(key)) return '[redacted]';
    if (typeof val === 'bigint') return val.toString();
    if (typeof val === 'function' || typeof val === 'symbol') return undefined;
    if (val !== null && typeof val === 'object') {
      if (seen.has(val)) return '[circular]';
      seen.add(val);
    }
    return val;
  });
  if (json === undefined) return null;
  if (new TextEncoder().encode(json).length <= AUDIT_MAX_JSON) return json;
  return JSON.stringify({ _truncated: true, _bytes: json.length, head: json.slice(0, AUDIT_MAX_JSON - 256) });
}

function check(entry: AuditEntry): void {
  if (!ACTION_RE.test(entry.action)) throw new Error(`audit: bad action "${entry.action}"`);
  if (!ENTITY_RE.test(entry.entity)) throw new Error(`audit: bad entity "${entry.entity}"`);
}

function actor(c: Context<AppEnv>) {
  const user = c.get('user') as AppEnv['Variables']['user'] | undefined;
  if (!user) throw new Error('audit: no authenticated user');
  return user;
}

const parsed = (json: string | null): unknown => (json === null ? null : JSON.parse(json));

/** The row `audit()` would write (literal entityId only). */
export function auditValues(c: Context<AppEnv>, entry: AuditEntry): NewAuditLogEntry {
  check(entry);
  if (entry.entityId !== null && typeof entry.entityId === 'object') {
    throw new Error('auditValues: entityId is a SQL expression; use audit()');
  }
  const user = actor(c);
  return {
    actorType: 'admin',
    actorUserId: user.id,
    actorEmail: user.email,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId === null ? null : String(entry.entityId),
    before: parsed(snapshotJson(entry.before)),
    after: parsed(snapshotJson(entry.after)),
    requestId: c.get('requestId') ?? null,
  };
}

/**
 * Builds the audit insert as a batch item (`INSERT INTO audit_log SELECT … WHERE <when>`).
 * Marks the request as audited.
 *
 * Implementation note: drizzle 0.45's `db.run(sql)` cannot be used inside a D1 batch (its raw
 * query has no prepared statement), so this uses `insert().select(sql)`, which lists every
 * column of `audit_log` in schema order; the SELECT list is built from the same column list.
 */
export function audit(c: Context<AppEnv>, entry: AuditEntry, opts: AuditOptions = {}): BatchItem<'sqlite'> {
  check(entry);
  const user = actor(c);
  const id = entry.entityId;
  const values: Partial<Record<keyof typeof auditLog.$inferInsert, SQL>> = {
    actorType: sql`'admin'`,
    actorUserId: sql`${user.id}`,
    actorEmail: sql`${user.email}`,
    action: sql`${entry.action}`,
    entity: sql`${entry.entity}`,
    entityId: id === null ? sql`null` : typeof id === 'object' ? sql`cast((${id}) as text)` : sql`${String(id)}`,
    before: sql`${snapshotJson(entry.before)}`,
    after: sql`${snapshotJson(entry.after)}`,
    requestId: sql`${c.get('requestId') ?? null}`,
    at: NOW_MS,
  };
  // Same filter drizzle's buildInsertQuery applies (`shouldDisableInsert` is not in its public types).
  const cols = Object.entries(getTableColumns(auditLog)).filter(
    ([, col]) => !(col as unknown as { shouldDisableInsert(): boolean }).shouldDisableInsert(),
  );
  const list = sql.join(
    cols.map(([key]) => values[key as keyof typeof values] ?? sql`null`),
    sql`, `,
  );
  c.set('audited', true);
  return c.var.db.insert(auditLog).select(sql`select ${list} where ${opts.when ?? sql`1`}`);
}

/** Runs `statements` and the audit row in one D1 batch (transaction). Returns the batch results. */
export async function withAudit(
  c: Context<AppEnv>,
  entry: AuditEntry,
  ...statements: BatchItem<'sqlite'>[]
): Promise<unknown[]> {
  const item = audit(c, entry);
  // Audit row last: its entityId may refer to a row inserted earlier in the batch.
  const all = [...statements, item] as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]];
  return c.var.db.batch(all);
}

/**
 * Declares that this POST changes no audited state (e.g. a filter form, dev login). Grep-able;
 * reviewers check every use.
 */
export function noAudit(c: Context<AppEnv>, reason: string): void {
  if (reason.trim().length < 5) throw new Error('noAudit: give a reason');
  c.set('audited', true);
}
