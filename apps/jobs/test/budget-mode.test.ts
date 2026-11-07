// JOBS-7 budget-mode policy (lead's test list) and the budget stage with injected I/O.
import { describe, expect, test, vi } from 'vitest';
import { decideBudgetMode, MAX_STATIC_STREAK, nextLastGood, readLastGood, type BuildFingerprint } from '../src/publish/budget-mode.ts';
import { budgetWithMode, BudgetToolError, type BudgetIo } from '../src/publish/budget-stage.ts';

const h = (c: string) => c.repeat(64);
const fp: BuildFingerprint = { images: h('a'), template: h('b'), dirty: false };
const good = (o: Record<string, unknown> = {}) => JSON.stringify({ schema: 1, images: h('a'), template: h('b'), staticOnlyStreak: 3, runId: 7, at: 1, ...o });

describe('decideBudgetMode', () => {
  test('text/price/stock/settings-only change (same fingerprint) → static only', () => {
    expect(decideBudgetMode(good(), fp)).toEqual({ mode: 'static', reason: 'content-only change (text, price, stock, settings)' });
  });
  test('an image digest change → full', () => {
    expect(decideBudgetMode(good(), { ...fp, images: h('c') })).toEqual({ mode: 'full', reason: 'images added or changed' });
  });
  test('a template/code/budget-config change → full', () => {
    expect(decideBudgetMode(good(), { ...fp, template: h('d') })).toEqual({ mode: 'full', reason: 'template/code/budget config changed' });
  });
  test('a dirty tree → full', () => {
    expect(decideBudgetMode(good(), { ...fp, dirty: true }).mode).toBe('full');
  });
  test.each([
    ['absent', null, 'no last good build recorded'],
    ['corrupt', '{"schema":1,', 'last-good.json unreadable'],
    ['not an object', '42', 'last-good.json malformed'],
    ['bad hash', good({ images: 'xyz' }), 'last-good.json malformed'],
    ['negative streak', good({ staticOnlyStreak: -1 }), 'last-good.json malformed'],
    ['other schema', good({ schema: 2 }), 'fingerprint schema changed (2 → 1)'],
  ])('last-good %s → full, reason logged', (_l, raw, reason) => {
    expect(decideBudgetMode(raw, fp)).toEqual({ mode: 'full', reason });
  });
  test(`a full pass forced after ${MAX_STATIC_STREAK} static-only publishes in a row`, () => {
    expect(decideBudgetMode(good({ staticOnlyStreak: MAX_STATIC_STREAK - 1 }), fp).mode).toBe('static');
    expect(decideBudgetMode(good({ staticOnlyStreak: MAX_STATIC_STREAK }), fp)).toEqual({ mode: 'full', reason: `periodic full pass after ${MAX_STATIC_STREAK} static-only publishes` });
  });
  test('nextLastGood: static increments the streak, full resets it', () => {
    expect(nextLastGood(good(), fp, 'static', 8, 2)).toEqual({ schema: 1, images: h('a'), template: h('b'), staticOnlyStreak: 4, runId: 8, at: 2 });
    expect(nextLastGood(good(), fp, 'full', 8, 2).staticOnlyStreak).toBe(0);
    expect(nextLastGood(null, fp, 'static', 8, 2).staticOnlyStreak).toBe(1);
    expect(readLastGood(JSON.stringify(nextLastGood(good(), fp, 'static', 8, 2))).ok).toBe(true);
  });
});

function io(lastGood: string | null, exitCode: number | null, verdict = 'BUDGET OK: 105 pages, 16 rules'): BudgetIo & { written: string[]; staticFlags: boolean[] } {
  const written: string[] = [];
  const staticFlags: boolean[] = [];
  return {
    written,
    staticFlags,
    readLastGood: async () => lastGood,
    writeLastGood: async (t) => void written.push(t),
    fingerprint: async () => fp,
    runBudget: async (s) => {
      staticFlags.push(s);
      return { exitCode, verdict };
    },
  };
}

describe('budgetWithMode', () => {
  test('content-only: runs --static-only, passes, records the new last good build (streak + 1)', async () => {
    const x = io(good(), 0);
    const log = vi.fn();
    const r = await budgetWithMode(x, log, 9, () => 5);
    expect(x.staticFlags).toEqual([true]);
    expect(r).toEqual({ ok: true, summary: 'BUDGET OK: 105 pages, 16 rules', staticOnly: true });
    expect(JSON.parse(x.written[0]!)).toMatchObject({ staticOnlyStreak: 4, runId: 9, at: 5 });
    expect(log.mock.calls[0]![0]).toContain('STATIC ONLY');
  });
  test('static-only still BLOCKS: an HTML or AVIF over budget (exit 1) fails the publish, last good untouched', async () => {
    const x = io(good(), 1, 'BUDGET FAILED: 1 violations (html-br: 1)');
    const r = await budgetWithMode(x, () => {}, 9, () => 5);
    expect(x.staticFlags).toEqual([true]);
    expect(r).toEqual({ ok: false, summary: 'BUDGET FAILED: 1 violations (html-br: 1)', staticOnly: true });
    expect(x.written).toEqual([]);
  });
  test('no last good → full run, streak reset on pass', async () => {
    const x = io(null, 0);
    const r = await budgetWithMode(x, () => {}, 1, () => 5);
    expect(x.staticFlags).toEqual([false]);
    expect(r.staticOnly).toBe(false);
    expect(JSON.parse(x.written[0]!).staticOnlyStreak).toBe(0);
  });
  test('unreadable last-good (read throws) → full', async () => {
    const x = io(null, 0);
    x.readLastGood = async () => {
      throw new Error('EACCES');
    };
    await budgetWithMode(x, () => {}, 1, () => 5);
    expect(x.staticFlags).toEqual([false]);
  });
  test('the budget tool itself failing (exit 2) is a stage error, not a pass', async () => {
    await expect(budgetWithMode(io(good(), 2, 'usage'), () => {}, 1, () => 5)).rejects.toBeInstanceOf(BudgetToolError);
  });
});
