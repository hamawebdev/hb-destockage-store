// Router factory for every admin section. The router-wide roles are the floor (deny by default);
// routes narrow further with `requirePerm`.
//
//   const r = createRouter({ roles: rolesFor('orders.view') });
//   r.get('/', requirePerm('orders.view'), (c) => c.render(<List />, { title }));
//   export default r;            // mounted in app.ts
import { Hono } from 'hono';
import { requireRole } from '../auth/require-role.ts';
import type { AppEnv, Role } from '../env.ts';

export function createRouter(opts: { roles: readonly Role[] }): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireRole(...opts.roles));
  return r;
}
