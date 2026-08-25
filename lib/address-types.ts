/**
 * FULFILLMENT ROUTING LOT B.5 — Structured Address Foundation.
 *
 * Fondation TYPES uniquement pour une adresse client structurée
 * réutilisable, préparée AVANT que Lot C n'active le branchement
 * runtime du fulfillment routing (Sale Mode → Fulfillment →
 * Provider, Lot A.1/Lot B.2 déjà mergés/installés en Production).
 *
 * Problème que ce lot corrige EN AMONT (voir le rapport de mission,
 * section "CURRENT ADDRESS FLOW") : `create_order` dérive aujourd'hui
 * le code postal par une expression régulière appliquée à une adresse
 * combinée en une seule chaîne (`v_postal := substring(v_address from
 * '\m(\d{5})\M')`, supabase/migration-v82-lot2a-sale-modes.sql) —
 * fragile, et implicitement France-specific (5 chiffres). Le futur
 * routing (Lot C) ne doit PAS être construit sur ce même parsing. Ce
 * fichier ne touche PAS create_order (interdit par la mission, Lot D
 * uniquement) : il définit seulement le contrat cible.
 *
 * `StructuredCustomerAddress` est LE type canonique unique — jamais
 * dupliqué — représentant une adresse client structurée, qu'elle
 * provienne :
 *   - d'une suggestion d'autocomplete sélectionnée (via
 *     normalizeAddressSuggestion(), lib/services/address-search.ts) ;
 *   - d'une saisie manuelle structurée (fallback, si l'API adresse est
 *     indisponible — voir manualAddressToStructured()).
 *
 * GÉNÉRIQUE PAR CONCEPTION (mission §5/§7) : aucun champ ni aucune
 * valeur France/Belgique/Algérie codée en dur ici. `countryCode` est
 * une chaîne ouverte (ISO 3166-1 alpha-2 attendu, jamais validée ici
 * contre une liste fermée de pays). Le premier fournisseur concret
 * (France, voir lib/services/address-search.ts) est spécifique à un
 * pays ; cette interface ne l'est pas.
 */

/**
 * Adresse client structurée — contrat canonique unique.
 *
 * `postalCode` est LA source de vérité pour le futur resolveur
 * fulfillment (Lot C) : `structuredAddress.postalCode` directement,
 * jamais un re-parsing d'une chaîne combinée. Cette interface ne
 * décide JAMAIS de fulfillment/provider (voir AddressSearchProvider
 * ci-dessous, séparation stricte mission §8).
 */
export interface StructuredCustomerAddress {
  /** Numéro et rue (ou équivalent local), jamais l'adresse complète sur une ligne. */
  addressLine: string;
  postalCode: string;
  city: string;
  /** Chaîne ouverte, ISO 3166-1 alpha-2 attendu (ex. "FR") — jamais une énumération fermée ici. */
  countryCode: string;
  /** Libellé d'affichage complet optionnel (ex. tel que renvoyé par un provider), distinct d'addressLine. */
  label?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * Une suggestion retournée par un provider d'adresse, DÉJÀ mappée
 * vers le vocabulaire Scanym — aucun composant ni aucune couche
 * applicative ne doit jamais dépendre de la forme brute d'une API
 * externe (mission §6/§9). `id` sert à la fois de clé React et de
 * "provider address id / source id" (mission §OBJECTIF) — jamais
 * réutilisé comme identifiant métier persistant (ce lot ne persiste
 * rien, voir §12/§20 de la mission : create_order/orders inchangés).
 */
export interface AddressSuggestion {
  id: string;
  /** Libellé complet tel qu'affiché dans la liste de suggestions. */
  label: string;
  addressLine: string;
  postalCode: string;
  city: string;
  countryCode: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface AddressSearchOptions {
  /** Nombre maximal de suggestions demandées (mission §9 : "résultats limités raisonnablement"). */
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Signature générique d'une fonction de recherche d'adresse —
 * indépendante du provider concret qui l'implémente. Un composant
 * (ex. AddressAutocomplete) ne dépend QUE de cette signature, jamais
 * d'un provider nommé : voir mission §5/§7,
 * "countryCode → address provider strategy" reste conceptuel dans ce
 * lot (un seul provider concret existe : France, voir
 * lib/services/address-search.ts), mais aucun appelant ne suppose que
 * `searchAddressSuggestions` interroge nécessairement la France.
 */
export type AddressSearchFn = (
  query: string,
  options?: AddressSearchOptions
) => Promise<AddressSuggestion[]>;
