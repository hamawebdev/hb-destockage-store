import type { Context } from 'hono';

/**
 * Replaces the response produced downstream, discarding its headers (Hono would otherwise copy
 * e.g. `Location` or `Set-Cookie` onto the replacement).
 */
export function replaceResponse(c: Context, res: Response): void {
  c.res = undefined as unknown as Response;
  c.res = res;
}
