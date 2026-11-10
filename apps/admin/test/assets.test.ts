// The admin serves its own copies of two brand files (Workers static assets cannot read another
// package). They must stay byte-identical to the sources.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const file = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url).href));

test.each([
  ['apps/admin/public/assets/noto-sans-arabic-400.woff2', 'packages/ui-tokens/fonts/noto-sans-arabic-400.woff2'],
  ['apps/admin/public/assets/brand/monogram.svg', 'brand/logo/monogram.svg'],
])('%s matches its source', (copy, source) => {
  expect(file(copy).equals(file(source))).toBe(true);
});
