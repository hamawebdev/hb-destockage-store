/**
 * The courier adapter contract (artifacts/CARR-0/contract.md). One adapter per courier or tenant,
 * reached through the registry. The package holds no keys: credentials come from the caller.
 *
 * Network methods never throw. Every failure is a value in the result union.
 */

export const COURIER_STATUSES = [
  'pending',
  'in_transit',
  'delivered',
  'returning',
  'returned',
  'exception',
  'unknown',
] as const;

/**
 * One result per raw courier status. Only `delivered` and `returned` can move an order; only
 * `returned` (physically back with the merchant) restocks. `returning` and `exception` are shown
 * with no order move. `unknown` never moves an order and goes to a person.
 */
export type CourierStatus = (typeof COURIER_STATUSES)[number];

/** Credential values by field key. Never logged, never returned in a result. */
export type CourierCredentials = Readonly<Record<string, string>>;

export interface CourierContext {
  /** The Worker's `ENV`. Anything but exactly `production` is held to the loopback guard. */
  readonly env: string | undefined;
  /** Stand-in base URL (`COURIER_STANDIN_URL`). Ignored in production. */
  readonly standinUrl?: string;
  /** Per request; default 10 s, clamped to 1 ms to 60 s. */
  readonly timeoutMs?: number;
  /** Per method, for methods making several requests; default 25 s. */
  readonly deadlineMs?: number;
  /** Injected for tests. */
  readonly fetch?: typeof fetch;
  /** Injected for tests; stamps `checkedAt`. */
  readonly now?: () => number;
}

export interface CredentialField {
  readonly key: string;
  /** Secret fields are write-only in the admin and masked after save. */
  readonly secret: boolean;
  readonly labelFr: string;
  readonly labelAr: string;
}

export type WebhookKind = 'hmac' | 'token' | 'none';

export interface CourierCapabilities {
  /** The courier can be asked whether a parcel with our reference exists. */
  readonly verifyByReference: boolean;
  /** A `not_found` only permits a resend when looked up at least this long after the attempt ended. */
  readonly verifyAfterSeconds: number;
  /** Past this, a `not_found` is not safe either (scan-based lookups). `null` = no upper bound. */
  readonly verifyWithinSeconds: number | null;
  /** The courier holds a created parcel as a draft until `validateParcel`. */
  readonly needsValidation: boolean;
  readonly stopDesk: boolean;
  readonly pollBatchSize: number;
  readonly minPollSeconds: number;
  /** Bulk sending must stay at or under this rate. */
  readonly sendPerMinute: number;
  readonly webhook: WebhookKind;
  /** The courier needs the merchant's origin wilaya on each parcel. */
  readonly needsOriginWilaya: boolean;
  readonly credentialFields: readonly CredentialField[];
}

/** What is and isn't confirmed about this courier. The admin must show it. */
export interface CourierConfidence {
  readonly baseUrl: 'confirmed' | 'probed' | 'unconfirmed';
  readonly statusList: 'official' | 'unofficial';
  readonly notes: readonly string[];
}

export type RejectCode =
  | 'auth'
  | 'rate_limited'
  | 'bad_request'
  | 'courier_refused'
  | 'guard_refused'
  | 'locked'
  | 'wrong_courier';

export type CreateResult =
  | {
      readonly kind: 'accepted';
      readonly tracking: string;
      /** The courier holds it unshipped until `validateParcel`. */
      readonly draft: boolean;
      readonly labelUrl?: string;
    }
  /** Definitely nothing created. Safe to fix and resend. */
  | {
      readonly kind: 'rejected';
      readonly code: RejectCode;
      readonly detail: string;
      readonly retryAfterMs?: number;
    }
  /** A parcel may exist. Store it, never auto-resend. */
  | { readonly kind: 'uncertain'; readonly cause: string };

export type ValidateResult =
  | { readonly kind: 'validated' }
  /** `code: 'locked'` means "may already be shipped", not a failure to fix. */
  | {
      readonly kind: 'rejected';
      readonly code: RejectCode;
      readonly detail: string;
      readonly retryAfterMs?: number;
    }
  | { readonly kind: 'uncertain'; readonly cause: string };

