// Runs pagedata's catalogue pre-build (packages/catalog/src/bin/catalog.ts) at the start of
// `astro build`, before any page renders, so `npm run build -w @hb/storefront` with HB_SNAPSHOT
// (+ HB_SITE_ORIGIN outside the fixture) alone produces everything the site serves: AVIF images,
// the image manifest, search/{ar,fr}.json, geo/communes/{ar,fr}/<code>.json, sitemap.xml and
// robots.txt in apps/storefront/public (all gitignored). Lead-approved plan for SHELL-4.
// Env (forwarded, read by the CLI): HB_SNAPSHOT, HB_SITE_ORIGIN, HB_STRICT_COPY, SOURCE_DATE_EPOCH.
// Optional: HB_IMAGE_CACHE → --cache (default <repo>/node_modules/.cache, on /mnt/data for worktrees),
// HB_ORIGINALS → --originals (required by the CLI for d1 exports), HB_PREBUILD=0 skips the step
// (only when the outputs already exist, e.g. a second build of the same snapshot).
// Owner: shell.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Argument vector for the CLI. Pure, so test/prebuild.test.ts covers it.
 * @param {string} repoRoot @param {string} storefront @param {Readonly<Record<string, string | undefined>>} env
 * @returns {string[]}
 */
export function prebuildArgs(repoRoot, storefront, env) {
  const args = [
    join(repoRoot, 'packages/catalog/src/bin/catalog.ts'),
    '--repo-root',
    repoRoot,
    '--out',
    join(storefront, 'public'),
    '--manifest',
    env['HB_IMAGE_MANIFEST'] ?? join(storefront, '.catalog/image-manifest.json'),
  ];
  if (env['HB_IMAGE_CACHE']) args.push('--cache', env['HB_IMAGE_CACHE']);
  if (env['HB_ORIGINALS']) args.push('--originals', env['HB_ORIGINALS']);
  return args;
}

/** @returns {import('astro').AstroIntegration} */
export default function hbPrebuild() {
  return {
    name: 'hb-prebuild',
    hooks: {
      'astro:build:start': async ({ logger }) => {
        if (process.env['HB_PREBUILD'] === '0') {
          logger.warn('HB_PREBUILD=0: catalogue pre-build skipped (outputs in public/ and .catalog/ are reused as they are)');
          return;
        }
        const storefront = fileURLToPath(new URL('..', import.meta.url));
        const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
        const args = prebuildArgs(repoRoot, storefront, process.env);
        logger.info(`catalogue pre-build: node ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
        const t0 = performance.now();
        const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
        if (r.status !== 0) throw new Error(`catalogue pre-build failed (exit ${r.status ?? r.signal}); see its output above`);
        logger.info(`catalogue pre-build done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      },
    },
  };
}
