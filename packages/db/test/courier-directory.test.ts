// SHIP-3 (SHIP-0 contract rule 17; rev-i SHIP-1 review nit 2): cached courier lists stay within the
// backup's statement limit, counting the `'` the backup doubles.
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { DIRECTORY_MAX_PAYLOAD_BYTES, payloadBackupBytes, readDirectory, refreshDirectory } from '../src/courier-directory.ts';
import type { Db } from '../src/index.ts';
import { freshD1 } from './d1.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let db: Db;
let dispose: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ db, dispose } = await freshD1());
});
afterAll(async () => dispose?.());

test('apostrophes count twice', () => {
  expect(payloadBackupBytes(`["a'b"]`)).toBe(8);
  expect(payloadBackupBytes('["é"]')).toBe(6);
});

test('a list over the limit once quoted is not cached; one under it is', async () => {
  const quoted = ["'".repeat(41_000)]; // 41,004 bytes of JSON, 82,004 once quoted
  const plain = ['x'.repeat(79_000)];
  await refreshDirectory(
    db,
    'yalidine',
    [
      { kind: 'communes', wilayaCode: 16, fetch: async () => ({ ok: true, items: quoted }) },
      { kind: 'communes', wilayaCode: 31, fetch: async () => ({ ok: true, items: plain }) },
      { kind: 'stop_desks', wilayaCode: 16, fetch: async () => ({ ok: false }) },
    ],
    { budgetMs: 5000, perCallMs: 1000 },
  );
  const rows = await readDirectory(db, 'yalidine', [16, 31]);
  expect(rows.map((r) => `${r.kind}:${r.wilayaCode}`)).toEqual(['communes:31']);
  expect(payloadBackupBytes(JSON.stringify(rows[0]!.payload))).toBeLessThanOrEqual(DIRECTORY_MAX_PAYLOAD_BYTES);
});
