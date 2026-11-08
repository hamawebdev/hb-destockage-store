// Local workerd bindings (D1, R2, Queues) through wrangler's getPlatformProxy. Nothing remote.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';

export interface LocalPlatform<E> {
  dispose(rm?: boolean): Promise<void>;
  env: E;
  dir: string;
  /** Use as `wrangler … --persist-to <persistTo>` (wrangler keeps state in <persistTo>/v3). */
  persistTo: string;
}

export async function localPlatform<E extends Record<string, unknown>>(
  config: Record<string, unknown> = {},
): Promise<LocalPlatform<E>> {
  const dir = mkdtempSync(join(tmpdir(), 'hb-jobs-test-'));
  const cfg = {
    name: 'hb-jobs-test',
    compatibility_date: '2026-11-01',
    compatibility_flags: ['nodejs_compat'],
    d1_databases: [{ binding: 'DB', database_name: 'hb-test', database_id: 'local-hb-test' }],
    ...config,
  };
  writeFileSync(join(dir, 'wrangler.json'), JSON.stringify(cfg));
  const proxy = await getPlatformProxy<E>({ configPath: join(dir, 'wrangler.json'), persist: { path: join(dir, 'state', 'v3') } });
  return {
    env: proxy.env,
    dir,
    persistTo: join(dir, 'state'),
    /** Stops workerd; keeps the files unless `rm` (another process may read them afterwards). */
    async dispose(rm = true) {
      await proxy.dispose();
      if (rm) rmSync(dir, { recursive: true, force: true });
    },
  };
}
