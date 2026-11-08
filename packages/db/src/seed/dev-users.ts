// Development admin users (DB-3). Loaded only by the local seed command, never by a migration.
// The admin's dev login (ENV=development + localhost) lists only @dev.local users (ADMIN-0 §3).
import type { SeedAdminUser } from './build.ts';

export const DEV_ADMIN_USERS: readonly SeedAdminUser[] = [
  { email: 'owner@dev.local', name: 'Dev Owner', role: 'owner', active: true },
  { email: 'confirmer@dev.local', name: 'Dev Confirmer', role: 'confirmer', active: true },
  { email: 'logistics@dev.local', name: 'Dev Logistics', role: 'logistics', active: true },
  { email: 'content@dev.local', name: 'Dev Content', role: 'content', active: true },
  { email: 'inactive@dev.local', name: 'Dev Inactive', role: 'confirmer', active: false },
];
