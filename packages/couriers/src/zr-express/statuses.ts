/**
 * ZR Express parcel states (artifacts/delivery-research/status-lists/zr-express.json). Workflows are
 * per tenant, so this list can't be complete: an unlisted state is `unknown` and goes to a person.
 */
import { mapStatus, statusTable } from '../status.ts';
import type { CourierStatus } from '../types.ts';

export const ZR_STATUSES = statusTable({
  commande_recue: 'pending',
  en_traitement: 'pending',
  appel_confirmation: 'pending',
  commande_confirmee: 'pending',
  en_preparation: 'pending',
  pret_a_expedier: 'pending',
  en_attente_dechange: 'pending',

  confirme_au_bureau: 'in_transit',
  dispatch: 'in_transit',
  vers_wilaya: 'in_transit',
  en_livraison: 'in_transit',
  sortie_en_livraison: 'in_transit',
  colis_recuperer: 'in_transit',

  livre: 'delivered',
  encaisse: 'delivered',
  recouvert: 'delivered',

  attente_recuperation_fournisseur: 'returning',
  retour_expediteur: 'returning',

  recupere_par_fournisseur: 'returned',

  // "Returned to inventory", with nothing saying it's the merchant's own premises.
  reinjecte_dans_stock: 'exception',
  annule: 'exception',
  supprimee: 'exception',

  // The docs name states in several forms; each is its own exact entry.
  OrderReceived: 'pending',
  ReadyToDispatch: 'pending',
  OnDelivery: 'in_transit',
  OutForDelivery: 'in_transit',
  'Out for Delivery': 'in_transit',
});

export const ZR_GONE: ReadonlySet<string> = new Set(['annule', 'supprimee']);
export const ZR_READY_STATES: readonly string[] = ['pret_a_expedier', 'ReadyToDispatch'];

/**
 * The state's result, given the parcel's `isReturn` flag. No return leg is documented, so a moving
 * parcel flagged as a return is on its way back (inferred). Delivered and flagged is a contradiction.
 */
export function zrStatus(name: unknown, isReturn: unknown): CourierStatus {
  const status = mapStatus(ZR_STATUSES, name);
  if (isReturn !== true) return status;
  if (status === 'pending' || status === 'in_transit') return 'returning';
  return status === 'delivered' ? 'exception' : status;
}
