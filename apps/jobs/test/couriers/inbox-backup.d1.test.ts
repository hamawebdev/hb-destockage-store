// The daily backup must survive the largest webhook row the inbox allows (rev-i, SHIP-1 review): a
// BLOB is written as hex inside a statement limited to 90,000 bytes. Through the real runBackup.
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { runBackup } from '../../src/backup/export.ts';
import { localPlatform, type LocalPlatform } from '../helpers/platform.ts';
import { seedBackupFixtures } from '../helpers/fixtures.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

type E = { DB: D1Database; BACKUPS: R2Bucket };
let p: LocalPlatform<E>;

beforeAll(async () => {
  p = await localPlatform<E>({ r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'hb-backups-inbox-test' }] });
  await seedBackupFixtures(p.env.DB);
  await p.env.DB.prepare(`insert into courier_accounts (id, courier) values (1, 'yalidine')`).run();
});
afterAll(async () => p?.dispose());

test.each(['atomic', 'paginated'] as const)('a maximum-size inbox row and directory row back up in %s mode', async (mode) => {
  const body = new Uint8Array(32_768).fill(0xab);
  const headers = JSON.stringify({ 'x-signature': 'h'.repeat(8_150) });
  await p.env.DB.prepare(`delete from courier_webhook_inbox`).run();
  await p.env.DB.prepare(`delete from courier_directory`).run();
  await p.env.DB.batch([
    p.env.DB.prepare(`insert into courier_webhook_inbox (account_id, courier, body, headers) values (1, 'yalidine', ?, ?)`).bind(body, headers),
    p.env.DB.prepare(`insert into courier_directory (courier, kind, wilaya_code, payload, fetched_at) values ('yalidine', 'communes', 16, ?, 1)`).bind(JSON.stringify(['x'.repeat(79_900)])),
  ]);
  const manifest = await runBackup(p.env, { startedAt: Date.UTC(2026, 10, 9, mode === 'atomic' ? 2 : 3), mode });
  const table = (name: string) => manifest.tables.find((t) => t.name === name);
  expect(manifest.object.key).toBeTruthy();
  expect(table('courier_webhook_inbox')).toMatchObject({ rows: 1 });
  expect(table('courier_directory')).toMatchObject({ rows: 1 });
});
