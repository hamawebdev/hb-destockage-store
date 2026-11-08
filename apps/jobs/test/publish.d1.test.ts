// JOBS-3 orchestration on a real local D1 (DB-1 publish_runs, incl. its CHECKs and the
// one-active partial unique index), with injected stages.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runPublishQueue, type PublishStages } from '../src/publish/pipeline.ts';
import { claimRun, clampTail, enqueueRun, oneLine } from '../src/publish/runs.ts';
import { localPlatform, type LocalPlatform } from './helpers/platform.ts';
import { applyMigrations } from './helpers/schema.ts';

let p: LocalPlatform<{ DB: D1Database }>;
const DEPLOY = './node_modules/.bin/wrangler deploy --cwd apps/web --env=';

beforeAll(async () => {
  p = await localPlatform();
  await applyMigrations(p.env.DB);
}, 60_000);
afterAll(async () => p?.dispose());
beforeEach(async () => {
  await p.env.DB.prepare(`DELETE FROM publish_runs`).run();
});

const row = (id: number) => p.env.DB.prepare(`SELECT * FROM publish_runs WHERE id = ?`).bind(id).first<Record<string, unknown>>();

function stages(over: Partial<PublishStages> = {}): PublishStages {
  return {
    exportSnapshot: async (_id, log) => {
      log('exported');
      return { file: '/tmp/x/snapshot.json', sha256: 'ab'.repeat(32), productCount: 42 };
    },
    build: async (_s, log, timings) => {
      log('built');
      Object.assign(timings, { imagesMs: 5, astroMs: 7 });
    },
    budget: async () => ({ ok: true, summary: 'BUDGET OK: 30 pages, 12 rules' }),
    ...over,
  };
}

let clock = 1_000;
const now = () => (clock += 10);

