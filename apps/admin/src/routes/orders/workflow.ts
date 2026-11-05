// AORD-2 — confirmation workflow, pure part: form schemas and the planning of each order change.
// No I/O. A plan is the DB-4 `OrderChange` (packages/db, plan artifacts/DB-4/plan.md §4) minus the
// ids the handler adds, plus the audit before/after. Rules: artifacts/AORD-0/plan.md §0, §3, §4.
//
// Every status hop is checked here with @hb/shared `canTransition(from, to, role)`; DB-4 checks it
// again when it builds the batch.

import * as v from 'valibot';
import {
  CALL_OUTCOMES,
  CALLABLE_STATUSES,
  CANCEL_REASONS,
  DEFAULT_MAX_UNANSWERED,
  canTransition,
  findTransition,
  resolveCallOutcome,
  type AdminRole,
  type CallOutcome,
  type CancelReason,
  type NextCall,
  type OrderStatus,
  type StatusHop,
} from '@hb/shared';
import { roleCan } from '../../auth/permissions.ts';
import { vCheckbox, vInt, vOptionalText, vPicklist, vText } from '../../lib/forms.ts';
import { fromAlgiersInput } from '../../lib/time.ts';

// ---------------------------------------------------------------------------------------------
// Settings (admin-core's /settings will edit them; defaults until then — AORD-0 §4)

export interface CallSettings {
  /** `orderMaxUnanswered`: unanswered calls in a row before `unreachable`. */
  maxUnanswered: number;
  /** `callRetryMinutes`: gap before re-calling a `called` order after no answer / busy. */
  callRetryMinutes: number;
  /** `unreachableRetryMinutes`: gap before re-calling an `unreachable` order. */
  unreachableRetryMinutes: number;
}

export const DEFAULT_CALL_SETTINGS: CallSettings = {
  maxUnanswered: DEFAULT_MAX_UNANSWERED,
  callRetryMinutes: 30,
  unreachableRetryMinutes: 240,
};

export const SETTING_KEYS = {
  maxUnanswered: 'orderMaxUnanswered',
  callRetryMinutes: 'callRetryMinutes',
  unreachableRetryMinutes: 'unreachableRetryMinutes',
} as const satisfies Record<keyof CallSettings, string>;

const LIMITS: Record<keyof CallSettings, [min: number, max: number]> = {
  maxUnanswered: [1, 20],
  callRetryMinutes: [1, 24 * 60],
  unreachableRetryMinutes: [5, 7 * 24 * 60],
};

/** Settings rows (`key → parsed JSON value`) → sanitised settings; anything odd falls back to the default. */
export function callSettingsFrom(rows: ReadonlyMap<string, unknown>): CallSettings {
  const out = { ...DEFAULT_CALL_SETTINGS };
  for (const k of Object.keys(SETTING_KEYS) as (keyof CallSettings)[]) {
    const raw = rows.get(SETTING_KEYS[k]);
    const [min, max] = LIMITS[k];
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max) out[k] = raw;
  }
  return out;
}

export const CALLBACK_MAX_DAYS = 14;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// ---------------------------------------------------------------------------------------------
// Unanswered streak

export interface EventLite {
  type: string;
  outcome: string | null;
}

/** Consecutive `no_answer`/`busy` call attempts at the end of the timeline (oldest → newest). Notes
 * and status changes do not break the streak; any other call outcome does. */
export function unansweredStreak(events: readonly EventLite[]): number {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'call_attempt') continue;
    if (e.outcome === 'no_answer' || e.outcome === 'busy') n++;
    else break;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// The change a handler hands to DB-4 (`applyOrderChange`).

export interface OrderChangePlan {
  expectedVersion: number;
  hops: readonly StatusHop[];
  callAttempt?: { outcome: CallOutcome; note?: string };
  /** Reason stored on the status_change event(s), e.g. a CancelReason. */
  outcome?: string;
  note?: string;
  /** Key present with `null` = clear the column. */
  patch: {
    nextCallAt?: number | null;
    address?: string;
    courierName?: string;
    courierTracking?: string | null;
  };
  /** Final status after the hops. */
  status: OrderStatus;
  /** True when a hop restores stock (into `cancelled` / `returned`). */
  restoresStock: boolean;
  audit: { action: 'order.call' | 'order.transition' | 'order.note'; before: Record<string, unknown> | null; after: Record<string, unknown> };
}

export interface OrderState {
  status: OrderStatus;
  version: number;
  callAttempts: number;
  nextCallAt: number | null;
  flags: readonly string[];
}

/** Errors are orders `messages.ts` keys (`err.*`), keyed by form field (`_form` = whole form). */
export type PlanErrors = Partial<Record<'outcome' | 'callbackAt' | 'reason' | 'flagsChecked' | 'to' | 'courierName' | '_form', ErrKey>>;
export type ErrKey =
  | 'err.callbackRequired'
  | 'err.callbackPast'
  | 'err.callbackTooFar'
  | 'err.reasonRequired'
  | 'err.flagsUnchecked'
  | 'err.notCallable'
  | 'err.forbidden'
  | 'err.useCall'
  | 'err.courierRequired'
  | 'err.claimTaken'
  | 'err.nothingToRelease';

