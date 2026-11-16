// The admin role matrix: the single source of truth for who may do what.
// Approved by the lead in ADMIN-0 (artifacts/ADMIN-0/plan.md §0, §4). Changing a row is a
// high-risk change: it needs review and the client's sign-off.
//
// Order status transitions are NOT here: they live in `@hb/shared` order-state.ts
// (`canTransition(from, to, role)`). `orders.transition` only gates the route; the handler must
// still call `canTransition`.

import { ADMIN_ROLES } from '@hb/db';
import type { CurrentUser, Role } from '../env.ts';

export const ROLES: readonly Role[] = ADMIN_ROLES;

const ALL = ['owner', 'confirmer', 'logistics', 'content'] as const satisfies readonly Role[];

export const PERMISSIONS = {
  // Dashboard (tiles are filtered per role by the dashboard itself).
  'dashboard.view': ALL,
  // Own preferences (UI language).
  'self.lang': ALL,

  // Orders (admin-orders).
  'orders.view': ['owner', 'confirmer', 'logistics'],
  'orders.queue': ['owner', 'confirmer'],
  'orders.shipping': ['owner', 'logistics'],
  'orders.call': ['owner', 'confirmer'],
  'orders.note': ['owner', 'confirmer', 'logistics'],
  'orders.transition': ['owner', 'confirmer', 'logistics'],
  'orders.edit': ['owner', 'confirmer'],

  // Customers (admin-orders). `content` never sees customer personal data.
  'customers.view': ['owner', 'confirmer', 'logistics'],
  // Notes, flags, block state, risk/anti-fraud fields, ip_hash, order history and counters.
  // Without it (logistics) only delivery fields are ever SELECTed: see lib/projection.ts.
  // Lead decision 2026-11-05.
  'customers.sensitive': ['owner', 'confirmer'],
  'customers.flag': ['owner', 'confirmer'],
  'customers.block': ['owner', 'confirmer'],
  'customers.unblock': ['owner'],

  // Catalogue (admin-catalog). Read-only catalogue for confirmer/logistics: lead decision
  // 2026-11-04 (artifacts/ACAT-0/plan.md §0a).
  'catalog.view': ALL,
  'catalog.edit': ['owner', 'content'],
  'stock.edit': ['owner', 'logistics', 'content'],
  'media.edit': ['owner', 'content'],
  'content.edit': ['owner', 'content'],
  'publish.run': ['owner', 'content'],
  'publish.abandon': ['owner'],

  // Delivery fees drive order totals: owner edits, confirmer and logistics read (lead decision).
  'fees.view': ['owner', 'confirmer', 'logistics'],
  'fees.edit': ['owner'],

  // Delivery (shipping; ADMIN2/BRIEF §5).
  'delivery.view': ['owner', 'confirmer', 'logistics'],
  'delivery.send': ['owner', 'logistics'],
  'delivery.settings': ['owner'],

  // Administration (admin-core).
  'users.manage': ['owner'],
  'settings.edit': ['owner'],
  'audit.view': ['owner'],

  // Google Sheets connection (sheets): owner only (ADMIN2 brief §5).
  'sheets.settings': ['owner'],

  // Meta Pixel and Conversions API credentials (MSET-2, D-017): owner only. The access token is
  // write-only; see routes/meta.
  'meta.settings': ['owner'],

  // Telegram order messages (TGS-4, D-022): bot token (write-only), chats and ticked details.
  // Owner only; see routes/telegram.
  'telegram.settings': ['owner'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function rolesFor(perm: Permission): readonly Role[] {
  return PERMISSIONS[perm];
}

export function roleCan(role: Role, perm: Permission): boolean {
  return (PERMISSIONS[perm] as readonly Role[]).includes(role);
}

/** For the UI (show/hide links and buttons). Never a substitute for `requirePerm` on the route. */
export function can(user: Pick<CurrentUser, 'role'> | undefined, perm: Permission): boolean {
  return user !== undefined && roleCan(user.role, perm);
}
