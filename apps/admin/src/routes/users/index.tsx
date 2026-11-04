// Users and roles (admin-core). CRUD lands in ADMIN-4.
import { rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import { createRouter } from '../../lib/router.ts';

const r = createRouter({ roles: rolesFor('users.manage') });

r.get('/', requirePerm('users.manage'), (c) =>
  c.render(<p>{c.var.t('common.comingSoon')}</p>, { title: c.var.t('nav.users') }),
);

export default r;
