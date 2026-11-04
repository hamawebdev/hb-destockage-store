/**
 * Order state machine (BRIEF §2): statuses, admin roles, transitions with the roles allowed to
 * make them and their stock effect, and call-attempt outcomes.
 *
 *   new → called (attempt n) → confirmed | unreachable | cancelled
 *   unreachable → called | cancelled
 *   confirmed → shipped | cancelled;  shipped → delivered | returned
 *   cancelled is terminal.
 *
 * Stock is decremented when the order is created; a transition with `stock: 'restore'` puts the
 * quantities back (cancelled, returned). The admin applies `TRANSITIONS` and records each change
 * in `order_events`; it never writes a status the table does not allow.
 */

export const ORDER_STATUSES = [
  'new',
  'called',
  'confirmed',
  'unreachable',
  'cancelled',
  'shipped',
  'delivered',
  'returned',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ADMIN_ROLES = ['owner', 'confirmer', 'logistics', 'content'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export type StockEffect = 'none' | 'restore';

export interface Transition {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly roles: readonly AdminRole[];
  readonly stock: StockEffect;
}

const CALLERS = ['owner', 'confirmer'] as const satisfies readonly AdminRole[];
const SHIPPERS = ['owner', 'logistics'] as const satisfies readonly AdminRole[];

/**
 * The complete table; anything not listed is refused. Roles approved by the lead (ADMIN-0 plan §4):
 * confirmer = calling transitions, logistics = shipping transitions, owner = every transition,
 * content = none. Tested pairwise in SHARED-4.
 */
export const TRANSITIONS: readonly Transition[] = [
  { from: 'new', to: 'called', roles: CALLERS, stock: 'none' },
  { from: 'called', to: 'confirmed', roles: CALLERS, stock: 'none' },
  { from: 'called', to: 'unreachable', roles: CALLERS, stock: 'none' },
  { from: 'called', to: 'cancelled', roles: CALLERS, stock: 'restore' },
  { from: 'unreachable', to: 'called', roles: CALLERS, stock: 'none' },
  { from: 'unreachable', to: 'cancelled', roles: CALLERS, stock: 'restore' },
  { from: 'confirmed', to: 'cancelled', roles: CALLERS, stock: 'restore' },
  { from: 'confirmed', to: 'shipped', roles: SHIPPERS, stock: 'none' },
  { from: 'shipped', to: 'delivered', roles: SHIPPERS, stock: 'none' },
  { from: 'shipped', to: 'returned', roles: SHIPPERS, stock: 'restore' },
];

export const TERMINAL_STATUSES: readonly OrderStatus[] = ['cancelled', 'delivered', 'returned'];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

export function findTransition(from: OrderStatus, to: OrderStatus): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/** True when `role` may move an order from `from` to `to`. */
export function canTransition(from: OrderStatus, to: OrderStatus, role: AdminRole): boolean {
  return findTransition(from, to)?.roles.includes(role) ?? false;
}

/** Statuses `role` may move an order to from `from` (for the admin's action buttons). */
export function nextStatuses(from: OrderStatus, role: AdminRole): OrderStatus[] {
  return TRANSITIONS.filter((t) => t.from === from && t.roles.includes(role)).map((t) => t.to);
}

// ---------------------------------------------------------------------------------------------
// Call attempts

export const CALL_OUTCOMES = [
  'no_answer',
  'busy',
  'wrong_number',
  /** Customer asked to be called back later. */
  'callback',
  'confirmed',
  'cancelled',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const CANCEL_REASONS = [
  'customer_refused',
  'wrong_number',
  'unreachable',
  'duplicate',
  'out_of_stock',
  'other',
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export function isCancelReason(value: unknown): value is CancelReason {
  return typeof value === 'string' && (CANCEL_REASONS as readonly string[]).includes(value);
}

/** Statuses from which a call attempt can be recorded. */
export const CALLABLE_STATUSES: readonly OrderStatus[] = ['new', 'called', 'unreachable'];

/** Default for setting `orderMaxUnanswered`: unanswered calls in a row before `unreachable`. */
export const DEFAULT_MAX_UNANSWERED = 3;

/**
 * What the admin schedules next: `retry` (short gap, still `called`), `unreachable_retry` (long
 * gap), `callback` (the time the customer chose), `clear` (no further call).
 */
export type NextCall = 'retry' | 'unreachable_retry' | 'callback' | 'clear';

export type StatusHop = readonly [from: OrderStatus, to: OrderStatus];

export interface CallOutcomeInput {
  readonly status: OrderStatus;
  readonly outcome: CallOutcome;
  /** Consecutive `no_answer`/`busy` attempts before this one, since the last other outcome. */
  readonly unansweredStreak: number;
  /** Setting `orderMaxUnanswered` (≥ 1). */
  readonly maxUnanswered: number;
}

export type CallOutcomeResolution =
  | {
      /** Status changes to apply in order; each is checked with `canTransition` and logged as a `status_change` event. */
      readonly hops: readonly StatusHop[];
      readonly nextCall: NextCall;
      /** Final status (= `status` when `hops` is empty). */
      readonly status: OrderStatus;
      /** Set when the outcome itself implies the cancel reason (`wrong_number`). */
      readonly cancelReason?: CancelReason | undefined;
    }
  | { readonly error: 'not_callable' };

/**
 * Maps one logged call to status hops (AORD-0 plan §4). A call from `new` or `unreachable` always
 * hops to `called` first. `no_answer`/`busy` keep `called` until the streak (this call included)
 * reaches `maxUnanswered`, then go to `unreachable`; from `unreachable` they return to it.
 * `call_attempts` is incremented once per call regardless of hops.
 */
export function resolveCallOutcome(input: CallOutcomeInput): CallOutcomeResolution {
  const { status, outcome } = input;
  if (!CALLABLE_STATUSES.includes(status)) return { error: 'not_callable' };
  const hops: StatusHop[] = status === 'called' ? [] : [[status, 'called']];
  const to = (target: OrderStatus): void => {
    hops.push(['called', target]);
  };
  let nextCall: NextCall;
  let cancelReason: CancelReason | undefined;
  switch (outcome) {
    case 'no_answer':
    case 'busy': {
      const max = Math.max(1, Math.trunc(input.maxUnanswered));
      const streak = Math.max(0, Math.trunc(input.unansweredStreak)) + 1;
      if (status === 'unreachable' || streak >= max) {
        to('unreachable');
        nextCall = 'unreachable_retry';
      } else {
        nextCall = 'retry';
      }
      break;
    }
    case 'callback':
      nextCall = 'callback';
      break;
    case 'confirmed':
      to('confirmed');
      nextCall = 'clear';
      break;
    case 'cancelled':
      to('cancelled');
      nextCall = 'clear';
      break;
    case 'wrong_number':
      to('cancelled');
      nextCall = 'clear';
      cancelReason = 'wrong_number';
      break;
  }
  const last = hops.at(-1);
  const final = last === undefined ? status : last[1];
  return cancelReason === undefined
    ? { hops, nextCall, status: final }
    : { hops, nextCall, status: final, cancelReason };
}
