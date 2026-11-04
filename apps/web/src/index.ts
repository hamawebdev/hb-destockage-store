// Placeholder (TOOL-2). Owner: web. Serves storefront static assets + /api/*.
import { Hono } from 'hono';

export interface Env {
  ASSETS: Fetcher;
}

export const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ ok: true }));

export default app;
