/**
 * SHARED-4 — exhaustive state-machine tests against hand-written oracles (not derived from
 * TRANSITIONS). Source of truth: BRIEF §2, ADMIN-0 §4 roles, AORD-0 §0/§4 (lead-approved:
 * unreachable→cancelled and confirmed→cancelled for owner+confirmer; no new→cancelled).
 */
import { describe, expect, test } from 'vitest';
import {
  ADMIN_ROLES,
  CALL_OUTCOMES,
  ORDER_STATUSES,
  TERMINAL_STATUSES,
  canTransition,
  findTransition,
  isTerminalStatus,
  nextStatuses,
  resolveCallOutcome,
  type AdminRole,
  type CallOutcome,
  type OrderStatus,
} from '../src/order-state.ts';

const ALLOWED: Record<AdminRole, readonly string[]> = {
  owner: [
    'new>called',
    'called>confirmed',
    'called>unreachable',
    'called>cancelled',
    'unreachable>called',
    'unreachable>cancelled',
    'confirmed>cancelled',
    'confirmed>shipped',
    'shipped>delivered',
    'shipped>returned',
  ],
  confirmer: [
    'new>called',
    'called>confirmed',
    'called>unreachable',
    'called>cancelled',
    'unreachable>called',
    'unreachable>cancelled',
    'confirmed>cancelled',
  ],
  logistics: ['confirmed>shipped', 'shipped>delivered', 'shipped>returned'],
  content: [],
};

const RESTORES = new Set(['called>cancelled', 'unreachable>cancelled', 'confirmed>cancelled', 'shipped>returned']);

describe('every (from, to, role): 8 × 8 × 4 = 256 cases', () => {
  const cases = ORDER_STATUSES.flatMap((from) =>
    ORDER_STATUSES.flatMap((to) => ADMIN_ROLES.map((role) => [from, to, role] as const)),
  );
  test('count', () => expect(cases).toHaveLength(256));
  test.each(cases)('%s → %s as %s', (from, to, role) => {
    expect(canTransition(from, to, role)).toBe(ALLOWED[role].includes(`${from}>${to}`));
  });
});

describe('stock effect of every transition', () => {
  test.each(ALLOWED.owner.map((k) => k.split('>') as [OrderStatus, OrderStatus]))('%s → %s', (from, to) => {
    expect(findTransition(from, to)?.stock).toBe(RESTORES.has(`${from}>${to}`) ? 'restore' : 'none');
  });
  test('no transition outside the table exists', () => {
    for (const from of ORDER_STATUSES)
      for (const to of ORDER_STATUSES)
        if (!ALLOWED.owner.includes(`${from}>${to}`)) expect(findTransition(from, to)).toBeUndefined();
  });
});

test('terminal statuses', () => {
  expect([...TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'delivered', 'returned']);
  for (const s of ORDER_STATUSES) {
    expect(isTerminalStatus(s)).toBe(TERMINAL_STATUSES.includes(s));
    if (isTerminalStatus(s)) for (const role of ADMIN_ROLES) expect(nextStatuses(s, role)).toEqual([]);
  }
});

describe('resolveCallOutcome: every status × outcome × streak position', () => {
  type Expected = { hops: string[]; nextCall: string; status: OrderStatus } | 'not_callable';
  // Oracle from AORD-0 §4. "below" = streak after this call < max; "at" = reaches max.
  function oracle(status: OrderStatus, outcome: CallOutcome, reachesMax: boolean): Expected {
    if (!['new', 'called', 'unreachable'].includes(status)) return 'not_callable';
    const toCalled = status === 'called' ? [] : [`${status}>called`];
    switch (outcome) {
      case 'no_answer':
      case 'busy':
        if (status === 'unreachable' || reachesMax)
          return { hops: [...toCalled, 'called>unreachable'], nextCall: 'unreachable_retry', status: 'unreachable' };
        return { hops: toCalled, nextCall: 'retry', status: 'called' };
      case 'callback':
        return { hops: toCalled, nextCall: 'callback', status: 'called' };
      case 'confirmed':
        return { hops: [...toCalled, 'called>confirmed'], nextCall: 'clear', status: 'confirmed' };
      case 'cancelled':
      case 'wrong_number':
        return { hops: [...toCalled, 'called>cancelled'], nextCall: 'clear', status: 'cancelled' };
    }
  }
  const cases = ORDER_STATUSES.flatMap((s) =>
    CALL_OUTCOMES.flatMap((o) => [false, true].map((atMax) => [s, o, atMax] as const)),
  );
  test.each(cases)('%s + %s (reaches max: %s)', (status, outcome, atMax) => {
    const max = 3;
    const res = resolveCallOutcome({ status, outcome, unansweredStreak: atMax ? max - 1 : 0, maxUnanswered: max });
    const want = oracle(status, outcome, atMax);
    if (want === 'not_callable') {
      expect(res).toEqual({ error: 'not_callable' });
      return;
    }
    if ('error' in res) throw new Error('unexpected not_callable');
    expect(res.hops.map(([f, t]) => `${f}>${t}`)).toEqual(want.hops);
    expect(res.nextCall).toBe(want.nextCall);
    expect(res.status).toBe(want.status);
    expect(res.cancelReason).toBe(outcome === 'wrong_number' ? 'wrong_number' : undefined);
    // Every hop is one the confirmer (who logs calls) is allowed to make.
    for (const [f, t] of res.hops) expect(canTransition(f, t, 'confirmer')).toBe(true);
  });

  test('maxUnanswered and streak are sanitised', () => {
    const r = (unansweredStreak: number, maxUnanswered: number) =>
      resolveCallOutcome({ status: 'called', outcome: 'no_answer', unansweredStreak, maxUnanswered });
    expect(r(0, 0)).toMatchObject({ status: 'unreachable' }); // max < 1 treated as 1
    expect(r(-5, 3)).toMatchObject({ status: 'called' }); // negative streak treated as 0
    expect(r(1.9, 3)).toMatchObject({ status: 'called' }); // truncated
    expect(r(Number.NaN, 3)).toMatchObject({ status: 'called' });
    expect(r(0, Number.NaN)).toMatchObject({ status: 'called' }); // non-finite max ⇒ DEFAULT_MAX_UNANSWERED (3)
    expect(r(2, Number.POSITIVE_INFINITY)).toMatchObject({ status: 'unreachable' });
  });
});
