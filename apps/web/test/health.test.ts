import { expect, test } from 'vitest';
import { app } from '../src/index.ts';

test('placeholder: /api/health answers', async () => {
  const res = await app.request('/api/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
