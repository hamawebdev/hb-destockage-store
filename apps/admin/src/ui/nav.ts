// Navigation entries, filtered per user with `can()`. Paths are the mount points in app.ts.
// Items are flat; `parent` nests one under another in the sidebar. A child whose parent the role
// cannot see simply shows at the top level of its group.
import { can, type Permission } from '../auth/permissions.ts';
import type { CurrentUser } from '../env.ts';
import type { MessageKey } from '../i18n/index.ts';
import type { AdminIconName } from './icons.tsx';

export interface NavItem {
  href: string;
  label: MessageKey;
  perm: Permission;
  icon: AdminIconName;
  /** href of the item this one sits under. */
  parent?: string;
}

export interface NavGroup {
  items: readonly NavItem[];
}

export const NAV: readonly NavGroup[] = [
  { items: [{ href: '/dashboard', label: 'nav.dashboard', perm: 'dashboard.view', icon: 'home' }] },
  {
    items: [
      { href: '/orders', label: 'nav.orders', perm: 'orders.view', icon: 'inbox' },
      { href: '/orders/queue', label: 'nav.queue', perm: 'orders.queue', icon: 'phone', parent: '/orders' },
      { href: '/customers', label: 'nav.customers', perm: 'customers.view', icon: 'users', parent: '/orders' },
      { href: '/orders/shipping', label: 'nav.shipping', perm: 'orders.shipping', icon: 'truck' },
    ],
  },
  {
    items: [
      { href: '/products', label: 'nav.products', perm: 'catalog.view', icon: 'box' },
      { href: '/categories', label: 'nav.categories', perm: 'catalog.view', icon: 'tag', parent: '/products' },
      { href: '/media', label: 'nav.media', perm: 'media.edit', icon: 'image', parent: '/products' },
    ],
  },
  {
    items: [
      { href: '/fees', label: 'nav.fees', perm: 'fees.view', icon: 'pin' },
      { href: '/content', label: 'nav.content', perm: 'content.edit', icon: 'file' },
      { href: '/publish', label: 'nav.publish', perm: 'publish.run', icon: 'upload' },
    ],
  },
  {
    items: [
      { href: '/users', label: 'nav.users', perm: 'users.manage', icon: 'users' },
      { href: '/settings', label: 'nav.settings', perm: 'settings.edit', icon: 'sliders' },
      { href: '/audit', label: 'nav.audit', perm: 'audit.view', icon: 'list' },
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

/** Phone tab bar: the role's first four destinations, in the order of daily use. */
const TAB_PRIORITY = ['/dashboard', '/orders', '/orders/queue', '/orders/shipping', '/products', '/categories', '/media', '/publish'];

export function tabsFor(groups: readonly NavGroup[]): NavItem[] {
  const items = groups.flatMap((g) => g.items);
  return TAB_PRIORITY.flatMap((href) => items.filter((i) => i.href === href)).slice(0, 4);
}
