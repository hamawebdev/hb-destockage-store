import { describe, expect, test } from 'vitest';
import { containedPath } from '../scripts/lib/private-dir.ts';

describe('containedPath (JOBS-3 review nit: image keys)', () => {
  test.each([['products/a.jpg'], ['a.jpg'], ['deep/er/b c.jpg']])('keeps %s inside the base', (key) => {
    expect(containedPath('/tmp/base', key)).toBe(`/tmp/base/${key}`);
  });
  test.each([['../etc/passwd'], ['products/../../x.jpg'], ['/etc/passwd'], ['C:/x.jpg'], [''], ['a\0b.jpg'], ['..'], ['.']])('refuses %j', (key) => {
    expect(containedPath('/tmp/base', key)).toBeNull();
  });
});