describe('publish queue', { timeout: 30_000 }, () => {
  test('nothing queued → nothing done', async () => {
    expect(await runPublishQueue(p.env.DB, stages(), { deployCommand: DEPLOY, now })).toEqual([]);
  });

  test('one active run at a time (admin double-click)', async () => {
    expect(await enqueueRun(p.env.DB)).not.toBeNull();
    expect(await enqueueRun(p.env.DB)).toBeNull();
  });

  test('success: recorded with timings, budget_ok, snapshot and the deploy command (not run)', async () => {
    const id = (await enqueueRun(p.env.DB))!;
    const [r] = await runPublishQueue(p.env.DB, stages(), { deployCommand: DEPLOY, now });
    expect(r).toMatchObject({ id, recorded: true, status: 'succeeded', error: null, budgetOk: true, productCount: 42 });
    const db = (await row(id))!;
    expect(db).toMatchObject({ status: 'succeeded', budget_ok: 1, error: null, product_count: 42, snapshot_sha256: 'ab'.repeat(32) });
    const t = JSON.parse(String(db['timings_json']));
    expect(Object.keys(t).sort()).toEqual(['astroMs', 'budgetMs', 'buildMs', 'exportMs', 'imagesMs', 'totalMs']);
    expect(db['build_ms']).toBe(t.totalMs);
    expect(Number(db['started_at'])).toBeLessThan(Number(db['finished_at']));
    expect(String(db['log_tail'])).toContain(`deploy (NOT run, client's step): ${DEPLOY}`);
    expect(String(db['log_tail'])).toContain('BUDGET OK: 30 pages');
  });

  test('JOBS-7: the budget mode is recorded in timings_json (budgetStaticOnly 1 = static pass only)', async () => {
    const id = (await enqueueRun(p.env.DB))!;
    await runPublishQueue(p.env.DB, stages({ budget: async () => ({ ok: true, summary: 'BUDGET OK', staticOnly: true }) }), { deployCommand: DEPLOY, now });
    expect(JSON.parse(String((await row(id))!['timings_json']))).toMatchObject({ budgetStaticOnly: 1 });
  });

  test('--budget skip: the run succeeds, budget_ok stays NULL, the log says it did not run', async () => {
    const id = (await enqueueRun(p.env.DB))!;
    const [r] = await runPublishQueue(p.env.DB, stages({ budget: async () => ({ ok: true, summary: 'not run', skipped: true }) }), { deployCommand: DEPLOY, now });
    expect(r).toMatchObject({ status: 'succeeded', error: null, budgetOk: null });
    const db = (await row(id))!;
    expect(db).toMatchObject({ status: 'succeeded', budget_ok: null, error: null });
    expect(String(db['log_tail'])).toContain('budget: SKIPPED: not run');
  });

  test('--budget report: a failing budget is recorded (budget_ok 0) but the run succeeds', async () => {
    const id = (await enqueueRun(p.env.DB))!;
    const [r] = await runPublishQueue(p.env.DB, stages({ budget: async () => ({ ok: false, summary: 'BUDGET FAILED: 1 violations (html-br: 1)', staticOnly: false, reportOnly: true }) }), { deployCommand: DEPLOY, now });
    expect(r).toMatchObject({ status: 'succeeded', error: null, budgetOk: false });
    const db = (await row(id))!;
    expect(db).toMatchObject({ status: 'succeeded', budget_ok: 0, error: null });
    expect(String(db['log_tail'])).toContain('budget (report only): FAIL: BUDGET FAILED');
  });

  test('budget failure: status failed, error "budget", budget_ok 0, no deploy line', async () => {
    const id = (await enqueueRun(p.env.DB))!;
    await runPublishQueue(p.env.DB, stages({ budget: async () => ({ ok: false, summary: 'BUDGET FAILED: 2 violations (html-br: 2)' }) }), { deployCommand: DEPLOY, now });
    const db = (await row(id))!;
    expect(db).toMatchObject({ status: 'failed', error: 'budget', budget_ok: 0 });
    expect(String(db['log_tail'])).not.toContain(DEPLOY);
  });

  test('a failing stage: failed with a one-line error naming the stage; later stages skipped', async () => {
    const id = (await enqueueRun(p.env.DB))!;
    let budgetCalled = false;
    await runPublishQueue(
      p.env.DB,
      stages({
        build: async () => {
          throw new Error('npm run build -w @hb/storefront exited 1\n  at something');
        },
        budget: async () => {
          budgetCalled = true;
          return { ok: true, summary: '' };
        },
      }),
      { deployCommand: DEPLOY, now },
    );
    expect(budgetCalled).toBe(false);
    const db = (await row(id))!;
    expect(db).toMatchObject({ status: 'failed', budget_ok: null, error: 'build: npm run build -w @hb/storefront exited 1 at something' });
    expect(JSON.parse(String(db['timings_json']))).toHaveProperty('buildMs');
  });

  test('JOBS-8: sub-stage timings done before a failure are kept on the run', async () => {
    const id = (await enqueueRun(p.env.DB))!;
    await runPublishQueue(
      p.env.DB,
      stages({
        build: async (_s, _log, timings) => {
          timings['catalogMs'] = 1234;
          throw new Error('astro exited 1: catalogue pre-build failed (exit 2)');
        },
      }),
      { deployCommand: DEPLOY, now },
    );
    const db = (await row(id))!;
    expect(JSON.parse(String(db['timings_json']))).toMatchObject({ catalogMs: 1234 });
    expect(db['error']).toBe('build: astro exited 1: catalogue pre-build failed (exit 2)');
  });

  test('abandoned in the admin meanwhile: outcome not recorded, admin values kept', async () => {
    const id = (await enqueueRun(p.env.DB))!;
    const [r] = await runPublishQueue(
      p.env.DB,
      stages({
        build: async () => {
          await p.env.DB.prepare(`UPDATE publish_runs SET status = 'failed', error = 'abandoned by owner' WHERE id = ? AND status = 'running'`).bind(id).run();
        },
      }),
      { deployCommand: DEPLOY, now },
    );
    expect(r!.recorded).toBe(false);
    expect(await row(id)).toMatchObject({ status: 'failed', error: 'abandoned by owner', log_tail: null });
  });

  test('one run per claim; a request queued after a run finishes is picked up by the next pass', async () => {
    await enqueueRun(p.env.DB);
    expect(await runPublishQueue(p.env.DB, stages(), { deployCommand: DEPLOY, now })).toHaveLength(1);
    await enqueueRun(p.env.DB);
    expect(await runPublishQueue(p.env.DB, stages(), { deployCommand: DEPLOY, now })).toHaveLength(1);
    expect(await claimRun(p.env.DB, now())).toBeNull();
  });

  test('huge logs: the stored tail stays within the 4 KiB CHECK and keeps the end', async () => {
    const id = (await enqueueRun(p.env.DB))!;
    await runPublishQueue(
      p.env.DB,
      stages({
        build: async (_s, log) => {
          for (let i = 0; i < 2000; i++) log(`line ${i} ${'x'.repeat(40)}`);
        },
      }),
      { deployCommand: DEPLOY, now },
    );
    const tail = String((await row(id))!['log_tail']);
    expect(tail.length).toBeLessThanOrEqual(4096);
    expect(tail.startsWith('…')).toBe(true);
    expect(tail.trimEnd().endsWith(DEPLOY)).toBe(true);
  });
});

describe('helpers', () => {
  test('oneLine and clampTail', () => {
    expect(oneLine('a\n  b\tc')).toBe('a b c');
    expect(oneLine('x'.repeat(400)).length).toBe(300);
    expect(clampTail('abcdef', 4)).toBe('…def');
  });
});
