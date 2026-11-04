import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('placeholder: index page declares lang and dir', () => {
  const src = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  expect(src).toMatch(/<html lang="ar" dir="rtl">/);
});
