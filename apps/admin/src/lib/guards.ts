// Request-security middleware (ADMIN-3), installed globally in app.ts after authenticate:
//   csrfGuard  — every non-GET/HEAD request: form content type (else 415), same origin
//                (Sec-Fetch-Site / Origin, else 403) and the user-bound `_csrf` token (else 403).
//   auditGuard — every POST that succeeds (status < 400) must have written an audit row
//                (audit()/withAudit()) or declared noAudit(c, reason). Otherwise: in development
//                and test the response is replaced by a 500 (so a missing audit fails the test suite);
//                in production the response stands (the change already happened) but an
//                `system.unauditedMutation` audit row and an error log are written.
import { createMiddleware } from 'hono/factory';
import { audit } from '../audit/audit.ts';
import type { AppEnv } from '../env.ts';
import { renderError } from '../ui/error-page.tsx';
import { checkCsrf } from './csrf.ts';
import { replaceResponse } from './response.ts';

export const csrfGuard = createMiddleware<AppEnv>(async (c, next) => {
  const failure = await checkCsrf(c.req, c.env.CSRF_SECRET, c.var.user.id);
  if (failure === 'content-type') return renderError(c, 415);
  if (failure !== null) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'csrf refused', reason: failure, requestId: c.var.requestId }));
    return renderError(c, 403, 'csrf');
  }
  return next();
});

export class UnauditedMutationError extends Error {
  override name = 'UnauditedMutationError';
}

export const auditGuard = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return;
  if (c.res.status >= 400 || c.var.audited === true) return;
  const path = c.req.routePath;
  if (c.env.ENV !== 'production') {
    const err = new UnauditedMutationError(`${c.req.method} ${path} succeeded without an audit row (use withAudit/audit or noAudit)`);
    console.error(JSON.stringify({ level: 'error', msg: err.message, requestId: c.var.requestId }));
    replaceResponse(c, renderError(c, 500));
    return;
  }
  console.error(JSON.stringify({ level: 'error', msg: 'unaudited mutation', method: c.req.method, path, requestId: c.var.requestId }));
  try {
    await c.var.db.batch([
      audit(c, { action: 'system.unauditedMutation', entity: 'request', entityId: `${c.req.method} ${path}`.slice(0, 200) }),
    ]);
  } catch {
    // Logging must not turn a completed change into an error response.
  }
});
