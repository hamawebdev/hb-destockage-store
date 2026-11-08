// Text enums stored in D1. Each one is enforced twice: as a TypeScript union (Drizzle `enum`)
// and as a SQL CHECK constraint in the migration, so a raw `wrangler d1 execute` cannot write an
// unknown value either.
//
// LANGS, ORDER_STATUSES and ADMIN_ROLES are owned by `@hb/shared` and re-exported here (DB-4);
// test/enums.test.ts asserts the SQL CHECK lists in the migrations equal them.
import { ADMIN_ROLES, LANGS, ORDER_STATUSES } from '@hb/shared';
export { ADMIN_ROLES, LANGS, ORDER_STATUSES };

export type DbLang = (typeof LANGS)[number];

export const PRODUCT_KINDS = ['simple', 'variable', 'pack'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const OPTION_KINDS = ['size', 'colour', 'other'] as const;
export type OptionKind = (typeof OPTION_KINDS)[number];

export type DbOrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_EVENT_TYPES = ['created', 'status_change', 'call_attempt', 'note'] as const;
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

/** Who caused an order event or an audit row. `admin` rows carry `actor_user_id`. */
export const ACTOR_TYPES = ['customer', 'system', 'admin'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export type DbAdminRole = (typeof ADMIN_ROLES)[number];

/** Result of the server-side Turnstile check. Missing/invalid ⇒ order accepted and flagged. */
export const TURNSTILE_RESULTS = ['ok', 'missing', 'invalid', 'error'] as const;
export type TurnstileResult = (typeof TURNSTILE_RESULTS)[number];

export const PUBLISH_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

export const CONTENT_PAGE_KEYS = ['about', 'delivery', 'returns', 'contact', 'legal', 'privacy'] as const;
export type ContentPageKey = (typeof CONTENT_PAGE_KEYS)[number];

/** Shape of one element of `content_pages.body_*` (CAT-1 `ContentBlock`). */
export type ContentBlockJson =
  | { readonly type: 'h2'; readonly text: string }
  | { readonly type: 'p'; readonly text: string }
  | { readonly type: 'ul'; readonly items: readonly string[] }
  | { readonly type: 'ol'; readonly items: readonly string[] }
  | { readonly type: 'link'; readonly text: string; readonly href: string };

/** Web Vitals + navigation-timing phases (DNS, CONNECT, TLS). One row per metric per beacon. */
export const RUM_METRICS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB', 'DNS', 'CONNECT', 'TLS'] as const;
export type RumMetric = (typeof RUM_METRICS)[number];

export const RUM_RATINGS = ['good', 'needs-improvement', 'poor'] as const;
export type RumRating = (typeof RUM_RATINGS)[number];

/** `dead` (DB-7, JOBS-6): the queue dead-lettered the message; the admin shows it. */
export const DELIVERY_STATUSES = ['sending', 'sent', 'dead'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * Settings key registry (`settings` is key → JSON). Only the storefront keys (CAT-1
 * SnapshotSettings) are exported in the catalogue snapshot (`@hb/db/export`); every other key is
 * internal and never leaves the database through the export.
 */
export const STOREFRONT_SETTINGS_KEYS = [
  'storeName',
  'contactPhone',
  'whatsapp',
  'contactEmail',
  'homeFeaturedProductIds',
  'homeHeroProductId',
  'turnstileSiteKey',
] as const;

export const INTERNAL_SETTINGS_KEYS = {
  /** jobs (JOBS-1): backup health mirror {lastSuccess, lastFailure, retention, health}; read by the admin dashboard. */
  'jobs.backup_status': 'jobs',
  /** jobs (JOBS-6): malformed notification messages {count, lastAt}. */
  'jobs.notify_invalid': 'jobs',
  /** jobs (JOBS-7, D-003): nightly full byte-budget pass {at, ok, summary, publishRunId, fingerprint}; read by the admin tile. */
  'jobs.runtime_budget': 'jobs',
  /** db seed (DB-3 r4): ids the local seed owns {products, categories}. Local only. */
  'seed.owned': 'db',
} as const;
