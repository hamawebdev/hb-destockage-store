/** Every built courier, one line each. A courier without built, tested code isn't listed. */
import type { CourierAdapter } from './types.ts';

const adapters: readonly CourierAdapter[] = [];

// A Map, because the id comes from a public webhook path: `__proto__` must find nothing.
const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));

export function getCourier(id: string): CourierAdapter | undefined {
  return byId.get(id);
}

export function listCouriers(): readonly CourierAdapter[] {
  return adapters;
}
