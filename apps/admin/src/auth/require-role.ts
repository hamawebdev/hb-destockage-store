// Authorisation middleware (ADMIN-1 contract; enforcement tests in ADMIN-2).
//
//   r.get('/', requirePerm('orders.view'), handler)
//   r.post('/:id/x', requireRole('owner', 'confirmer'), handler)
//
// `owner` passes every check. A request with no authenticated user gets 401 (it cannot reach a
// router in the real app: `authenticate` runs first; this is defence in depth).

import { createMiddleware } from 'hono/factory';
import type { AppEnv, Role } from '../env.ts';
import { replaceResponse } from '../lib/response.ts';
import { renderError } from '../ui/error-page.tsx';
import { rolesFor, type Permission } from './permissions.ts';

export function requireRole(...roles: readonly Role[]) {
  if (roles.length === 0) throw new Error('requireRole() needs at least one role');
  return createMiddleware<AppEnv>(async (c, next) => {
    c.set('roleChecked', true);
    const user = c.get('user') as AppEnv['Variables']['user'] | undefined;
    if (!user) return renderError(c, 401);
    if (user.role !== 'owner' && !roles.includes(user.role)) return renderError(c, 403);
    return next();
  });
}

export function requirePerm(perm: Permission) {
  return requireRole(...rolesFor(perm));
}

/**
 * Deny by default: a handler that produced a response without passing through `requireRole` /
 * `requirePerm` is a programming error, so its response is replaced by a 500.
 */
export const roleGuard = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  if (c.get('roleChecked') !== true && c.res.status < 400) {
    console.error(JSON.stringify({ level: 'error', msg: 'route without requireRole', path: c.req.routePath, requestId: c.get('requestId') }));
    replaceResponse(c, await renderError(c, 500));
  }
});
