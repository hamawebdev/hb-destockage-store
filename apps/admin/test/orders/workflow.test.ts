// AORD-2 — workflow planning (pure). Oracles below are written by hand from the lead's decisions
// (AORD-0 plan §0, §4; ADMIN-0 §4), not derived from @hb/shared's table, so a wrong table entry fails here.
import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { ADMIN_ROLES, CALL_OUTCOMES, ORDER_STATUSES, type AdminRole, type CallOutcome, type OrderStatus } from '@hb/shared';
import { toAlgiersInput } from '../../src/lib/time.ts';
import {
  CallForm,
  DEFAULT_CALL_SETTINGS,
  MANUAL_HOPS,
  TransitionForm,
  callSettingsFrom,
  manualTargets,
  planCall,
  planTransition,
  unansweredStreak,
  type OrderState,
} from '../../src/routes/orders/workflow.ts';

const NOW = Date.UTC(2026, 10, 5, 9, 0);
const MIN = 60_000;
const S = DEFAULT_CALL_SETTINGS;

const order = (status: OrderStatus, over: Partial<OrderState> = {}): OrderState => ({
  status,
  version: 7,
  callAttempts: 1,
  nextCallAt: null,
  flags: [],
  ...over,
});

const callInput = (outcome: CallOutcome, over: Record<string, string> = {}) =>
  v.parse(CallForm, { version: '7', outcome, ...over });

const call = (status: OrderStatus, outcome: CallOutcome, role: AdminRole = 'confirmer', over: Record<string, string> = {}, streak = 0, o: Partial<OrderState> = {}) =>
  planCall(order(status, o), callInput(outcome, over), { role, now: NOW, streak, settings: S });

const VALID_EXTRA: Partial<Record<CallOutcome, Record<string, string>>> = {
  callback: { callbackAt: toAlgiersInput(NOW + 60 * MIN) },
  cancelled: { reason: 'customer_refused' },
};

// ---------------------------------------------------------------------------------------------
// Hand-written oracles

const CALLERS: readonly AdminRole[] = ['owner', 'confirmer'];
const CALLABLE: readonly OrderStatus[] = ['new', 'called', 'unreachable'];

/** Final status of one call (streak 0, max 3). */
const CALL_RESULT: Record<'new' | 'called' | 'unreachable', Record<CallOutcome, OrderStatus>> = {
  new: { no_answer: 'called', busy: 'called', callback: 'called', confirmed: 'confirmed', cancelled: 'cancelled', wrong_number: 'cancelled' },
  called: { no_answer: 'called', busy: 'called', callback: 'called', confirmed: 'confirmed', cancelled: 'cancelled', wrong_number: 'cancelled' },
  unreachable: { no_answer: 'unreachable', busy: 'unreachable', callback: 'called', confirmed: 'confirmed', cancelled: 'cancelled', wrong_number: 'cancelled' },
};

/** Manual transitions and who may make them (lead decisions §0.1, ADMIN-0 §4). */
const MANUAL: Record<string, readonly AdminRole[]> = {
  'unreachable>cancelled': ['owner', 'confirmer'],
  'confirmed>cancelled': ['owner', 'confirmer'],
  'confirmed>shipped': ['owner', 'logistics'],
  'shipped>delivered': ['owner', 'logistics'],
  'shipped>returned': ['owner', 'logistics'],
};

describe('call × status × role matrix', () => {
  for (const status of ORDER_STATUSES) {
    for (const outcome of CALL_OUTCOMES) {
      for (const role of ADMIN_ROLES) {
        test(`${status} + ${outcome} by ${role}`, () => {
          const r = call(status, outcome, role, VALID_EXTRA[outcome]);
          if (!CALLERS.includes(role)) {
            expect(r).toMatchObject({ ok: false, status: 403 });
            return;
          }
          if (!CALLABLE.includes(status)) {
            expect(r).toMatchObject({ ok: false, status: 409, errors: { _form: 'err.notCallable' } });
            return;
          }
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          const expected = CALL_RESULT[status as 'new' | 'called' | 'unreachable'][outcome];
          expect(r.plan.status).toBe(expected);
          expect(r.plan.callAttempt?.outcome).toBe(outcome);
          expect(r.plan.expectedVersion).toBe(7);
          expect(r.plan.restoresStock).toBe(expected === 'cancelled');
          // Every hop is a real edge and chains from the current status.
          let at = status;
          for (const [f, t] of r.plan.hops) {
            expect(f).toBe(at);
            at = t;
          }
          expect(at).toBe(expected);
          expect(r.plan.audit.action).toBe('order.call');
          expect(r.plan.audit.after).toMatchObject({ status: expected, callAttempts: 2, outcome });
        });
      }
    }
  }
});

