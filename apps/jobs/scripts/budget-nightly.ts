// Nightly full byte-budget pass on the last good build (JOBS-7; D-003). Run on the build machine
// by its scheduler (cron / systemd timer), next to the publish script:
//   node apps/jobs/scripts/budget-nightly.ts [--persist-to <dir>]
// Runs measure's FULL budget (static + Chrome runtime pass) on apps/storefront/dist and records
// settings['jobs.runtime_budget'] = {at, ok, summary, publishRunId, fingerprint} in the local D1
// for the ADMIN-5 tile. Never deploys and never touches last-good.json.
// Exit 0 = budget passed; 1 = violations; 2 = could not run.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getPlatformProxy } from 'wrangler';
import { readLastGood } from '../src/publish/budget-mode.ts';
import { lastSucceededRun, recordRuntimeBudget } from '../src/publish/nightly.ts';
import { budgetVerdict, LAST_GOOD_FILE } from './lib/fingerprint.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { values: args } = parseArgs({ options: { 'persist-to': { type: 'string', default: join(REPO, '.wrangler/hb-local') } } });

const dist = join(REPO, 'apps/storefront/dist');
if (!existsSync(dist)) {
  console.error(`budget-nightly: no build at ${dist}`);
  process.exit(2);
}
const out = join(REPO, '.wrangler/publish/nightly', new Date().toISOString().slice(0, 10));
mkdirSync(out, { recursive: true });
const r = spawnSync('npm', ['run', 'budget', '--', '--out', out], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const verdictFile = join(out, 'budget.txt');
const verdict = existsSync(verdictFile) ? budgetVerdict(readFileSync(verdictFile, 'utf8')) : '(no budget.txt)';
if (r.status !== 0 && r.status !== 1) {
  console.error(`budget-nightly: budget could not run (exit ${r.status}): ${verdict}`);
}
const ok = r.status === 0;

const last = readLastGood(existsSync(LAST_GOOD_FILE) ? readFileSync(LAST_GOOD_FILE, 'utf8') : null);
const cfgDir = join(tmpdir(), `hb-nightly-${process.pid}`);
mkdirSync(cfgDir, { recursive: true });
const cfg = join(cfgDir, 'wrangler.json');
writeFileSync(cfg, JSON.stringify({ name: 'hb-nightly', compatibility_date: '2026-11-01', d1_databases: [{ binding: 'DB', database_name: 'hb-destockage', database_id: '00000000-0000-4000-8000-000000000d1b' }] }));
const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: cfg, persist: { path: join(resolve(args['persist-to']!), 'v3') } });
try {
  await recordRuntimeBudget(proxy.env.DB, {
    at: Date.now(),
    ok,
    summary: r.status === 0 || r.status === 1 ? verdict : `budget could not run (exit ${r.status})`,
    publishRunId: await lastSucceededRun(proxy.env.DB),
    fingerprint: last.ok ? { images: last.value.images, template: last.value.template } : null,
  });
} finally {
  await proxy.dispose();
  rmSync(cfgDir, { recursive: true, force: true });
}
console.log(`budget-nightly: ${ok ? 'PASS' : 'FAIL'}: ${verdict} (recorded in settings['jobs.runtime_budget'])`);
process.exit(ok ? 0 : r.status === 1 ? 1 : 2);
