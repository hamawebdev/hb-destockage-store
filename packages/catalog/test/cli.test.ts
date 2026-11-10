import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const cli = join(import.meta.dirname, '../src/bin/catalog.ts');
const run = (env: Record<string, string>, args: string[] = []) => {
  const { HB_SITE_ORIGIN: _drop, ...base } = process.env;
  void _drop;
  return spawnSync(process.execPath, [cli, '--out', '/nonexistent-out', '--manifest', '/nonexistent/m.json', ...args], {
    env: { ...base, HB_SNAPSHOT: 'fixture', ...env },
    encoding: 'utf8',
  });
};

test('catalog CLI: the origin is required and single-sourced (CAT-6 r1)', () => {
  const missing = run({ HB_SNAPSHOT: 'seed' });
  expect(missing.status).toBe(2);
  expect(missing.stderr).toMatch(/HB_SITE_ORIGIN is not set/);
  // The fixture may use its default origin (it then fails later, on the missing output dirs/data, not on the origin).
  expect(run({}).stderr).not.toMatch(/HB_SITE_ORIGIN/);
  const mismatch = run({ HB_SITE_ORIGIN: 'https://comptoirdeluxe.com' }, ['--site-url', 'https://comptoirdeluxe.example']);
  expect(mismatch.status).toBe(2);
  expect(mismatch.stderr).toMatch(/disagrees with HB_SITE_ORIGIN/);
}, 120_000); // three node processes that load sharp: slow on the shared machine