describe('call outcomes in detail', () => {
  test('a call from new always passes through called', () => {
    const r = call('new', 'confirmed');
    expect(r.ok && r.plan.hops).toEqual([['new', 'called'], ['called', 'confirmed']]);
  });
  test('no answer below the limit stays called, retry after callRetryMinutes', () => {
    const r = call('called', 'no_answer', 'confirmer', {}, 1);
    expect(r.ok && r.plan.hops).toEqual([]);
    expect(r.ok && r.plan.patch.nextCallAt).toBe(NOW + 30 * MIN);
  });
  test('the third unanswered call in a row makes it unreachable, retry after 4 h', () => {
    const r = call('called', 'busy', 'confirmer', {}, 2);
    expect(r.ok && r.plan.hops).toEqual([['called', 'unreachable']]);
    expect(r.ok && r.plan.patch.nextCallAt).toBe(NOW + 240 * MIN);
  });
  test('no answer from unreachable goes back to unreachable through called', () => {
    const r = call('unreachable', 'no_answer');
    expect(r.ok && r.plan.hops).toEqual([['unreachable', 'called'], ['called', 'unreachable']]);
  });
  test('callback stores the chosen time', () => {
    const at = NOW + 26 * 60 * MIN;
    const r = call('new', 'callback', 'confirmer', { callbackAt: toAlgiersInput(at) });
    expect(r.ok && r.plan.patch.nextCallAt).toBe(Math.floor(at / MIN) * MIN);
  });
  test.each([
    ['', 'err.callbackRequired'],
    ['not-a-date', 'err.callbackRequired'],
    [toAlgiersInput(NOW - MIN), 'err.callbackPast'],
    [toAlgiersInput(NOW + 15 * 24 * 60 * MIN), 'err.callbackTooFar'],
  ])('callback %s → %s', (callbackAt, err) => {
    expect(call('called', 'callback', 'confirmer', { callbackAt })).toEqual({ ok: false, status: 422, errors: { callbackAt: err } });
  });
  test('cancel during a call needs a reason from the call list', () => {
    expect(call('called', 'cancelled')).toEqual({ ok: false, status: 422, errors: { reason: 'err.reasonRequired' } });
    expect(call('called', 'cancelled', 'confirmer', { reason: 'unreachable' })).toMatchObject({ ok: false, status: 422 });
    const r = call('called', 'cancelled', 'confirmer', { reason: 'out_of_stock' });
    expect(r.ok && r.plan.outcome).toBe('out_of_stock');
    expect(r.ok && r.plan.patch.nextCallAt).toBeNull();
  });
  test('wrong number cancels with reason wrong_number, no reason field needed', () => {
    const r = call('new', 'wrong_number');
    expect(r.ok && r.plan.outcome).toBe('wrong_number');
    expect(r.ok && r.plan.audit.after).toMatchObject({ reason: 'wrong_number' });
  });
  test('confirming a flagged order requires the "flags checked" box', () => {
    const flagged = { flags: ['fast_fill'] };
    expect(call('called', 'confirmed', 'confirmer', {}, 0, flagged)).toEqual({ ok: false, status: 422, errors: { flagsChecked: 'err.flagsUnchecked' } });
    const r = call('called', 'confirmed', 'confirmer', { flagsChecked: '1' }, 0, flagged);
    expect(r.ok && r.plan.audit.after).toMatchObject({ flagsChecked: true });
  });
  test('address is stored only on confirm', () => {
    const a = call('called', 'confirmed', 'confirmer', { address: '  12 rue Didouche  ' });
    expect(a.ok && a.plan.patch.address).toBe('12 rue Didouche');
    const b = call('called', 'no_answer', 'confirmer', { address: 'x' });
    expect(b.ok && 'address' in b.plan.patch).toBe(false);
  });
  test('note travels with the call attempt', () => {
    const r = call('called', 'no_answer', 'confirmer', { note: 'messagerie' });
    expect(r.ok && r.plan.callAttempt).toEqual({ outcome: 'no_answer', note: 'messagerie' });
  });
  test('form rejects an unknown outcome and a bad version', () => {
    expect(v.safeParse(CallForm, { version: '7', outcome: 'maybe' }).success).toBe(false);
    expect(v.safeParse(CallForm, { version: '-1', outcome: 'busy' }).success).toBe(false);
    expect(v.safeParse(CallForm, { version: '٧', outcome: 'busy' }).success).toBe(true);
  });
});

