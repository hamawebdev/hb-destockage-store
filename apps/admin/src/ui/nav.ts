// Navigation entries, filtered per user with `can()`. Paths are the mount points in app.ts.
import { can, type Permission } from '../auth/permissions.ts';
import type { CurrentUser } from '../env.ts';
import type { MessageKey } from '../i18n/index.ts';

export interface NavItem {
  href: string;
  label: MessageKey;
  perm: Permission;
}

export interface NavGroup {
  items: readonly NavItem[];
}

export const NAV: readonly NavGroup[] = [
  { items: [{ href: '/dashboard', label: 'nav.dashboard', perm: 'dashboard.view' }] },
  {
    items: [
      { href: '/orders', label: 'nav.orders', perm: 'orders.view' },
      { href: '/orders/queue', label: 'nav.queue', perm: 'orders.queue' },
      { href: '/orders/shipping', label: 'nav.shipping', perm: 'orders.shipping' },
      { href: '/customers', label: 'nav.customers', perm: 'customers.view' },
    ],
  },
  {
    items: [
      { href: '/products', label: 'nav.products', perm: 'catalog.view' },
      { href: '/categories', label: 'nav.categories', perm: 'catalog.view' },
      { href: '/fees', label: 'nav.fees', perm: 'fees.view' },
      { href: '/content', label: 'nav.content', perm: 'content.edit' },
      { href: '/media', label: 'nav.media', perm: 'media.edit' },
      { href: '/publish', label: 'nav.publish', perm: 'publish.run' },
    ],
  },
  {
    items: [
      { href: '/users', label: 'nav.users', perm: 'users.manage' },
      { href: '/settings', label: 'nav.settings', perm: 'settings.edit' },
      { href: '/audit', label: 'nav.audit', perm: 'audit.view' },
    ],
  },
];

export function navFor(user: Pick<CurrentUser, 'role'>): NavGroup[] {
  return NAV.map((g) => ({ items: g.items.filter((i) => can(user, i.perm)) })).filter((g) => g.items.length > 0);
}

/** Longest nav href that prefixes `path` (so /orders/queue highlights "Call queue", not "Orders"). */
export function activeHref(path: string, items: readonly NavItem[]): string | undefined {
  let best: string | undefined;
  for (const { href } of items) {
    const hit = path === href || path.startsWith(`${href}/`);
    if (hit && (best === undefined || href.length > best.length)) best = href;
  }
  return best;
}
