// Local workerd bindings (D1, R2, Queues) through wrangler's getPlatformProxy. Nothing remote.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';

export interface LocalPlatform<E> {
  env: E;
  dir: string;
  dispose(): Promise<void>;
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
  const proxy = await getPlatformProxy<E>({ configPath: join(dir, 'wrangler.json'), persist: { path: join(dir, 'state') } });
  return {
    env: proxy.env,
    dir,
    async dispose() {
      await proxy.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
