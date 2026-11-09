/** Every built courier, one line each. A courier without built, tested code isn't listed. */
import type { CourierAdapter } from './types.ts';
import { ecotrackAdapters } from './ecotrack/adapter.ts';
import { guepex, yalidine } from './yalidine/adapter.ts';
import { zrExpress } from './zr-express/adapter.ts';
import { maystro } from './maystro/adapter.ts';
import { noest } from './noest/adapter.ts';

const adapters: readonly CourierAdapter[] = [yalidine, guepex, ...ecotrackAdapters, zrExpress, noest, maystro];

// A Map, because the id comes from a public webhook path: `__proto__` must find nothing.
const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));

export function getCourier(id: string): CourierAdapter | undefined {
  return byId.get(id);
}

export function listCouriers(): readonly CourierAdapter[] {
  return adapters;
}
