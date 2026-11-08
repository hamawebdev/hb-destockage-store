// Security headers on every response (pages, assets, redirects, errors).
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.ts';

export const CSP_HTML = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "require-trusted-types-for 'script'",
].join('; ');

/** Non-HTML responses (CSS, JS, images, downloads) are additionally sandboxed. */
export const CSP_OTHER = `${CSP_HTML}; sandbox`;

export const STATIC_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Strict-Transport-Security': 'max-age=63072000',
  'X-Robots-Tag': 'noindex, nofollow',
};

export function applySecurityHeaders(res: Response): Response {
  // Responses from fetch() (e.g. ASSETS) have immutable headers.
  let out = res;
  try {
    out.headers.set('X-Content-Type-Options', 'nosniff');
  } catch {
    out = new Response(res.body, res);
  }
  for (const [k, v] of Object.entries(STATIC_HEADERS)) out.headers.set(k, v);
  const ct = out.headers.get('Content-Type') ?? '';
  out.headers.set('Content-Security-Policy', ct.startsWith('text/html') ? CSP_HTML : CSP_OTHER);
  out.headers.delete('ETag');
  out.headers.delete('Last-Modified');
  return out;
}

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  const out = applySecurityHeaders(c.res);
  if (out !== c.res) {
    c.res = undefined as unknown as Response;
    c.res = out;
  }
});
