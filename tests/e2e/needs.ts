/**
 * `needs(features…)(name, fn)`: a test that runs when its features are in the checkout, is
 * skipped with the reason otherwise (shown in the test name), and FAILS instead of skipping when
 * HB_E2E_STRICT=1. When it runs and a worker it needs did not boot, it fails with the boot error.
 */
import { inject, it } from 'vitest';
import { STRICT, missing, type Feature } from './harness.ts';

export interface Ctx { web: string; admin: string }

export function needs(...features: Feature[]) {
  return (name: string, fn: (ctx: Ctx) => Promise<void>, timeout?: number): void => {
    const reason = missing(...features);
    if (reason && !STRICT) {
      it.skip(`${name} [waiting: ${reason}]`, () => {});
      return;
    }
    it(name, async () => {
      if (reason) throw new Error(`HB_E2E_STRICT=1 and a feature is missing: ${reason}`);
      const bootError = inject('bootError');
      if (bootError) throw new Error(`a worker did not boot: ${bootError}`);
      const web = inject('webUrl');
      const admin = inject('adminUrl');
      const wantsWeb = features.some((f) => ['webOrder', 'webQuote', 'orderForm', 'geoFiles', 'storefront'].includes(f));
      const wantsAdmin = features.some((f) => f.startsWith('admin'));
      if (wantsWeb && !web) throw new Error('web Worker not running (apps/web/wrangler.jsonc missing or storefront not built)');
      if (wantsAdmin && !admin) throw new Error('admin Worker not running');
      await fn({ web: web ?? '', admin: admin ?? '' });
    }, timeout);
  };
}
