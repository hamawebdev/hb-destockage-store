// SHEET-3 check 8 (artifacts/SHEET-0/contract.md §4): Google down or slow never blocks or slows an
// admin action, and the row arrives later. Real stand-in, real D1, the real admin routes and job.
// The storefront's order POST half of check 8 is the recorded real run in artifacts/SHEET-3/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { HEADERS } from '../../../jobs/src/sheets/columns.ts';
import { runSheetsSync, type SheetsEnv } from '../../../jobs/src/sheets/run.ts';
import { startStandin, type Standin } from '../../../jobs/test/sheets/standin-harness.ts';
import { harness, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertOrder, postAs, refOf, seedGeoAndCatalog } from '../orders/fixtures.ts';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const REDIRECT = 'http://127.0.0.1:9/sheets/callback';
const OWNER = USERS.owner;
const REF = refOf(4242);
/** An admin request with Google slow must not wait on it; the stand-in's `slow` is far above this. */
const FAST_MS = 3_000;

let h: Harness;
let s: Standin;
let jobEnv: SheetsEnv;

beforeAll(async () => {
  h = await harness();
  s = await startStandin();
  Object.assign(h.env, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REDIRECT_URI: REDIRECT, GOOGLE_STANDIN_URL: s.url, COURIER_KEYS_KEY: KEY, ENV: 'test' });
  jobEnv = { DB: h.db, ENV: 'test', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_STANDIN_URL: s.url, COURIER_KEYS_KEY: KEY };
  const cat = await seedGeoAndCatalog(dbOf(h.db));
  await insertOrder(dbOf(h.db), cat, { ref: REF, createdAt: Date.now() - 60_000, status: 'new' });
});
afterAll(async () => {
  await s?.stop();
  await h?.close();
});

const conn = async () => (await h.db.prepare('SELECT * FROM sheets_connection WHERE id=1').first<Record<string, unknown>>())!;
const googleCalls = async () => (await s.calls()).filter((c) => !c.path.startsWith('/__control'));
const statusCell = async () => (await s.sheet()).rows.filter((r) => r[0] === REF).map((r) => r[HEADERS.fr.indexOf('Statut')]);

async function timed(run: () => Promise<Response>): Promise<{ res: Response; ms: number }> {
  const t0 = performance.now();
  const res = await run();
  await res.clone().text();
  return { res, ms: performance.now() - t0 };
}

/** The real connect flow, through the stand-in's consent page. */
async function connect(): Promise<void> {
  const start = await h.as(OWNER, '/sheets/connect');
  const auth = new URL(start.headers.get('location') ?? '');
  const cookie = `hb_sheets_oauth=${/hb_sheets_oauth=([^;]+)/.exec(start.headers.get('set-cookie') ?? '')?.[1] ?? ''}`;
  await s.post('/consent', { email: OWNER });
  const query = new URL((await fetch(auth, { redirect: 'manual' })).headers.get('location') ?? '').searchParams;
  const res = await h.as(OWNER, `/sheets/callback?${query.toString()}`, { headers: { Cookie: cookie } });
  expect(res.headers.get('location')).toBe('/sheets?r=connected');
}

describe('8: Google down or slow', () => {
  let clock = Date.now();

  test('setup: connected, sheet created, the order is one row', async () => {
    await connect();
    await runSheetsSync(jobEnv, { now: () => clock, random: () => 0 }); // creates the sheet
    clock += 60_000;
    await runSheetsSync(jobEnv, { now: () => clock, random: () => 0 }); // writes the row
    expect(await statusCell()).toEqual(['Nouvelle']);
  });

  test.each([['down'], ['slow']])('stand-in %s: admin status change, order page and /sheets succeed fast with zero Google calls', async (mode) => {
    await s.post('/mode/clear');
    await s.mode({ path: '', mode });
    await s.post('/calls/clear');
    const version = String((await h.db.prepare('SELECT version FROM orders WHERE ref = ?').bind(REF).first<{ version: number }>())!.version);
    const outcome = mode === 'down' ? 'no_answer' : 'confirmed';
    const call = await timed(() => postAs(h, OWNER, `/orders/${REF}/call`, { version, outcome }));
    expect(call.res.status).toBe(303);
    const page = await timed(() => h.as(OWNER, `/orders/${REF}`));
    expect(page.res.status).toBe(200);
    const settings = await timed(() => h.as(OWNER, '/sheets'));
    expect(settings.res.status).toBe(200);
    for (const t of [call, page, settings]) expect(t.ms).toBeLessThan(FAST_MS);
    expect(await googleCalls()).toEqual([]);
    expect((await h.db.prepare('SELECT status FROM orders WHERE ref = ?').bind(REF).first<{ status: string }>())!.status).toBe(mode === 'down' ? 'called' : 'confirmed');
  });

  test('the job meets Google down: backoff ≥ 240 s, no call before it, then the row arrives once', async () => {
    await s.post('/mode/clear');
    await s.mode({ path: '', mode: 'down' });
    clock += 60_000;
    await runSheetsSync(jobEnv, { now: () => clock, random: () => 0 });
    const after = await conn();
    expect(after['status']).toBe('connected');
    expect(after['failure_count']).toBe(1);
    expect(Number(after['next_attempt_at']) - clock).toBeGreaterThanOrEqual(240_000);
    expect(after['last_error_code']).toBe('network');

    await s.post('/mode/clear');
    await s.post('/calls/clear');
    clock += 60_000; // still inside the backoff
    await runSheetsSync(jobEnv, { now: () => clock, random: () => 0 });
    expect(await googleCalls()).toEqual([]);
    expect(await statusCell()).toEqual(['Nouvelle']);

    clock = Number(after['next_attempt_at']) + 1;
    await runSheetsSync(jobEnv, { now: () => clock, random: () => 0 });
    expect(await statusCell()).toEqual(['Confirmée']);
    const done = await conn();
    expect(done['failure_count']).toBe(0);
    expect(done['next_attempt_at']).toBeNull();
    expect(done['last_error_code']).toBeNull();
  });
});

describe('8: nothing on the order path knows about Sheets', () => {
  const ROOT = fileURLToPath(new URL('../../../../', import.meta.url).href);
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
    });

  test('apps/web imports no Sheets code and makes no Google call', () => {
    for (const file of files(join(ROOT, 'apps/web/src'))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/sheets\/|googleapis|accounts\.google/);
    }
  });

  test('no trigger on orders or order_items touches the Sheets tables', async () => {
    const triggers = await h.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('orders', 'order_items')").all<{ name: string; sql: string }>();
    for (const t of triggers.results) expect(t.sql, t.name).not.toMatch(/sheets_/i);
  });
});
