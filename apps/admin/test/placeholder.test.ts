import { expect, test } from 'vitest';
import { app } from '../src/index.ts';

test('placeholder: admin refuses without auth, private no-store', async () => {
  const res = await app.request('/');
  expect(res.status).toBe(401);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
});
