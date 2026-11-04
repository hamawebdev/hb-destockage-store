import { describe, expect, test } from 'vitest';
import {
  ADMIN_ROLES,
  CALL_OUTCOMES,
  ORDER_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  CALLABLE_STATUSES,
  type CallOutcome,
  type OrderStatus,
  canTransition,
  findTransition,
  nextStatuses,
  resolveCallOutcome,
} from '../src/order-state.ts';

describe('order state machine', () => {
  test('main flow from the brief is allowed', () => {
    expect(canTransition('new', 'called', 'confirmer')).toBe(true);
    expect(canTransition('called', 'confirmed', 'confirmer')).toBe(true);
    expect(canTransition('called', 'unreachable', 'confirmer')).toBe(true);
    expect(canTransition('called', 'cancelled', 'confirmer')).toBe(true);
    expect(canTransition('unreachable', 'called', 'confirmer')).toBe(true);
    expect(canTransition('confirmed', 'shipped', 'logistics')).toBe(true);
    expect(canTransition('shipped', 'delivered', 'logistics')).toBe(true);
    expect(canTransition('shipped', 'returned', 'logistics')).toBe(true);
  });

  test('terminal statuses have no outgoing transitions', () => {
    for (const s of TERMINAL_STATUSES) expect(TRANSITIONS.filter((t) => t.from === s)).toEqual([]);
  });

  test('content role never changes an order; owner can do every transition', () => {
    for (const t of TRANSITIONS) {
      expect(t.roles).not.toContain('content');
      expect(t.roles).toContain('owner');
    }
  });

  test('role separation', () => {
    expect(canTransition('confirmed', 'shipped', 'confirmer')).toBe(false);
    expect(canTransition('new', 'called', 'logistics')).toBe(false);
  });

  test('stock restored exactly on transitions into cancelled or returned', () => {
    for (const t of TRANSITIONS) {
      expect(t.stock).toBe(t.to === 'cancelled' || t.to === 'returned' ? 'restore' : 'none');
    }
  });

  test('canTransition matches the table for every (from, to, role)', () => {
    for (const from of ORDER_STATUSES)
      for (const to of ORDER_STATUSES)
        for (const role of ADMIN_ROLES)
          expect(canTransition(from, to, role)).toBe(findTransition(from, to)?.roles.includes(role) ?? false);
  });

  test('no duplicate or self transitions', () => {
    const keys = TRANSITIONS.map((t) => `${t.from}>${t.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of TRANSITIONS) expect(t.from).not.toBe(t.to);
  });

  test('nextStatuses', () => {
    expect(nextStatuses('called', 'confirmer').sort()).toEqual(['cancelled', 'confirmed', 'unreachable']);
    expect(nextStatuses('confirmed', 'logistics')).toEqual(['shipped']);
    expect(nextStatuses('delivered', 'owner')).toEqual([]);
    expect(nextStatuses('new', 'owner')).toEqual(['called']);
    expect(nextStatuses('unreachable', 'confirmer').sort()).toEqual(['called', 'cancelled']);
    expect(nextStatuses('confirmed', 'confirmer')).toEqual(['cancelled']);
    expect(nextStatuses('confirmed', 'owner').sort()).toEqual(['cancelled', 'shipped']);
  });
});

describe('resolveCallOutcome', () => {
  const r = (status: OrderStatus, outcome: CallOutcome, unansweredStreak = 0, maxUnanswered = 3) =>
    resolveCallOutcome({ status, outcome, unansweredStreak, maxUnanswered });

  test('every outcome from every status: only allowed hops for a confirmer, chained', () => {
    for (const status of ORDER_STATUSES)
      for (const outcome of CALL_OUTCOMES)
        for (const streak of [0, 1, 2, 5]) {
          const res = r(status, outcome, streak);
          if (!CALLABLE_STATUSES.includes(status)) {
            expect(res).toEqual({ error: 'not_callable' });
            continue;
          }
          if ('error' in res) throw new Error('unexpected error');
          let cur = status;
          for (const [from, to] of res.hops) {
            expect(from).toBe(cur);
            expect(canTransition(from, to, 'confirmer')).toBe(true);
            cur = to;
          }
          expect(res.status).toBe(cur);
        }
  });

  test('AORD-0 §4 table', () => {
    expect(r('new', 'no_answer')).toEqual({ hops: [['new', 'called']], nextCall: 'retry', status: 'called' });
    expect(r('called', 'busy', 1)).toEqual({ hops: [], nextCall: 'retry', status: 'called' });
    expect(r('called', 'busy', 2)).toEqual({
      hops: [['called', 'unreachable']],
      nextCall: 'unreachable_retry',
      status: 'unreachable',
    });
    expect(r('unreachable', 'no_answer', 3)).toEqual({
      hops: [
        ['unreachable', 'called'],
        ['called', 'unreachable'],
      ],
      nextCall: 'unreachable_retry',
      status: 'unreachable',
    });
    expect(r('unreachable', 'no_answer', 0)).toMatchObject({ status: 'unreachable' });
    expect(r('new', 'no_answer', 0, 1)).toMatchObject({ status: 'unreachable' });
    expect(r('new', 'callback')).toEqual({ hops: [['new', 'called']], nextCall: 'callback', status: 'called' });
    expect(r('called', 'callback')).toEqual({ hops: [], nextCall: 'callback', status: 'called' });
    expect(r('unreachable', 'callback')).toEqual({
      hops: [['unreachable', 'called']],
      nextCall: 'callback',
      status: 'called',
    });
    expect(r('new', 'confirmed')).toEqual({
      hops: [
        ['new', 'called'],
        ['called', 'confirmed'],
      ],
      nextCall: 'clear',
      status: 'confirmed',
    });
    expect(r('called', 'cancelled')).toEqual({ hops: [['called', 'cancelled']], nextCall: 'clear', status: 'cancelled' });
    expect(r('new', 'wrong_number')).toEqual({
      hops: [
        ['new', 'called'],
        ['called', 'cancelled'],
      ],
      nextCall: 'clear',
      status: 'cancelled',
      cancelReason: 'wrong_number',
    });
    expect(r('shipped', 'confirmed')).toEqual({ error: 'not_callable' });
  });
});
