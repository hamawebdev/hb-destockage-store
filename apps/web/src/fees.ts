/**
 * The FeeProvider this Worker uses: db's admin-table provider (`@hb/db/fees`, DB-6), shared with the
 * admin so a quote and an admin preview run the same code. No cache (D-002 addendum).
 * Placeholder (invented, seeded) fees are served ONLY when ENV is exactly "development": an unset,
 * misspelled, test, staging or production ENV fails closed and treats them as "no delivery".
 */
import { createAdminTableFeeProvider } from '@hb/db/fees';
import type { Db } from '@hb/db';
import type { FeeProvider } from '@hb/shared';

export function allowPlaceholderFees(env: { readonly ENV?: unknown }): boolean {
  return env.ENV === 'development';
}

export function feeProvider(db: Db, env: { readonly ENV?: unknown }): FeeProvider {
  return createAdminTableFeeProvider(db, { allowPlaceholderFees: allowPlaceholderFees(env) });
}
