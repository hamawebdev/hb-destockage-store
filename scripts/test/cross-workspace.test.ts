import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolved } from './fixtures/cross-workspace/worker.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/cross-workspace', import.meta.url));
const bin = (name: string) => join(root, 'node_modules/.bin', name);

test('every @hb/* library resolves by name under vitest', () => {
  expect(Object.keys(resolved)).toEqual(['@hb/catalog', '@hb/db', '@hb/shared', '@hb/ui-tokens']);
  for (const [name, ns] of Object.entries(resolved)) {
    expect(typeof ns, name).toBe('object');
    expect(ns, name).not.toBeNull();
  }
});

test('every @hb/* library resolves by name under tsc', () => {
  execFileSync(bin('tsc'), ['--noEmit', '-p', fixture], { stdio: 'pipe' });
});

test('every @hb/* library resolves by name under wrangler (esbuild) bundling', () => {
  const out = mkdtempSync(join(tmpdir(), 'hb-xws-'));
  try {
    execFileSync(bin('wrangler'), ['deploy', '--dry-run', '--outdir', out], {
      cwd: fixture,
      stdio: 'pipe',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
