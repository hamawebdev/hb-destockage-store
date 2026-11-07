// Generated files must never be committed (rev-c, lead): every path the pre-build and the build write
// inside apps/storefront is gitignored. git check-ignore, no build needed.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const storefront = fileURLToPath(new URL('..', import.meta.url));
const generated = [
  'dist/index.html',
  '.astro/types.d.ts',
  '.hb/postbuild-report.json',
  '.hb/tmp/x',
  '.catalog/image-manifest.json',
  'public/img/0123abcd-360.avif',
  'public/img/0123abcd-og.jpg',
  'public/search/ar.json',
  'public/search/fr.json',
  'public/geo/communes/ar/16.json',
  'public/geo/communes/fr/69.json',
  'public/sitemap.xml',
  'public/robots.txt',
];

test.each(generated)('%s is gitignored', (rel) => {
  const out = execFileSync('git', ['check-ignore', '--no-index', '-v', rel], { cwd: storefront, encoding: 'utf8' });
  expect(out.trim()).not.toBe('');
});

test('committed sources are NOT ignored (sanity)', () => {
  for (const rel of ['public/_redirects', 'src/layouts/Base.astro', 'public/js/variant.js']) {
    expect(() => execFileSync('git', ['check-ignore', '--no-index', '-q', rel], { cwd: storefront })).toThrow();
  }
});
