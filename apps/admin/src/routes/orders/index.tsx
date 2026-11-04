// Orders section (owner: admin-orders). Mounted at /orders by admin-core (app.ts).
// Plan: artifacts/AORD-0/plan.md. Rules: see the header of src/app.ts.
//
//   GET /            list, filters, search, keyset pagination      (AORD-1)
import { rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import { createRouter } from '../../lib/router.ts';
import { fetchOrdersPage } from './list-data.ts';
import { OrdersListPage } from './list-page.tsx';
import { SEARCH_MAX_CHARS, parseOrdersFilter } from './list-query.ts';
import { m } from './messages.ts';

const r = createRouter({ roles: rolesFor('orders.view') });

r.get('/', requirePerm('orders.view'), async (c) => {
  const url = new URL(c.req.url);
  const parsed = parseOrdersFilter(url.searchParams, c.var.user.role);
  const page = await fetchOrdersPage(c.var.db, parsed.filter);
  const q = (url.searchParams.get('q') ?? '').slice(0, SEARCH_MAX_CHARS);
  return c.render(
    <OrdersListPage lang={c.var.lang} parsed={parsed} page={page} q={q} url={`${url.pathname}${url.search}`} />,
    { title: m(c.var.lang)('list.title') },
  );
});

export default r;
