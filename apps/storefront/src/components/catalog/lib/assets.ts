import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Same-origin script URLs with a content hash (`?v=`), so web can serve `/js/*` as immutable.
 * Read at build time from `apps/storefront/public/js/` (Astro runs with the storefront as cwd).
 */
const cache = new Map<string, string>();
function versioned(file: string): string {
  let url = cache.get(file);
  if (!url) {
    const body = readFileSync(join(process.cwd(), 'public', 'js', file));
    url = `/js/${file}?v=${createHash('sha256').update(body).digest('hex').slice(0, 10)}`;
    cache.set(file, url);
  }
  return url;
}

export const variantScript = (): string => versioned('variant.js');
export const searchScript = (): string => versioned('search.js');
