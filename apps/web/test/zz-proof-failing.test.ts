// Deliberately failing: proves a red check on a pull request blocks deployment. Never merged.
import { expect, test } from 'vitest';

test('deliberate failure', () => {
  expect(1).toBe(2);
});
