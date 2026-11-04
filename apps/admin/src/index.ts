// Placeholder (TOOL-2). Owner: admin-core. Replaced by ADMIN-1.
import { Hono } from 'hono';

export const app = new Hono();

app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});
app.get('*', (c) => c.text('Unauthorized', 401));

export default app;
