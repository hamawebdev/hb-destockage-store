// Dashboard (admin-core). Tiles land in ADMIN-5.
import { rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import { createRouter } from '../../lib/router.ts';

const r = createRouter({ roles: rolesFor('dashboard.view') });

r.get('/', requirePerm('dashboard.view'), (c) =>
  c.render(<p>{c.var.t('common.comingSoon')}</p>, { title: c.var.t('nav.dashboard') }),
);

export default r;