export interface LookupFound {
  readonly kind: 'found';
  readonly tracking: string;
  readonly rawStatus: string;
  readonly status: CourierStatus;
  /** The courier says the parcel is deleted or cancelled. */
  readonly gone: boolean;
}

export interface LookupNotFound {
  readonly kind: 'not_found';
  /** When the lookup ran (epoch ms). `isResendSafe` compares this with the attempt. */
  readonly checkedAt: number;
}

export interface LookupUnavailable {
  readonly kind: 'unavailable';
  readonly cause: string;
  readonly retryAfterMs?: number;
}

export type LookupResult =
  | LookupFound
  | { readonly kind: 'multiple'; readonly trackings: readonly string[] }
  | LookupNotFound
  | LookupUnavailable;

export type CredentialCheck =
  | { readonly kind: 'valid' }
  | { readonly kind: 'invalid'; readonly detail: string }
  /** The courier is down or answered oddly. Never read this as a bad key. */
  | { readonly kind: 'unavailable'; readonly cause: string }
  | { readonly kind: 'rate_limited'; readonly retryAfterMs?: number };

export interface ParcelEvent {
  readonly tracking: string;
  readonly rawStatus: string;
  readonly status: CourierStatus;
  readonly reason: string | null;
  /** Epoch ms, or null when the courier gave no usable time. */
  readonly occurredAt: number | null;
  /**
   * Same-channel redelivery gives the same key. Across webhook and poll it is best effort, so the
   * caller's terminal-state guard is what protects the order.
   */
  readonly eventKey: string;
}

export type StatusFetchResult =
  | {
      readonly ok: true;
      readonly events: readonly ParcelEvent[];
      /** Valid trackings the courier didn't return. */
      readonly absent: readonly string[];
      /** Trackings refused before sending. */
      readonly invalid: readonly string[];
      /** Rows dropped as unreadable; the rest are kept. */
      readonly badRows: number;
    }
  | { readonly ok: false; readonly cause: string; readonly retryAfterMs?: number };

export type LabelResult =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'pdf'; readonly bytes: Uint8Array; readonly contentType: 'application/pdf' }
  | { readonly kind: 'unavailable'; readonly cause: string; readonly retryAfterMs?: number };

export interface CourierWilaya {
  /** The courier's code (1..58 for couriers on the old scheme). */
  readonly code: number;
  readonly name: string;
  readonly deliverable: boolean;
}

export interface CourierCommune {
  readonly name: string;
  readonly wilayaCode: number;
  readonly hasStopDesk: boolean;
  readonly deliverable: boolean;
}

export interface CourierStopDesk {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly communeName: string;
  readonly wilayaCode: number;
  readonly wilayaName: string;
}

export type ListResult<T> =
  | { readonly ok: true; readonly items: readonly T[] }
  | { readonly ok: false; readonly cause: string; readonly retryAfterMs?: number };

/** The courier's own lists, fetched and cached by the caller and passed to `prepare`. */
export interface CourierLists {
  readonly wilayas: readonly CourierWilaya[];
  /** Communes of the destination's courier wilaya. */
  readonly communes: readonly CourierCommune[];
  /** Stop desks of the destination's courier wilaya. */
  readonly stopDesks: readonly CourierStopDesk[];
}

export interface ParcelInput {
  /** Our order ref. */
  readonly reference: string;
  readonly recipientName: string;
  /** Any stored form; normalised through the shared phone rule. */
  readonly phone: string;
  /** The order's 69-wilaya code. */
  readonly wilayaCode: number;
  readonly commune: {
    readonly nameFr: string;
    readonly nameAr: string;
    /** A person's pick from the courier's list, when automatic matching failed. */
    readonly courierName?: string;
  };
  readonly deliveryType: 'home' | 'stop_desk';
  readonly address?: string;
  readonly stopDeskId?: string;
  /** Integer DZD the customer pays, delivery included. */
  readonly codTotalDzd: number;
  readonly productLabel: string;
  /** 69-wilaya code of the merchant's origin, where the courier needs one. */
  readonly originWilayaCode?: number;
}

