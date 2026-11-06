// Audit log viewer (owner only): /audit (filters + keyset pagination) and /audit/:id (diff).
// Read-only: the table is append-only (DB triggers) and nothing here writes.
import { and, desc, eq, gte, like, lt, or, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { adminUsers, auditLog } from '@hb/db';
import { rolesFor } from '../auth/permissions.ts';
import { requirePerm } from '../auth/require-role.ts';
import type { AppEnv } from '../env.ts';
import { paramId } from '../lib/forms.ts';
import { cursorPage, decodeCursor } from '../lib/pagination.ts';
import { createRouter } from '../lib/router.ts';
import { fromAlgiersInput } from '../lib/time.ts';
import { renderError } from '../ui/error-page.tsx';
import { Form, Select, Submit, TextInput, FormActions } from '../ui/form.tsx';
import { Bdi, Code, DateTime } from '../ui/format.tsx';
import { CursorPagination } from '../ui/pagination.tsx';
import { Table, type Column } from '../ui/table.tsx';

export const AUDIT_PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const r = createRouter({ roles: rolesFor('audit.view') });

export interface AuditFilters {
  actor?: number;
  entity?: string;
  entityId?: string;
  action?: string;
  from?: number;
  /** Exclusive upper bound (start of the day after `to`). */
  toExclusive?: number;
}

/** Parses filters from the query; invalid values are ignored (never echoed into SQL). */
export function parseAuditFilters(q: (k: string) => string | undefined): { filters: AuditFilters; raw: Record<string, string> } {
  const raw: Record<string, string> = {};
  const filters: AuditFilters = {};
  const actor = q('actor');
  if (actor && /^[1-9]\d{0,9}$/.test(actor)) {
    filters.actor = Number(actor);
    raw['actor'] = actor;
  }
  const entity = q('entity');
  if (entity && /^[a-z][a-z0-9_]{0,63}$/.test(entity)) {
    filters.entity = entity;
    raw['entity'] = entity;
  }
  const entityId = q('entity_id')?.trim();
  if (entityId && entityId.length <= 200) {
    filters.entityId = entityId;
    raw['entity_id'] = entityId;
  }
  const action = q('action')?.trim();
  if (action && /^[a-zA-Z0-9.]{1,64}$/.test(action)) {
    filters.action = action;
    raw['action'] = action;
  }
  const from = q('from');
  const fromMs = from ? fromAlgiersInput(from) : null;
  if (from && fromMs !== null && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    filters.from = fromMs;
    raw['from'] = from;
  }
  const to = q('to');
  const toMs = to ? fromAlgiersInput(to) : null;
  if (to && toMs !== null && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    filters.toExclusive = toMs + DAY_MS;
    raw['to'] = to;
  }
  return { filters, raw };
}

export function auditWhere(f: AuditFilters, after: { at: number; id: number } | null): SQL | undefined {
  const conds: SQL[] = [];
  if (f.actor !== undefined) conds.push(eq(auditLog.actorUserId, f.actor));
  if (f.entity !== undefined) conds.push(eq(auditLog.entity, f.entity));
  if (f.entityId !== undefined) conds.push(eq(auditLog.entityId, f.entityId));
  if (f.action !== undefined) conds.push(like(auditLog.action, `${f.action.replace(/[%_\\]/g, '')}%`));
  if (f.from !== undefined) conds.push(gte(auditLog.at, f.from));
  if (f.toExclusive !== undefined) conds.push(lt(auditLog.at, f.toExclusive));
  if (after) conds.push(or(lt(auditLog.at, after.at), and(eq(auditLog.at, after.at), lt(auditLog.id, after.id)))!);
  return conds.length ? and(...conds) : undefined;
}

type Row = { id: number; at: number; actorEmail: string | null; actorType: string; action: string; entity: string; entityId: string | null };

function listUrl(raw: Record<string, string>): string {
  const q = new URLSearchParams(raw).toString();
  return `/audit${q ? `?${q}` : ''}`;
}

r.get('/', requirePerm('audit.view'), async (c) => {
  const t = c.var.t;
  const { filters, raw } = parseAuditFilters((k) => c.req.query(k));
  const cursorRaw = c.req.query('after');
  const after = decodeCursor(cursorRaw);
  const db = c.var.db;
  const [rows, users, entities] = await Promise.all([
    db
      .select({ id: auditLog.id, at: auditLog.at, actorEmail: auditLog.actorEmail, actorType: auditLog.actorType, action: auditLog.action, entity: auditLog.entity, entityId: auditLog.entityId })
      .from(auditLog)
      .where(auditWhere(filters, after))
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(AUDIT_PAGE_SIZE + 1)
      .all(),
    db.select({ id: adminUsers.id, email: adminUsers.email }).from(adminUsers).orderBy(adminUsers.email).all(),
    db.selectDistinct({ entity: auditLog.entity }).from(auditLog).orderBy(auditLog.entity).all(),
  ]);
  const page = cursorPage(rows, AUDIT_PAGE_SIZE, (r) => ({ at: r.at, id: r.id }));
  const columns: Column<Row>[] = [
    { key: 'at', header: t('audit.col.at'), cell: (r) => <DateTime ms={r.at} /> },
    { key: 'actor', header: t('audit.col.actor'), cell: (r) => (r.actorEmail ? <Bdi>{r.actorEmail}</Bdi> : t('audit.system')) },
    { key: 'action', header: t('audit.col.action'), cell: (r) => <Code>{r.action}</Code> },
    { key: 'entity', header: t('audit.col.entity'), cell: (r) => <Code>{r.entity}</Code> },
    { key: 'entityId', header: t('audit.col.entityId'), cell: (r) => (r.entityId === null ? t('common.none') : <Bdi>{r.entityId}</Bdi>) },
    { key: 'details', header: t('audit.col.details'), cell: (r) => <a href={`/audit/${r.id}`}>{t('audit.view')}</a> },
  ];
  return c.render(
    <>
      <Form action="/audit" method="get" class="form form--filters">
        <Select
          name="actor"
          label={t('audit.filter.actor')}
          value={raw['actor']}
          placeholder={t('audit.filter.anyActor')}
          options={users.map((u) => ({ value: String(u.id), label: u.email }))}
        />
        <Select
          name="entity"
          label={t('audit.filter.entity')}
          value={raw['entity']}
          placeholder={t('audit.filter.anyEntity')}
          options={entities.map((e) => ({ value: e.entity, label: e.entity }))}
        />
        <TextInput name="entity_id" label={t('audit.filter.entityId')} value={raw['entity_id']} dir="ltr" maxlength={200} />
        <TextInput name="action" label={t('audit.filter.action')} value={raw['action']} dir="ltr" maxlength={64} />
        <TextInput name="from" type="date" label={t('audit.filter.from')} value={raw['from']} dir="ltr" />
        <TextInput name="to" type="date" label={t('audit.filter.to')} value={raw['to']} dir="ltr" />
        <FormActions>
          <Submit>{t('common.filter')}</Submit>
          <a class="btn btn--secondary" href="/audit">{t('common.reset')}</a>
        </FormActions>
      </Form>
      <Table caption={t('audit.title')} columns={columns} rows={page.rows} rowKey={(r) => r.id} stack />
      <CursorPagination next={page.next} baseUrl={listUrl(raw)} isFirst={cursorRaw === undefined} />
    </>,
    { title: t('audit.title') },
  );
});

/** One row per field present in either snapshot. Values shown as JSON text (escaped by JSX). */
export function diffRows(before: unknown, after: unknown): { field: string; before: string | undefined; after: string | undefined; changed: boolean }[] {
  const obj = (x: unknown): Record<string, unknown> | null => (x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
  const b = obj(before);
  const a = obj(after);
  if (!b && !a) return [];
  const keys = [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])].sort();
  const show = (o: Record<string, unknown> | null, k: string) => (o && Object.hasOwn(o, k) ? JSON.stringify(o[k]) : undefined);
  return keys.map((k) => {
    const bv = show(b, k);
    const av = show(a, k);
    return { field: k, before: bv, after: av, changed: bv !== av };
  });
}

