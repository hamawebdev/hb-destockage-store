// The publish pipeline's budget stage with the JOBS-7 mode decision. I/O is injected (Node
// implementations in scripts/publish.ts) so the policy is testable.
import { decideBudgetMode, nextLastGood, type BuildFingerprint } from './budget-mode.ts';
import type { BudgetResult } from './pipeline.ts';

export interface BudgetIo {
  /** last-good.json text, or null when absent. */
  readLastGood(): Promise<string | null>;
  writeLastGood(text: string): Promise<void>;
  fingerprint(): Promise<BuildFingerprint>;
  /** `npm run budget` (with --static-only when asked): exit code + last line of budget.txt. */
  runBudget(staticOnly: boolean): Promise<{ exitCode: number | null; verdict: string }>;
}

export class BudgetToolError extends Error {
  override readonly name = 'BudgetToolError';
}

/**
 * Decides the mode, runs the budget BLOCKING in that mode, and on a pass records this build as the
 * new last good one. measure's exit codes: 0 pass, 1 violations (the publish fails), anything else
 * a usage/internal error (the stage errors).
 */
export async function budgetWithMode(io: BudgetIo, log: (l: string) => void, runId: number, now: () => number): Promise<BudgetResult> {
  const last = await io.readLastGood().catch(() => '\u0000unreadable');
  const fp = await io.fingerprint();
  const d = decideBudgetMode(last, fp);
  log(`budget mode: ${d.mode === 'static' ? 'STATIC ONLY (runtime pass skipped)' : 'FULL (static + runtime pass)'}: ${d.reason}`);
  const r = await io.runBudget(d.mode === 'static');
  if (r.exitCode !== 0 && r.exitCode !== 1) throw new BudgetToolError(`budget exited ${r.exitCode}: ${r.verdict}`);
  const ok = r.exitCode === 0;
  if (ok && fp.dirty) {
    // Review r1: a pass on a dirty tree validated the committed files PLUS uncommitted edits;
    // recording it under the committed template hash would let a later clean build of that
    // commit skip its runtime pass. The baseline stays the last clean build, so the clean build
    // compares against it (and runs full when its template differs).
    log('last good build NOT updated: uncommitted changes in template/code paths');
  } else if (ok) {
    await io.writeLastGood(`${JSON.stringify(nextLastGood(last, fp, d.mode, runId, now()), null, 2)}\n`);
  }
  return { ok, summary: r.verdict, staticOnly: d.mode === 'static' };
}
