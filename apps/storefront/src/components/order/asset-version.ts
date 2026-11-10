/**
 * Content hash for a file in `apps/storefront/public/`, used as `?v=` so `/js/*` can be served
 * `immutable` (agreed with web, WEB-0 §9.2). Build-time only (node:fs). Returns null when the file
 * does not exist yet. pages uses the same function shape for search*.js / variant.js.
 * Owner: orderform.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Astro builds and vitest run with cwd = apps/storefront (npm workspace scripts); the root is a fallback. */
const ROOTS = ['public', 'apps/storefront/public'];

/**
 * `salt` (CART-4): set for a file whose shipped bytes depend on the cart switch (integrations/cart-switch.mjs
 * versionSalt), so the cart-off and cart-on builds never share an immutable URL. Absent = today's version.
 */
export function publicFileVersion(relPath: string, cwd: string = process.cwd(), salt?: string): string | null {
  for (const root of ROOTS) {
    const file = resolve(cwd, root, relPath);
    if (existsSync(file)) {
      const h = createHash('sha256').update(readFileSync(file));
      if (salt) h.update(`\0${salt}`);
      return h.digest('base64url').slice(0, 10);
    }
  }
  return null;
}
