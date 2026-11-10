import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { versionSalt } from '../../../../integrations/cart-switch.mjs';

/**
 * Same-origin script URLs with a content hash (`?v=`), so web can serve `/js/*` as immutable.
 * Read at build time from `apps/storefront/public/js/` (Astro runs with the storefront as cwd).
 */
const cache = new Map<string, string>();
function versioned(file: string, salt?: string): string {
  const key = `${file}\0${salt ?? ''}`;
  let url = cache.get(key);
  if (!url) {
    const body = readFileSync(join(process.cwd(), 'public', 'js', file));
    const h = createHash('sha256').update(body);
    // A file whose shipped bytes depend on the cart switch gets a different URL per mode (integrations/cart-switch.mjs).
    if (salt) h.update(`\0${salt}`);
    url = `/js/${file}?v=${h.digest('hex').slice(0, 10)}`;
    cache.set(key, url);
  }
  return url;
}

export const variantScript = (): string => versioned('variant.js');
/** `cartEnabled` = `layout.cartEnabled`: search.js ships without its buy branch when the cart is on (CART-3). */
export const searchScript = (cartEnabled = true): string => versioned('search.js', versionSalt('search.js', cartEnabled));