async function detail(c: Context<AppEnv>) {
  const id = paramId(c);
  if (id === null) return renderError(c, 404);
  const row = await c.var.db.select().from(auditLog).where(eq(auditLog.id, id)).get();
  if (!row) return renderError(c, 404);
  const t = c.var.t;
  const rows = diffRows(row.before, row.after);
  const truncated = [row.before, row.after].some((x) => x !== null && typeof x === 'object' && (x as Record<string, unknown>)['_truncated'] === true);
  type D = (typeof rows)[number];
  const cols: Column<D>[] = [
    { key: 'field', header: t('audit.detail.field'), cell: (d) => <Code>{d.field}</Code> },
    { key: 'before', header: t('audit.detail.before'), cell: (d) => (d.before === undefined ? t('common.none') : <code dir="ltr">{d.before}</code>) },
    { key: 'after', header: t('audit.detail.after'), cell: (d) => (d.after === undefined ? t('common.none') : <code dir="ltr">{d.after}</code>) },
    { key: 'changed', header: '', cell: (d) => (d.changed ? <span class="badge badge--warning">{t('audit.detail.changed')}</span> : null) },
  ];
  return c.render(
    <>
      <dl class="details">
        <dt>{t('audit.col.at')}</dt>
        <dd><DateTime ms={row.at} /></dd>
        <dt>{t('audit.col.actor')}</dt>
        <dd>{row.actorEmail ? <Bdi>{row.actorEmail}</Bdi> : t('audit.system')}</dd>
        <dt>{t('audit.col.action')}</dt>
        <dd><Code>{row.action}</Code></dd>
        <dt>{t('audit.col.entity')}</dt>
        <dd><Code>{row.entity}</Code> {row.entityId !== null ? <Bdi>{row.entityId}</Bdi> : null}</dd>
        <dt>{t('audit.detail.request')}</dt>
        <dd>{row.requestId ? <Bdi>{row.requestId}</Bdi> : t('common.none')}</dd>
      </dl>
      {truncated ? <p class="muted">{t('audit.detail.truncated')}</p> : null}
      <Table caption={t('audit.detail.title', { id: row.id })} columns={cols} rows={rows} rowKey={(d) => d.field} empty={t('audit.detail.noChanges')} />
    </>,
    { title: t('audit.detail.title', { id: row.id }), breadcrumbs: [{ label: t('audit.title'), href: '/audit' }, { label: `#${row.id}` }] },
  );
}

r.get('/:id', requirePerm('audit.view'), detail);

export default r;