export type PlanResult =
  | { ok: true; plan: OrderChangePlan }
  | { ok: false; status: 403 | 409 | 422; errors: PlanErrors };

const hopsAllowed = (hops: readonly StatusHop[], role: AdminRole) => hops.every(([f, t]) => canTransition(f, t, role));
const restores = (hops: readonly StatusHop[]) => hops.some(([f, t]) => findTransition(f, t)?.stock === 'restore');

// ---------------------------------------------------------------------------------------------
// Log a call (POST /orders/:ref/call)

/** Reasons a confirmer picks for a cancel during a call (`wrong_number` is its own outcome;
 * `unreachable` is the manual cancel of an unreachable order). */
export const CALL_CANCEL_REASONS = ['customer_refused', 'duplicate', 'out_of_stock', 'other'] as const satisfies readonly CancelReason[];

export const CallForm = v.object({
  version: vInt(0, Number.MAX_SAFE_INTEGER),
  outcome: vPicklist(CALL_OUTCOMES),
  callbackAt: v.optional(v.string(), ''),
  reason: v.optional(v.string(), ''),
  address: vOptionalText(300),
  flagsChecked: vCheckbox(),
  note: vOptionalText(1000),
});
export type CallInput = v.InferOutput<typeof CallForm>;

function nextCallAt(kind: NextCall, now: number, s: CallSettings, callbackAt: number | null): number | null {
  switch (kind) {
    case 'retry':
      return now + s.callRetryMinutes * MINUTE;
    case 'unreachable_retry':
      return now + s.unreachableRetryMinutes * MINUTE;
    case 'callback':
      return callbackAt;
    case 'clear':
      return null;
  }
}

export function planCall(
  order: OrderState,
  input: CallInput,
  ctx: { role: AdminRole; now: number; streak: number; settings: CallSettings },
): PlanResult {
  // A call that changes no status (e.g. no answer below the limit) has no hop to check, so the
  // permission is checked here too, not only on the route.
  if (!roleCan(ctx.role, 'orders.call')) return { ok: false, status: 403, errors: { _form: 'err.forbidden' } };
  if (!CALLABLE_STATUSES.includes(order.status)) return { ok: false, status: 409, errors: { _form: 'err.notCallable' } };

  const errors: PlanErrors = {};
  let callbackAt: number | null = null;
  if (input.outcome === 'callback') {
    const ms = input.callbackAt.trim() === '' ? null : fromAlgiersInput(input.callbackAt);
    if (ms === null) errors.callbackAt = 'err.callbackRequired';
    else if (ms <= ctx.now) errors.callbackAt = 'err.callbackPast';
    else if (ms > ctx.now + CALLBACK_MAX_DAYS * DAY) errors.callbackAt = 'err.callbackTooFar';
    else callbackAt = ms;
  }
  let reason: CancelReason | undefined;
  if (input.outcome === 'cancelled') {
    if ((CALL_CANCEL_REASONS as readonly string[]).includes(input.reason)) reason = input.reason as CancelReason;
    else errors.reason = 'err.reasonRequired';
  }
  if (input.outcome === 'confirmed' && order.flags.length > 0 && !input.flagsChecked) {
    errors.flagsChecked = 'err.flagsUnchecked';
  }
  if (Object.keys(errors).length > 0) return { ok: false, status: 422, errors };

  const r = resolveCallOutcome({
    status: order.status,
    outcome: input.outcome,
    unansweredStreak: ctx.streak,
    maxUnanswered: ctx.settings.maxUnanswered,
  });
  if ('error' in r) return { ok: false, status: 409, errors: { _form: 'err.notCallable' } };
  if (!hopsAllowed(r.hops, ctx.role)) return { ok: false, status: 403, errors: { _form: 'err.forbidden' } };

  const cancelReason = r.cancelReason ?? reason;
  const next = nextCallAt(r.nextCall, ctx.now, ctx.settings, callbackAt);
  const patch: OrderChangePlan['patch'] = { nextCallAt: next };
  if (input.outcome === 'confirmed' && input.address !== null) patch.address = input.address;

  const plan: OrderChangePlan = {
    expectedVersion: input.version,
    hops: r.hops,
    callAttempt: input.note === null ? { outcome: input.outcome } : { outcome: input.outcome, note: input.note },
    patch,
    status: r.status,
    restoresStock: restores(r.hops),
    audit: {
      action: 'order.call',
      before: { status: order.status, version: order.version, callAttempts: order.callAttempts, nextCallAt: order.nextCallAt },
      after: {
        status: r.status,
        version: input.version + 1,
        callAttempts: order.callAttempts + 1,
        nextCallAt: next,
        outcome: input.outcome,
        ...(cancelReason ? { reason: cancelReason } : {}),
        ...(input.outcome === 'confirmed' && order.flags.length > 0 ? { flagsChecked: true } : {}),
        ...(patch.address !== undefined ? { address: patch.address } : {}),
      },
    },
  };
  if (cancelReason) plan.outcome = cancelReason;
  return { ok: true, plan };
}