export type PrepareCode =
  | 'wilaya_unmapped'
  | 'wilaya_not_deliverable'
  | 'commune_unmapped'
  | 'commune_not_deliverable'
  | 'stop_desk_required'
  | 'stop_desk_mismatch'
  | 'address_required'
  | 'phone_invalid'
  | 'amount_out_of_range'
  | 'origin_missing'
  | 'recipient_required'
  | 'lists_missing';

export interface PreparedParcel {
  readonly courier: string;
  readonly reference: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type PrepareResult =
  | { readonly ok: true; readonly parcel: PreparedParcel }
  | { readonly ok: false; readonly code: PrepareCode; readonly detail: string };

export type WebhookFailure =
  | 'missing_secret'
  | 'missing_signature'
  | 'bad_signature'
  | 'malformed'
  | 'too_many_events';

export type WebhookVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: WebhookFailure };

export interface WebhookInput {
  /** The request body as received. Bytes, because a signature covers bytes, not decoded text. */
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly secret: string;
}

export type WebhookParseResult =
  | { readonly ok: true; readonly events: readonly ParcelEvent[]; readonly badRows: number }
  | { readonly ok: false; readonly reason: WebhookFailure };

export interface WebhookHandshakeResponse {
  readonly body: string;
  readonly contentType: 'text/plain';
}

export type WilayaMapping =
  | { readonly ok: true; readonly code: number }
  | { readonly ok: false; readonly code: 'wilaya_unmapped'; readonly detail: string };

export interface CourierAdapter {
  /** Stable and URL-safe: it appears in the public webhook path. */
  readonly id: string;
  readonly family: string;
  readonly displayName: string;
  readonly capabilities: CourierCapabilities;
  readonly confidence: CourierConfidence;

  mapWilaya(code: number): WilayaMapping;
  prepare(input: ParcelInput, lists: CourierLists): PrepareResult;

  checkCredentials(credentials: CourierCredentials, ctx: CourierContext): Promise<CredentialCheck>;
  listWilayas(
    credentials: CourierCredentials,
    ctx: CourierContext,
  ): Promise<ListResult<CourierWilaya>>;
  /** Takes the order's 69-wilaya code. */
  listCommunes(
    wilayaCode: number,
    credentials: CourierCredentials,
    ctx: CourierContext,
  ): Promise<ListResult<CourierCommune>>;
  /** Takes the order's 69-wilaya code. */
  listStopDesks(
    wilayaCode: number,
    credentials: CourierCredentials,
    ctx: CourierContext,
  ): Promise<ListResult<CourierStopDesk>>;

  createParcel(
    parcel: PreparedParcel,
    credentials: CourierCredentials,
    ctx: CourierContext,
  ): Promise<CreateResult>;
  validateParcel(
    tracking: string,
    options: { readonly askCollection: boolean },
    credentials: CourierCredentials,
    ctx: CourierContext,
  ): Promise<ValidateResult>;
  findByReference(
    reference: string,
    options: { readonly attemptedAt: number },
    credentials: CourierCredentials,
    ctx: CourierContext,
  ): Promise<LookupResult>;
  fetchStatuses(
    trackings: readonly string[],
    credentials: CourierCredentials,
    ctx: CourierContext,
  ): Promise<StatusFetchResult>;
  getLabel(
    tracking: string,
    credentials: CourierCredentials,
    ctx: CourierContext,
  ): Promise<LabelResult>;

  /** No credentials: it answers the courier's URL check on the public route. */
  webhookHandshake(query: Readonly<Record<string, string>>): WebhookHandshakeResponse | null;
  verifyWebhook(input: WebhookInput): Promise<WebhookVerification>;
  parseWebhook(rawBody: Uint8Array): WebhookParseResult;
}
