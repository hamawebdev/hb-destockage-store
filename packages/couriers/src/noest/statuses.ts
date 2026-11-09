/**
 * NOEST events (artifacts/delivery-research/status-lists/noest.json). No public docs exist: this
 * comes through dz-delivery's reading of a partner PDF, and meanings are inferred from English labels.
 * Keys are looked up in the key table only, and the English `event` fallback in the label table only.
 * Spellings are verbatim, typos included.
 */
import { statusTable } from '../status.ts';

export const NOEST_KEYS = statusTable({
  upload: 'pending',
  customer_validation: 'pending',

  validation_collect_colis: 'in_transit',
  validation_reception_admin: 'in_transit',
  validation_reception: 'in_transit',
  fdr_activated: 'in_transit',
  sent_to_redispatch: 'in_transit',
  nouvel_tentative_asked_by_customer: 'in_transit',
  return_redispatched_to_livraison: 'in_transit',
  pickedup: 'in_transit',
  valid_return_pickup: 'in_transit',

  mise_a_jour: 'exception',
  colis_suspendu: 'exception',
  ask_to_delete_by_admin: 'exception',
  ask_to_delete_by_hub: 'exception',
  // We send only delivery orders: these shouldn't happen, and can't prove a delivery.
  echange_valide: 'exception',
  echange_valid_by_hub: 'exception',
  pickup_picked_recu: 'exception',
  colis_pickup_transmit_to_partner: 'exception',

  livre: 'delivered',
  livred: 'delivered',
  // Finance events: they only ever follow delivery.
  verssement_admin_cust: 'delivered',
  verssement_admin_cust_canceled: 'delivered',
  verssement_hub_cust_canceled: 'delivered',
  validation_reception_cash_by_partener: 'delivered',

  return_asked_by_customer: 'returning',
  return_asked_by_hub: 'returning',
  return_dispatched_to_partenaire: 'returning',
  retour_dispatched_to_partenaires: 'returning',
  colis_retour_transmit_to_partner: 'returning',
  return_dispatched_to_warehouse: 'returning',
  annulation_dispatch_retour: 'returning',
  cancel_return_dispatched_to_partenaire: 'returning',
  livraison_echoue_recu: 'returning',

  return_validated_by_partener: 'returned',
});

export const NOEST_LABELS = statusTable({
  'Uploaded to system': 'pending',
  Validated: 'pending',

  'Package Picked Up': 'in_transit',
  'Reception validated': 'in_transit',
  'Picked up by driver': 'in_transit',
  'Out for delivery': 'in_transit',
  'Sent for redispatch': 'in_transit',
  'New attempt requested by seller': 'in_transit',
  'Return put back for delivery': 'in_transit',

  'Delivery attempt': 'exception',
  Suspended: 'exception',
  'Deletion requested': 'exception',
  'Exchange validated': 'exception',
  'Exchange validated by hub': 'exception',

  Delivered: 'delivered',
  'Amount transmitted to partner': 'delivered',
  'Amount received by partner': 'delivered',

  'Return requested by partner': 'returning',
  'Return in transit': 'returning',
  'Return dispatched to partner': 'returning',
  'Return package transmitted to partner': 'returning',
  'Return dispatched to warehouse': 'returning',

  'Return received by partner': 'returned',
  'Return validated by partner': 'returned',
});

/** Remarks: they must not change a parcel's status or its event key. */
export const NOEST_NON_STATUS_EVENTS: ReadonlySet<string> = new Set([
  'edited_informations',
  'edit_price',
  'edit_wilaya',
  'extra_fee',
]);