// ---------------------------------------------------------------------------------------------
// Transitions that are not the result of a call (POST /orders/:ref/transition)

/** The only hops this endpoint makes; everything else goes through a logged call. */
export const MANUAL_HOPS: readonly StatusHop[] = [
  ['unreachable', 'cancelled'],
  ['confirmed', 'cancelled'],
  ['confirmed', 'shipped'],
  ['shipped', 'delivered'],
  ['shipped', 'returned'],
];

const isManual = (from: OrderStatus, to: OrderStatus) => MANUAL_HOPS.some(([f, t]) => f === from && t === to);

/** Cancel reasons for a manual cancel, per source status. */
export const MANUAL_CANCEL_REASONS: Readonly<Partial<Record<OrderStatus, readonly CancelReason[]>>> = {
  unreachable: ['unreachable', 'duplicate', 'out_of_stock', 'other'],
  confirmed: ['customer_refused', 'duplicate', 'out_of_stock', 'other'],
};

export const TransitionForm = v.object({
  version: vInt(0, Number.MAX_SAFE_INTEGER),
  to: v.optional(v.string(), ''),
  reason: v.optional(v.string(), ''),
  courierName: vOptionalText(80),
  courierTracking: vOptionalText(80),
  note: vOptionalText(1000),
});
export type TransitionInput = v.InferOutput<typeof TransitionForm>;

export function planTransition(order: OrderState, input: TransitionInput, ctx: { role: AdminRole }): PlanResult {
  const to = input.to as OrderStatus;
  if (!findTransition(order.status, to)) return { ok: false, status: 409, errors: { to: 'err.forbidden' } };
  if (!isManual(order.status, to)) return { ok: false, status: 409, errors: { to: 'err.useCall' } };
  if (!canTransition(order.status, to, ctx.role)) return { ok: false, status: 403, errors: { _form: 'err.forbidden' } };

  const errors: PlanErrors = {};
  let reason: CancelReason | undefined;
  if (to === 'cancelled') {
    const allowed = MANUAL_CANCEL_REASONS[order.status] ?? [];
    if ((allowed as readonly string[]).includes(input.reason)) reason = input.reason as CancelReason;
    else errors.reason = 'err.reasonRequired';
  }
  const patch: OrderChangePlan['patch'] = {};
  if (to === 'shipped') {
    if (input.courierName === null) errors.courierName = 'err.courierRequired';
    else {
      patch.courierName = input.courierName;
      patch.courierTracking = input.courierTracking;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, status: 422, errors };
  if (to === 'cancelled') patch.nextCallAt = null;

  const hops: StatusHop[] = [[order.status, to]];
  const plan: OrderChangePlan = {
    expectedVersion: input.version,
    hops,
    patch,
    status: to,
    restoresStock: restores(hops),
    audit: {
      action: 'order.transition',
      before: { status: order.status, version: order.version },
      after: {
        status: to,
        version: input.version + 1,
        ...(reason ? { reason } : {}),
        ...(patch.courierName !== undefined ? { courierName: patch.courierName, courierTracking: patch.courierTracking } : {}),
      },
    },
  };
  if (reason) plan.outcome = reason;
  if (input.note !== null) plan.note = input.note;
  return { ok: true, plan };
}

/** Manual hops `role` may make from `status` (for the detail page's action forms). */
export function manualTargets(status: OrderStatus, role: AdminRole): OrderStatus[] {
  return MANUAL_HOPS.filter(([f, t]) => f === status && canTransition(f, t, role)).map(([, t]) => t);
}

// ---------------------------------------------------------------------------------------------
// Note (POST /orders/:ref/note): an append-only `note` event, any status.

export const NoteForm = v.object({
  version: vInt(0, Number.MAX_SAFE_INTEGER),
  text: vText(1000),
});
export type NoteInput = v.InferOutput<typeof NoteForm>;

export function planNote(order: OrderState, input: NoteInput, ctx: { role: AdminRole }): PlanResult {
  if (!roleCan(ctx.role, 'orders.note')) return { ok: false, status: 403, errors: { _form: 'err.forbidden' } };
  return {
    ok: true,
    plan: {
      expectedVersion: input.version,
      hops: [],
      note: input.text,
      patch: {},
      status: order.status,
      restoresStock: false,
      audit: { action: 'order.note', before: null, after: { note: input.text } },
    },
  };
}

export { CANCEL_REASONS };
