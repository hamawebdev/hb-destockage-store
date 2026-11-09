/**
 * Maystro order status codes, as strings (artifacts/delivery-research/status-lists/maystro.json).
 * The code table is official; the numbering isn't intuitive, so only exact codes map.
 */
import { mapStatus, statusTable } from '../status.ts';
import type { CourierStatus } from '../types.ts';

export const MAYSTRO_STATUSES = statusTable({
  '4': 'pending', // CREATED
  '5': 'pending', // PICK_UP_REQUESTED
  '6': 'pending', // IN_PROCESS
  '11': 'pending', // PENDING

  '8': 'in_transit', // WAITING_TRANSIT
  '9': 'in_transit', // IN_TRANSIT_TO_BE_SHIPPED
  '15': 'in_transit', // READY_TO_SHIP
  '22': 'in_transit', // ASSIGNED
  '31': 'in_transit', // SHIPPED

  '10': 'returning', // IN_TRANSIT_TO_BE_RETURNED
  '51': 'returning', // READY_TO_RETURN

  '12': 'exception', // OUT_OF_STOCK
  '32': 'exception', // ALERTED
  '42': 'exception', // POSTPONED
  '50': 'exception', // ABORTED, which also happens before shipment
  '53': 'exception', // NOT_RECEIVED: the store reports it never got the return

  '41': 'delivered', // DELIVERED

  '52': 'returned', // TAKEN_BY_STORE
});

/** The code in its table form, or null for anything that isn't a whole number. */
export function maystroCode(status: unknown): string | null {
  if (typeof status === 'number' && Number.isInteger(status)) return String(status);
  if (typeof status === 'string' && /^\d+$/.test(status)) return status;
  return null;
}

export function maystroStatus(status: unknown): CourierStatus {
  const code = maystroCode(status);
  return code === null ? 'unknown' : mapStatus(MAYSTRO_STATUSES, code);
}
