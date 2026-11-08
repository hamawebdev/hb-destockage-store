// Restores a dump with the operator's real command (`wrangler d1 execute --local --file`) into a
// fresh local D1, then opens it through getPlatformProxy for verification.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';

const WRANGLER = join(dirname(fileURLToPath(import.meta.url)), '../../../../node_modules/.bin/wrangler');

export interface Restored {
  db: D1Database;
  dir: string;
  output: string;
  dispose(): Promise<void>;
}

export async function restoreWithWrangler(sql: string): Promise<Restored> {
  const dir = mkdtempSync(join(tmpdir(), 'hb-restore-'));
  const cfg = join(dir, 'wrangler.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      name: 'hb-restore',
      compatibility_date: '2026-11-01',
      d1_databases: [{ binding: 'DB', database_name: 'hb-restore', database_id: 'local-hb-restore' }],
    }),
  );
  writeFileSync(join(dir, 'dump.sql'), sql);
  const output = execFileSync(
    WRANGLER,
    ['d1', 'execute', 'hb-restore', '--local', '--file', 'dump.sql', '--config', cfg, '--persist-to', join(dir, 'state'), '--yes'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: cfg, persist: { path: join(dir, 'state', 'v3') } }); // wrangler --persist-to X keeps state in X/v3
  return {
    db: proxy.env.DB,
    dir,
    output,
    async dispose() {
      await proxy.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
