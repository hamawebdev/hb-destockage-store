// Local publish pipeline (JOBS-3): queued publish_runs → snapshot export → site build → byte
// budget → recorded on the run. Never deploys: the deploy command is printed and stored in the
// log tail. Stage implementations are injected (Node ones in scripts/publish.ts) so the
// orchestration is testable without a build.
import { claimRun, clampTail, finishRun, oneLine, type FinishedRun } from './runs.ts';

export interface SnapshotResult {
  file: string;
  sha256: string;
  productCount: number;
}

export interface BudgetResult {
  ok: boolean;
  summary: string;
}

export interface PublishStages {
  /** D1 → snapshot JSON file (db's exportCatalogSnapshot + catalog's fromExport validation). */
  exportSnapshot(runId: number, log: (line: string) => void): Promise<SnapshotResult>;
  /** Snapshot → catalogue assets + static site (pagedata + astro build). */
  build(snapshot: SnapshotResult, log: (line: string) => void): Promise<Record<string, number> | void>;
  /** `npm run budget` (report kept next to the snapshot). */
  budget(snapshot: SnapshotResult, log: (line: string) => void): Promise<BudgetResult>;
}

export interface PublishOptions {
  now?: () => number;
  deployCommand: string;
  /** Mirror of every log line (the CLI prints them). */
  onLog?: (line: string) => void;
  /** Stop after this many runs (default: drain the queue). */
  maxRuns?: number;
}

export interface PublishOutcome extends FinishedRun {
  id: number;
  recorded: boolean;
}

export class StageError extends Error {
  override readonly name = 'StageError';
  readonly stage: string;
  constructor(stage: string, message: string) {
    super(message);
    this.stage = stage;
  }
}

export async function runPublishQueue(db: D1Database, stages: PublishStages, opts: PublishOptions): Promise<PublishOutcome[]> {
  const now = opts.now ?? Date.now;
  const out: PublishOutcome[] = [];
  while (out.length < (opts.maxRuns ?? Infinity)) {
    const id = await claimRun(db, now());
    if (id === null) break;
    out.push(await runOne(db, id, stages, opts, now));
  }
  return out;
}

async function runOne(db: D1Database, id: number, stages: PublishStages, opts: PublishOptions, now: () => number): Promise<PublishOutcome> {
  let tail = '';
  const log = (line: string) => {
    tail = clampTail(`${tail}${line}\n`, 16_384); // keep more than needed; clamped again on write
    opts.onLog?.(line);
  };
  const timings: Record<string, number> = {};
  const t0 = now();
  let stage = 'export';
  let snapshot: SnapshotResult | null = null;
  let budget: BudgetResult | null = null;
  let error: string | null = null;

  const timed = async <T>(name: string, key: string, f: () => Promise<T>): Promise<T> => {
    stage = name;
    log(`== ${name}`);
    const s = now();
    try {
      return await f();
    } finally {
      timings[key] = now() - s;
      log(`== ${name}: ${timings[key]} ms`);
    }
  };

  log(`publish run #${id}`);
  try {
    snapshot = await timed('export', 'exportMs', () => stages.exportSnapshot(id, log));
    log(`snapshot ${snapshot.sha256.slice(0, 12)}… (${snapshot.productCount} products)`);
    const sub = await timed('build', 'buildMs', () => stages.build(snapshot!, log));
    if (sub) Object.assign(timings, sub);
    budget = await timed('budget', 'budgetMs', () => stages.budget(snapshot!, log));
    log(`budget: ${budget.ok ? 'PASS' : 'FAIL'}: ${budget.summary}`);
    if (!budget.ok) error = 'budget';
  } catch (err) {
    error = `${stage}: ${oneLine(err instanceof Error ? err.message : String(err), 240)}`;
    log(`FAILED at ${stage}`);
  }
  const finishedAt = now();
  timings['totalMs'] = finishedAt - t0;
  if (error === null) log(`deploy (NOT run, client's step): ${opts.deployCommand}`);
  else log(`no deploy: run failed (${error})`);

  const result: FinishedRun = {
    status: error === null ? 'succeeded' : 'failed',
    finishedAt,
    snapshotSha256: snapshot?.sha256 ?? null,
    productCount: snapshot?.productCount ?? null,
    buildMs: timings['totalMs'],
    timings,
    budgetOk: budget ? budget.ok : null,
    error,
    logTail: tail,
  };
  const recorded = await finishRun(db, id, result);
  if (!recorded) opts.onLog?.(`run #${id} was abandoned in the admin meanwhile: outcome not recorded`);
  return { id, recorded, ...result, logTail: clampTail(tail) };
}
