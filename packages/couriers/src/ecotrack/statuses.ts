/**
 * EcoTrack statuses, from the official docs (artifacts/delivery-research/status-lists/ecotrack.json).
 * The API has three vocabularies, which must not be mixed. Polling reads slugs; the other two tables
 * exist so that every official status is mapped by test. Meanings of labels and slugs are inferred.
 */
import { statusTable } from '../status.ts';

export const ECOTRACK_SLUGS = statusTable({
  prete_a_expedier: 'pending',
  en_ramassage: 'pending',
  en_preparation_stock: 'pending',
  prete_a_preparer: 'pending',

  vers_hub: 'in_transit',
  en_hub: 'in_transit',
  vers_wilaya: 'in_transit',
  // At the destination station, despite the name.
  en_preparation: 'in_transit',
  en_livraison: 'in_transit',

  suspendu: 'exception',
  annule: 'exception',

  livre_non_encaisse: 'delivered',
  encaisse_non_paye: 'delivered',
  paiements_prets: 'delivered',
  paye_et_archive: 'delivered',
  // The docs' example spells it this way; the enum doesn't. Both are real entries.
  payé_et_archivé: 'delivered',

  retour_chez_livreur: 'returning',
  retour_transit_entrepot: 'returning',
  retour_en_traitement: 'returning',

  retour_recu: 'returned',
  retour_archive: 'returned',
});

export const ECOTRACK_LABELS = statusTable({
  'Prêt à expédier': 'pending',
  'Prêt à préparer': 'pending',
  'En ramassage': 'pending',
  'Stock en préparation': 'pending',

  'Vers hub': 'in_transit',
  'En hub': 'in_transit',
  'Vers wilaya': 'in_transit',
  'En préparation': 'in_transit',
  'En livraison': 'in_transit',

  Suspendus: 'exception',
  // Held in the courier's stock warehouse: we send stock=0, so this isn't back with the merchant.
  'Retours en stock': 'exception',

  'Livre non encaissé': 'delivered',
  'Livre encaissé non payé': 'delivered',
  'Paiement prêt': 'delivered',
  'Paiement archivé': 'delivered',

  'Retours chez livreur': 'returning',
  'Retours en traitement': 'returning',
  'Retours prêts': 'returning',
  'Retours à dispatcher vers stock': 'returning',
  'Retours en transit stock': 'returning',

  'Retours reçu': 'returned',
  'Retours archivé': 'returned',
});

export const ECOTRACK_ACTIVITY = statusTable({
  order_information_received_by_carrier: 'pending',

  picked: 'in_transit',
  accepted_by_carrier: 'in_transit',
  dispatched_to_driver: 'in_transit',

  attempt_delivery: 'exception',

  return_asked: 'returning',
  return_in_transit: 'returning',

  Return_received: 'returned',

  livred: 'delivered',
  encaissed: 'delivered',
  payed: 'delivered',
});

/** The courier says this parcel no longer exists as a live parcel. */
export const ECOTRACK_GONE: ReadonlySet<string> = new Set(['annule']);
