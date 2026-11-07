import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { lastSucceededRun, recordRuntimeBudget, RUNTIME_BUDGET_KEY } from '../src/publish/nightly.ts';
import { localPlatform, type LocalPlatform } from './helpers/platform.ts';
import { applyMigrations } from './helpers/schema.ts';

let p: LocalPlatform<{ DB: D1Database }>;
beforeAll(async () => {
  p = await localPlatform();
  await applyMigrations(p.env.DB);
}, 60_000);
afterAll(async () => p?.dispose());

describe('nightly runtime-budget record (ADMIN-5 tile)', { timeout: 60_000 }, () => {
  test('lastSucceededRun picks the latest succeeded run; null when none', async () => {
    expect(await lastSucceededRun(p.env.DB)).toBeNull();
    await p.env.DB.batch([
      p.env.DB.prepare(`INSERT INTO publish_runs (id, status, finished_at) VALUES (1, 'succeeded', 100)`),
      p.env.DB.prepare(`INSERT INTO publish_runs (id, status, finished_at) VALUES (2, 'failed', 200)`),
      p.env.DB.prepare(`INSERT INTO publish_runs (id, status, finished_at) VALUES (3, 'succeeded', 150)`),
    ]);
    expect(await lastSucceededRun(p.env.DB)).toBe(3);
  });
  test('writes settings[jobs.runtime_budget], replacing the previous night', async () => {
    const base = { publishRunId: 3, fingerprint: { images: 'a'.repeat(64), template: 'b'.repeat(64) } };
    await recordRuntimeBudget(p.env.DB, { at: 1000, ok: true, summary: 'BUDGET OK: 105 pages, 16 rules', ...base });
    await recordRuntimeBudget(p.env.DB, { at: 2000, ok: false, summary: 'BUDGET FAILED: 1 violations (third-party: 1)', ...base });
    const row = await p.env.DB.prepare('SELECT value, updated_at FROM settings WHERE key = ?').bind(RUNTIME_BUDGET_KEY).first<{ value: string; updated_at: number }>();
    expect(JSON.parse(row!.value)).toEqual({ at: 2000, ok: false, summary: 'BUDGET FAILED: 1 violations (third-party: 1)', ...base });
    expect(row!.updated_at).toBe(2000);
  });
});
