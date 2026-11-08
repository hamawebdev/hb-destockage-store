// Customers section (owner: admin-orders). Mounted at /customers by admin-core (app.ts).
// Plan: artifacts/AORD-4/plan.md (approved with: web-style name normalisation; reason required
// for block AND unblock). No export, no delete.
//
//   GET  /               list, phone/name search, risk filters (customers.sensitive), keyset
//   GET  /:id            detail: identity; sensitive roles also counts, flags, block state, notes, orders
//   POST /:id/block      customers.block (owner, confirmer), reason required
//   POST /:id/unblock    customers.unblock (owner), reason required
//   POST /:id/notes      customers.flag (owner, confirmer), optimistic on the notes as seen
//
// Writes: one batch each, the audit row right before its UPDATE under the identical condition, so
// the row exists exactly when the change happened; a lost race or a repeat answers 409.
import type { Context } from 'hono';
import * as v from 'valibot';
import { and, eq, sql } from 'drizzle-orm';
import { customers } from '@hb/db';
import { audit } from '../../audit/audit.ts';
import { can, rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv } from '../../env.ts';
import { paramId, parseForm, vOptionalText, vText } from '../../lib/forms.ts';
import { cursorPage, decodeCursor } from '../../lib/pagination.ts';
import { canSeeCustomerHistory, canSeeSensitive } from '../../lib/projection.ts';
import { createRouter } from '../../lib/router.ts';
import { withFlash } from '../../ui/flash.tsx';
import {
  CUSTOMERS_PAGE_SIZE,
  HISTORY_PAGE_SIZE,
  SEARCH_MAX_CHARS,
  customerOrdersQuery,
  customersListQuery,
  fetchCustomer,
  lastBlockChange,
  parseCustomersFilter,
} from './data.ts';
import { BLOCK_REASON_MAX, BLOCK_REASON_MIN, NOTES_MAX, cm } from './messages.ts';
import { CustomerDetailPage, CustomersListPage, type CustomerRow, type DetailExtra } from './pages.tsx';

const r = createRouter({ roles: rolesFor('customers.view') });

r.get('/', requirePerm('customers.view'), async (c) => {
  const url = new URL(c.req.url);
  const { filter, invalid } = parseCustomersFilter(url.searchParams, c.var.user.role);
  const rows = (await customersListQuery(c.var.db, c.var.user, filter)) as CustomerRow[];
  const page = cursorPage(rows, CUSTOMERS_PAGE_SIZE, (x) => ({ at: x.createdAt, id: x.id }));
  return c.render(
    <CustomersListPage
      lang={c.var.lang}
      sensitive={canSeeSensitive(c.var.user)}
      filter={filter}
      invalid={invalid}
      q={(url.searchParams.get('q') ?? '').slice(0, SEARCH_MAX_CHARS)}
      rows={page.rows}
      next={page.next}
      url={`${url.pathname}${url.search}`}
    />,
    { title: cm(c.var.lang)('list.title') },
  );
});

async function renderDetail(c: Context<AppEnv>, id: number, status: 200 | 403 | 409 | 422 = 200, extra?: DetailExtra) {
  const [row] = (await fetchCustomer(c.var.db, c.var.user, id)) as CustomerRow[];
  if (!row) return c.notFound();
  const url = new URL(c.req.url);
  const sensitive = canSeeSensitive(c.var.user);
  const historyAfter = c.req.method === 'GET' ? decodeCursor(url.searchParams.get('after') ?? undefined) : null;
  const [lastBlock, historyRows] = sensitive
    ? await Promise.all([lastBlockChange(c.var.db, id), canSeeCustomerHistory(c.var.user) ? customerOrdersQuery(c.var.db, id, historyAfter) : Promise.resolve([])])
    : [null, []];
  const history = cursorPage(historyRows, HISTORY_PAGE_SIZE, (o) => ({ at: o.createdAt, id: o.id }));
  const t = cm(c.var.lang);
  c.status(status);
  return c.render(
    <CustomerDetailPage
      lang={c.var.lang}
      sensitive={sensitive}
      canBlock={can(c.var.user, 'customers.block')}
      canUnblock={can(c.var.user, 'customers.unblock')}
      canEditNotes={can(c.var.user, 'customers.flag')}
      customer={row}
      lastBlock={lastBlock}
      history={history.rows}
      historyNext={history.next}
      historyFirst={historyAfter === null}
      url={`/customers/${id}`}
      {...(extra ? { extra } : {})}
    />,
    {
      title: t('detail.title', { name: `⁨${row.name}⁩` }),
      breadcrumbs: [{ label: t('list.title'), href: '/customers' }, { label: row.name }],
    },
  );
}

