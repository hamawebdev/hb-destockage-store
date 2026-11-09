// SHEET-2 check 23b and the CPU note (artifacts/SHEET-0/contract.md §2 CPU, §4 23b): 20,000 orders
// on a local D1. The gate reads indexes only; unchanged data does no scan; a scan's rows_read and the
// row-building time for one batch are printed (`[23b]` lines) for the task's artifact.
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { BATCH_SIZE, runSheetsSync, type SheetsEnv } from '../../src/sheets/run.ts';
import { buildRow, hashRow, type OrderRowSource } from '../../src/sheets/columns.ts';
import { localPlatform, type LocalPlatform } from '../helpers/platform.ts';
import { applyMigrations, insertOrders } from '../helpers/schema.ts';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const N = 20_000;
let p: LocalPlatform<{ DB: D1Database }>;
let db: D1Database;

beforeAll(async () => {
  p = await localPlatform();
  db = p.env.DB;
  await applyMigrations(db);
  await insertOrders(db, []); // geo, customer, catalogue
  // Refs are digits only (HB-00001 …), valid Crockford base32 for the 0002 format trigger.
  await db
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO orders (id, ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, subtotal_dzd, fee_dzd, total_dzd, fee_source, created_at, updated_at)
       SELECT i, 'HB-' || printf('%05d', i), 'k' || i, 1, 'Test Client', '+213560417403', 16, 1601, 'fr', 15000, 400, 15400, 'table', 1700000000000 + i, 1700000000000 + i FROM n`,
    )
    .bind(N)
    .run();
  await db
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO order_items (id, order_id, variant_id, product_id, name_fr, name_ar, sku, unit_price_dzd, qty, line_total_dzd)
       SELECT i, i, 9001, 9001, 'Pack cuisine', 'طقم مطبخ', 'HB-PK-001', 15000, 1, 15000 FROM n`,
    )
    .bind(N)
    .run();
});
afterAll(async () => {
  await p?.dispose();
});

const plan = async (sql: string): Promise<string[]> => (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results.map((r) => r.detail);

test('23b: the gate uses indexes only, never a table scan', async () => {
  const gate = await plan('SELECT (SELECT MAX(updated_at) FROM orders) AS o, (SELECT MAX(updated_at) FROM shipments) AS s, (SELECT MAX(id) FROM orders) AS i');
  console.log('[23b] gate plan:', JSON.stringify(gate));
  expect(gate.some((d) => /^SCAN (orders|shipments)\b(?! USING)/.test(d))).toBe(false);
  expect(gate.join('\n')).toMatch(/orders_updated_at_idx/);
  expect(gate.join('\n')).toMatch(/shipments_updated_at_idx/);
  const r = await db.prepare('SELECT (SELECT MAX(updated_at) FROM orders) AS o, (SELECT MAX(updated_at) FROM shipments) AS s, (SELECT MAX(id) FROM orders) AS i').run();
  console.log('[23b] gate rows_read:', r.meta.rows_read);
  expect(r.meta.rows_read).toBeLessThan(10);
});

test('23b: unchanged data does no scan; a changed fingerprint scans once, rows recorded', async () => {
  // A connection with a stored fingerprint for the current data and a recent scan: the job must stop at
  // the gate. The stand-in URL points nowhere: any network attempt would show as a failure code.
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
  const env: SheetsEnv = { DB: db, ENV: 'test', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_STANDIN_URL: 'http://127.0.0.1:9', COURIER_KEYS_KEY: key };
  const fp = await db.prepare('SELECT (SELECT MAX(updated_at) FROM orders) AS o, (SELECT MAX(updated_at) FROM shipments) AS s, (SELECT MAX(id) FROM orders) AS i').first<{ o: number; s: number | null; i: number }>();
  const now = 1_800_000_000_000;
  await db
    .prepare(`UPDATE sheets_connection SET status='connected', google_sub='s', refresh_token_enc='x.y', create_key='k', spreadsheet_id='sheet', tab_id=0, lang='fr', generation=2, scan_fingerprint=?, last_scan_at=?, failure_count=0, next_attempt_at=NULL WHERE id=1`)
    .bind(`2|${fp!.o}|${fp!.s ?? ''}|${fp!.i}`, now - 60_000)
    .run();

  let rowsRead = 0;
  const statements: string[] = [];
  // Every statement the job runs is executed through `.all()` so its meta.rows_read can be summed.
  const counted = (sql: string, stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === 'bind') return (...args: unknown[]) => counted(sql, target.bind(...args));
        if (prop === 'first' || prop === 'all' || prop === 'run') {
          return async () => {
            statements.push(sql.trim().split('\n')[0]!.slice(0, 60));
            const res = await target.all();
            rowsRead += res.meta.rows_read ?? 0;
            return prop === 'first' ? (res.results[0] ?? null) : res;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  const counting = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => counted(sql, target.prepare(sql));
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as D1Database;

  await runSheetsSync({ ...env, DB: counting }, { now: () => now });
  console.log('[23b] unchanged data: rows_read', rowsRead, 'statements', JSON.stringify(statements));
  expect(statements.some((s) => s.includes('FROM orders o'))).toBe(false);
  expect(rowsRead).toBeLessThan(20);
  const after = await db.prepare('SELECT last_error_code, failure_count FROM sheets_connection WHERE id=1').first();
  expect(after).toEqual({ last_error_code: null, failure_count: 0 });

  // One changed order: the selection scans. Measured, not bounded: it is the cost the contract accepts.
  const selection = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders o
       LEFT JOIN sheets_rows r ON r.order_id = o.id AND r.generation = 2
       LEFT JOIN shipments s ON s.id = (SELECT MAX(x.id) FROM shipments x WHERE x.order_id = o.id)
       WHERE r.order_id IS NULL OR r.source_version <> o.version OR r.shipment_stamp IS NOT s.updated_at`,
    )
    .run();
  console.log('[23b] selection scan over', N, 'orders: rows_read', selection.meta.rows_read);
});

test('CPU: building and hashing one batch of rows', async () => {
  const source: OrderRowSource = {
    ref: 'HB-00001', name: 'Amina Benali', phone_e164: '+213560417403', wilaya_code: 16, wilaya_fr: 'Alger', wilaya_ar: 'الجزائر', commune_fr: 'Bab Ezzouar', commune_ar: 'باب الزوار',
    address: 'Cité 1200 logements, bâtiment 12', subtotal_dzd: 15000, fee_dzd: 400, total_dzd: 15400, status: 'confirmed', call_attempts: 2, courier_name: 'Yalidine', courier_tracking: 'YAL-123456',
    created_at: 1_700_000_000_000, updated_at: 1_700_000_100_000, courier_status: 'in_transit', shipment_stamp: 1_700_000_200_000,
  };
  const items = [{ name_fr: 'Pack cuisine', name_ar: 'طقم مطبخ', variant_label_fr: 'Rouge', variant_label_ar: 'أحمر', qty: 2 }];
  const t0 = performance.now();
  for (let i = 0; i < BATCH_SIZE; i++) await hashRow(buildRow({ ...source, ref: `HB-${String(i).padStart(5, '0')}` }, items, 'ar'));
  const ms = performance.now() - t0;
  console.log(`[23b] build+hash ${BATCH_SIZE} rows: ${ms.toFixed(1)} ms (Node, upper bound for workerd CPU)`);
  expect(ms).toBeLessThan(2_000);
});
