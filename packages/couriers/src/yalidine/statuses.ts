/**
 * Yalidine platform statuses, one exact entry each. Not from the official page, which needs a
 * merchant login: 30 values from yalidine-node's transcription and 11 seen only in dz-delivery.
 * Meanings are inferred from the French wording (artifacts/delivery-research/status-lists/yalidine.json).
 */
import { statusTable } from '../status.ts';

export const YALIDINE_STATUSES = statusTable({
  'Pas encore expédié': 'pending',
  'A vérifier': 'pending',
  'En préparation': 'pending',
  'Pas encore ramassé': 'pending',
  'Prêt à expédier': 'pending',
  'En passation': 'pending',

  Ramassé: 'in_transit',
  Débloqué: 'in_transit',
  Transfert: 'in_transit',
  Expédié: 'in_transit',
  Centre: 'in_transit',
  'En localisation': 'in_transit',
  'Vers Wilaya': 'in_transit',
  'Reçu à Wilaya': 'in_transit',
  'En attente du client': 'in_transit',
  'Prêt pour livreur': 'in_transit',
  'Sorti en livraison': 'in_transit',
  'En transit': 'in_transit',
  'Vers Station': 'in_transit',
  'En station': 'in_transit',
  'En attente de transfert': 'in_transit',
  Dispatché: 'in_transit',
  'Alerte résolue': 'in_transit',

  Bloqué: 'exception',
  'En attente': 'exception',
  'En alerte': 'exception',
  'Tentative échouée': 'exception',
  'Echèc livraison': 'exception',
  'Echange échoué': 'exception',
  'Retour non retiré': 'exception',
  'Colis abandonné': 'exception',
  Annulé: 'exception',
  Supprimé: 'exception',

  Livré: 'delivered',

  'Retour vers centre': 'returning',
  'Retourné au centre': 'returning',
  'Retour transfert': 'returning',
  'Retour groupé': 'returning',
  'Retour à retirer': 'returning',
  'Retour vers vendeur': 'returning',

  'Retourné au vendeur': 'returned',
});

/** The courier says this parcel no longer exists as a live parcel. */
export const YALIDINE_GONE: ReadonlySet<string> = new Set(['Annulé', 'Supprimé']);
