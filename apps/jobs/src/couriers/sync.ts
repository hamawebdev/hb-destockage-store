// SHIP-5: the per-minute courier sync (SHIP-0 contract §1 SHIP-5, rules 9 to 13e). D1-only steps run
// first and need no courier; then each usable account's courier steps run concurrently under their
// own limit, so a hanging courier can't starve the others or the D1 steps. A final apply picks up
// what the polls added.
import { createDb } from '@hb/db';
import { log } from '../log.ts';
import { loadAccounts, logStepError, SYNC_LIMITS, type SyncAccount, type SyncContext, type SyncEnv, type SyncLimits } from './context.ts';
import { applyPendingEvents } from './events.ts';
import { drainInbox, purgeInbox } from './inbox.ts';
import { pollAccount, refreshLists } from './poll.ts';
import { applyUnapplied, flagOldDrafts, parkUnverifiable, sweepStale, validateDrafts, verifyUncertain } from './sends.ts';

export interface SyncOptions {
  readonly now?: () => number;
  readonly limits?: Partial<SyncLimits>;
  readonly fetch?: typeof fetch;
}

export interface SyncReport {
  inbox: number;
  swept: number;
  unapplied: number;
  parked: number;
  events: number;
  polled: number;
  verified: number;
  validated: number;
  accountsTimedOut: string[];
  elapsedMs: number;
}

const timeout = (ms: number) => new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms));

export async function runCourierSync(env: SyncEnv & { readonly DB: D1Database }, opts: SyncOptions = {}): Promise<SyncReport> {
  const ctx: SyncContext = {
    db: createDb(env.DB),
    d1: env.DB,
    env,
    now: opts.now ?? Date.now,
    limits: { ...SYNC_LIMITS, ...opts.limits },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };
  const started = Date.now();
  const deadline = () => ctx.now() + Math.max(0, ctx.limits.BUDGET_MS - (Date.now() - started));
  const report: SyncReport = { inbox: 0, swept: 0, unapplied: 0, parked: 0, events: 0, polled: 0, verified: 0, validated: 0, accountsTimedOut: [], elapsedMs: 0 };

  const step = async (name: string, fn: () => Promise<number | void>): Promise<number> => {
    try {
      return (await fn()) ?? 0;
    } catch (err) {
      logStepError(name, err);
      return 0;
    }
  };

  let accounts: SyncAccount[] = [];
  await step('accounts', async () => void (accounts = await loadAccounts(ctx)));

  // D1 only.
  report.inbox = await step('inbox', () => drainInbox(ctx, accounts, Math.min(deadline(), ctx.now() + ctx.limits.INBOX_MS)));
  report.swept = await step('sweep', () => sweepStale(ctx));
  report.unapplied = await step('unapplied', () => applyUnapplied(ctx, deadline()));
  report.parked = await step('park', () => parkUnverifiable(ctx, accounts));
  report.events = await step('events', () => applyPendingEvents(ctx, deadline()));
  await step('drafts', () => flagOldDrafts(ctx));

  // Courier calls, one account each, concurrently.
  const usable = accounts.filter((a) => a.usable);
  const remaining = Math.max(0, ctx.limits.BUDGET_MS - (Date.now() - started));
  await Promise.all(
    usable.map(async (account) => {
      const limit = Math.min(ctx.limits.ACCOUNT_MS, remaining);
      const accountDeadline = ctx.now() + limit;
      const work = (async () => {
        report.polled += await step('poll', () => pollAccount(ctx, account));
        report.verified += await step('verify', () => verifyUncertain(ctx, account, accountDeadline));
        report.validated += await step('validate', () => validateDrafts(ctx, account, accountDeadline));
        await step('lists', () => refreshLists(ctx, account));
      })();
      if ((await Promise.race([work, timeout(limit)])) === 'timeout') report.accountsTimedOut.push(account.adapter.id);
    }),
  );

  report.events += await step('events', () => applyPendingEvents(ctx, deadline()));
  await step('purge', () => purgeInbox(ctx));
  report.elapsedMs = Date.now() - started;
  log('courier_sync.done', {
    inbox: report.inbox,
    swept: report.swept,
    unapplied: report.unapplied,
    parked: report.parked,
    events: report.events,
    polled: report.polled,
    verified: report.verified,
    validated: report.validated,
    timedOut: report.accountsTimedOut.join(','),
    ms: report.elapsedMs,
  });
  return report;
}
