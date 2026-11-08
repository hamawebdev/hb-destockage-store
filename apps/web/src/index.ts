// Entry point of the storefront Worker (`wrangler.jsonc` → main). Owner: web.
import { app } from './app.ts';
import type { Env } from './env.ts';

export { app };
export type { Env };

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
