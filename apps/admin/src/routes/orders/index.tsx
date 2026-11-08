// PLACEHOLDER router created by admin-core in ADMIN-1. Owner: admin-orders (takes this file over).
// Mounted at /orders in app.ts. Keep the default export a router built with createRouter().
import { rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import { createRouter } from '../../lib/router.ts';

const r = createRouter({ roles: rolesFor('orders.view') });

r.get('/', requirePerm('orders.view'), (c) => c.render(<p>{c.var.t('common.comingSoon')}</p>, { title: c.var.t('nav.orders') }));

export default r;
