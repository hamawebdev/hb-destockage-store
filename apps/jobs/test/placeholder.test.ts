import { expect, test } from 'vitest';
import worker from '../src/index.ts';

test('placeholder: exports a scheduled handler', () => {
  expect(typeof worker.scheduled).toBe('function');
});