r.get('/:id', requirePerm('customers.view'), (c) => {
  const id = paramId(c);
  return id === null ? c.notFound() : renderDetail(c, id);
});

// ---------------------------------------------------------------------------------------------
// Block / unblock

const ReasonForm = v.object({ reason: vText(BLOCK_REASON_MAX) });

async function setBlocked(c: Context<AppEnv>, to: boolean) {
  const id = paramId(c);
  if (id === null) return c.notFound();
  const form = to ? 'block' : 'unblock';
  const t = cm(c.var.lang);
  const f = await parseForm(c, ReasonForm);
  const reason = f.ok ? f.data.reason : '';
  if (!f.ok || [...reason].length < BLOCK_REASON_MIN) {
    return renderDetail(c, id, 422, { form, values: f.values, errors: { reason: t('err.reasonShort', { min: BLOCK_REASON_MIN }) } });
  }
  const from = to ? 0 : 1;
  const cond = sql`exists (select 1 from customers where id = ${id} and blocked = ${from})`;
  const row = audit(
    c,
    { action: to ? 'customer.block' : 'customer.unblock', entity: 'customers', entityId: id, before: { blocked: !to }, after: { blocked: to, reason } },
    { when: cond },
  );
  const upd = c.var.db
    .update(customers)
    .set({ blocked: to, updatedAt: Date.now() })
    .where(and(eq(customers.id, id), eq(customers.blocked, !to)));
  const results = (await c.var.db.batch([row, upd])) as unknown as { meta?: { changes?: number } }[];
  if ((results[1]?.meta?.changes ?? 0) === 1) return c.redirect(withFlash(`/customers/${id}`, 'saved'), 303);
  return renderDetail(c, id, 409, { top: t(to ? 'err.alreadyBlocked' : 'err.notBlocked') });
}

r.post('/:id/block', requirePerm('customers.block'), (c) => setBlocked(c, true));
r.post('/:id/unblock', requirePerm('customers.unblock'), (c) => setBlocked(c, false));

// ---------------------------------------------------------------------------------------------
// Notes (optimistic on the text as seen: web bumps updated_at on every order, so it is no guard)

const NotesForm = v.object({ notes: vOptionalText(NOTES_MAX), seen: v.optional(v.string(), '') });

r.post('/:id/notes', requirePerm('customers.flag'), async (c) => {
  const id = paramId(c);
  if (id === null) return c.notFound();
  const t = cm(c.var.lang);
  const f = await parseForm(c, NotesForm);
  if (!f.ok) return renderDetail(c, id, 422, { form: 'notes', values: f.values, errors: f.errors });
  const next = f.data.notes;
  const seen = f.data.seen;
  if ((next ?? '') === seen) return renderDetail(c, id, 422, { form: 'notes', values: f.values, errors: { notes: t('err.notesSame') } });
  const cond = sql`exists (select 1 from customers where id = ${id} and coalesce(notes, '') = ${seen})`;
  const row = audit(c, { action: 'customer.notes', entity: 'customers', entityId: id, before: { notes: seen === '' ? null : seen }, after: { notes: next } }, { when: cond });
  const upd = c.var.db
    .update(customers)
    .set({ notes: next, updatedAt: Date.now() })
    .where(and(eq(customers.id, id), sql`coalesce(${customers.notes}, '') = ${seen}`));
  const results = (await c.var.db.batch([row, upd])) as unknown as { meta?: { changes?: number } }[];
  if ((results[1]?.meta?.changes ?? 0) === 1) return c.redirect(withFlash(`/customers/${id}`, 'saved'), 303);
  const [exists] = (await fetchCustomer(c.var.db, c.var.user, id)) as CustomerRow[];
  if (!exists) return c.notFound();
  return renderDetail(c, id, 409, { top: t('err.notesChanged') });
});

export default r;
