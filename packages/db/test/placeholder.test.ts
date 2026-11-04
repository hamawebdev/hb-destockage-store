import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.ts';

test('placeholder: package resolves', () => {
  expect(PACKAGE).toBe('@hb/db');
});
