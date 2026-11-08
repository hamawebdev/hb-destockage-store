// Router factory for every admin section. The router-wide roles are a floor only: every route
// must still declare `requirePerm(...)` (or `requireRole`), or roleGuard answers 500.
//
//   const r = createRouter({ roles: rolesFor('orders.view') });
//   r.get('/', requirePerm('orders.view'), (c) => c.render(<List />, { title }));
//   export default r;            // mounted in app.ts
import { Hono } from 'hono';
import { requireRoleFloor } from '../auth/require-role.ts';
import type { AppEnv, Role } from '../env.ts';

export function createRouter(opts: { roles: readonly Role[] }): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireRoleFloor(...opts.roles));
  return r;
}
