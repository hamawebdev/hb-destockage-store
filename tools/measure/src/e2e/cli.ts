#!/usr/bin/env node
/**
 * npm run e2e (MEAS-4): the end-to-end specs in tests/e2e/ (vitest + Playwright, local Wrangler
 * Workers over one seeded local D1; see tests/e2e/harness.ts).
 *
 *   node tools/measure/src/e2e/cli.ts [vitest args, e.g. a spec name filter]
 *   HB_E2E_STRICT=1 node tools/measure/src/e2e/cli.ts   # acceptance: a missing feature fails
 *
 * Runs from the checkout root with the checkout's own vitest. Results and Worker logs go to
 * <main checkout>/artifacts/e2e (HB_E2E_OUT overrides). The exit code is vitest's.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, artifactsRoot } from '../lib/paths.ts';

export const E2E_CONFIG = path.join(REPO_ROOT, 'tests/e2e/vitest.config.ts');
const VITEST = path.join(REPO_ROOT, 'node_modules/.bin/vitest');

/** The vitest command line and environment for `argv` (exported for tests). */
export function e2eCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
  const out = path.resolve(env['HB_E2E_OUT'] ?? path.join(artifactsRoot(), 'e2e'));
  return {
    bin: VITEST,
    args: ['run', '--config', E2E_CONFIG, `--outputFile.json=${path.join(out, 'e2e-results.json')}`, ...argv],
    env: { ...env, HB_E2E_OUT: out },
  };
}

export function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node tools/measure/src/e2e/cli.ts [vitest args]\n  env: HB_E2E_STRICT=1, HB_E2E_WEB_URL, HB_E2E_ADMIN_URL, HB_E2E_PERSIST, HB_E2E_OUT');
    return 0;
  }
  if (!existsSync(E2E_CONFIG)) { console.error(`e2e: ${E2E_CONFIG} not found`); return 2; }
  const { bin, args, env } = e2eCommand(argv);
  const r = spawnSync(bin, args, { cwd: REPO_ROOT, env, stdio: 'inherit' });
  if (r.error) { console.error(`e2e: ${r.error.message}`); return 2; }
  return r.status ?? 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
