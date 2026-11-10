// PLACEHOLDER router created by admin-core in ADMIN-1. Owner: admin-catalog (takes this file over).
// Mounted at /content in app.ts. Keep the default export a router built with createRouter().
import { rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import { createRouter } from '../../lib/router.ts';
import { EmptyState } from '../../ui/badge.tsx';

const r = createRouter({ roles: rolesFor('content.edit') });

r.get('/', requirePerm('content.edit'), (c) => c.render(<EmptyState icon="file">{c.var.t('common.comingSoon')}</EmptyState>, { title: c.var.t('nav.content') }));

export default r;
