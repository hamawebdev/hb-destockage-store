import { expect, test } from 'vitest';
import { prebuildArgs } from '../integrations/hb-prebuild.mjs';

test('pre-build runs pagedata bin/catalog.ts into public/ with the manifest under .catalog/', () => {
  expect(prebuildArgs('/r', '/r/apps/storefront', {})).toEqual([
    '/r/packages/catalog/src/bin/catalog.ts',
    '--repo-root',
    '/r',
    '--out',
    '/r/apps/storefront/public',
    '--manifest',
    '/r/apps/storefront/.catalog/image-manifest.json',
  ]);
});

test('cache, originals and manifest come from the environment when set', () => {
  const a = prebuildArgs('/r', '/r/apps/storefront', { HB_IMAGE_CACHE: '/mnt/data/c', HB_ORIGINALS: '/mnt/data/o', HB_IMAGE_MANIFEST: '/m.json' });
  expect(a).toContain('/m.json');
  expect(a.slice(-4)).toEqual(['--cache', '/mnt/data/c', '--originals', '/mnt/data/o']);
});