describe('manual transition × role matrix (every status pair)', () => {
  for (const from of ORDER_STATUSES) {
    for (const to of ORDER_STATUSES) {
      for (const role of ADMIN_ROLES) {
        test(`${from} → ${to} by ${role}`, () => {
          const input = v.parse(TransitionForm, {
            version: '3',
            to,
            reason: from === 'unreachable' ? 'unreachable' : 'customer_refused',
            courierName: 'Yalidine',
            courierTracking: 'YAL-123',
          });
          const r = planTransition(order(from, { version: 3 }), input, { role });
          const allowed = MANUAL[`${from}>${to}`];
          if (!allowed) {
            expect(r).toMatchObject({ ok: false, status: 409 });
            return;
          }
          if (!allowed.includes(role)) {
            expect(r).toMatchObject({ ok: false, status: 403 });
            return;
          }
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.plan.hops).toEqual([[from, to]]);
          expect(r.plan.restoresStock).toBe(to === 'cancelled' || to === 'returned');
          expect(r.plan.audit).toMatchObject({ action: 'order.transition', before: { status: from, version: 3 }, after: { status: to, version: 4 } });
        });
      }
    }
  }
  test('call-driven transitions are refused here with "use a call"', () => {
    const r = planTransition(order('called'), v.parse(TransitionForm, { version: '7', to: 'confirmed' }), { role: 'owner' });
    expect(r).toEqual({ ok: false, status: 409, errors: { to: 'err.useCall' } });
  });
  test('manualTargets matches the oracle', () => {
    for (const s of ORDER_STATUSES) {
      for (const role of ADMIN_ROLES) {
        const expected = Object.entries(MANUAL)
          .filter(([k, roles]) => k.startsWith(`${s}>`) && roles.includes(role))
          .map(([k]) => k.split('>')[1]);
        expect(manualTargets(s, role), `${s} ${role}`).toEqual(expected);
      }
    }
    expect(MANUAL_HOPS).toHaveLength(Object.keys(MANUAL).length);
  });
});

describe('manual transition details', () => {
  const t = (from: OrderStatus, data: Record<string, string>, role: AdminRole = 'owner') =>
    planTransition(order(from), v.parse(TransitionForm, { version: '7', ...data }), { role });
  test('cancel reasons depend on the source status', () => {
    expect(t('unreachable', { to: 'cancelled', reason: 'unreachable' }).ok).toBe(true);
    expect(t('confirmed', { to: 'cancelled', reason: 'unreachable' })).toMatchObject({ ok: false, status: 422 });
    expect(t('confirmed', { to: 'cancelled' })).toEqual({ ok: false, status: 422, errors: { reason: 'err.reasonRequired' } });
  });
  test('shipping needs a courier name; tracking optional', () => {
    expect(t('confirmed', { to: 'shipped' })).toEqual({ ok: false, status: 422, errors: { courierName: 'err.courierRequired' } });
    const r = t('confirmed', { to: 'shipped', courierName: ' ZR Express ' }, 'logistics');
    expect(r.ok && r.plan.patch).toEqual({ courierName: 'ZR Express', courierTracking: null });
  });
  test('a cancel clears the next call', () => {
    const r = t('unreachable', { to: 'cancelled', reason: 'unreachable' });
    expect(r.ok && r.plan.patch.nextCallAt).toBeNull();
  });
  test('unknown target → 409', () => {
    expect(t('confirmed', { to: 'teleported' })).toMatchObject({ ok: false, status: 409 });
  });
});

describe('unanswered streak and settings', () => {
  test('counts trailing no_answer/busy; notes and status changes do not break it', () => {
    const e = (type: string, outcome: string | null = null) => ({ type, outcome });
    expect(unansweredStreak([])).toBe(0);
    expect(unansweredStreak([e('call_attempt', 'busy'), e('status_change'), e('note'), e('call_attempt', 'no_answer')])).toBe(2);
    expect(unansweredStreak([e('call_attempt', 'no_answer'), e('call_attempt', 'callback'), e('call_attempt', 'busy')])).toBe(1);
  });
  test('settings fall back to defaults for missing, non-integer or out-of-range values', () => {
    expect(callSettingsFrom(new Map())).toEqual(S);
    expect(callSettingsFrom(new Map<string, unknown>([['orderMaxUnanswered', 5], ['callRetryMinutes', 0], ['unreachableRetryMinutes', '60']]))).toEqual({
      ...S,
      maxUnanswered: 5,
    });
  });
});
