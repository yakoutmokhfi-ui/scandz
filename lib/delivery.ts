import type { RestaurantSettings, DeliveryZone } from "@/lib/restaurants-config";
import type {
  PublicDeliveryInfo,
  PublicDeliveryFulfillmentRule,
  DeliveryFulfillmentStatus,
} from "@/lib/sale-modes-types";
import { isValidPostalCode } from "@/lib/customer";

// Ré-exportée : DeliveryZone devient le modèle COMMUN aux deux
// résolveurs de ce fichier (corrige L2B2-01) -- consommateurs et
// tests peuvent l'importer directement depuis lib/delivery.ts, sans
// remonter à restaurants-config.ts pour ce type générique.
export type { DeliveryZone };

export type DeliveryBlock = "below-min" | "no-postal" | "out-of-zone";

export interface DeliveryStatus {
  eligible: boolean;
  zone?: DeliveryZone;
  block?: DeliveryBlock;
  /** Nombre d'articles restant à ajouter pour la livraison */
  missing?: number;
}

/**
 * Détermine si la livraison est proposée, à partir du montant du panier
 * et du code postal saisi par le client.
 *
 * ⚠️ LOT 2B.2 -- CHEMIN LEGACY CONSERVÉ TEL QUEL, INTENTIONNELLEMENT.
 * Décision CIO explicite : le seul appelant réel de cette fonction est
 * MenuView.tsx (interdit de modification dans ce sous-lot), qui
 * l'utilise de façon SYNCHRONE dans un useMemo(). La rendre
 * asynchrone (nécessaire pour consommer get_restaurant_public_delivery_info,
 * un appel Supabase) exigerait de restructurer MenuView.tsx
 * (état/effet pour la récupération), explicitement hors périmètre.
 * L'import de RestaurantSettings/restaurants-config.ts est donc
 * TEMPORAIREMENT conservé UNIQUEMENT pour cette fonction -- ce n'est
 * PAS la suppression finale de cette dépendance, qui aura lieu lors
 * de la bascule réelle de MenuView.tsx (sous-lot séparé, non
 * commencé ici). Voir getDeliveryStatusFromPublicInfo ci-dessous pour
 * la nouvelle fonction pure, déjà prête pour cette bascule future.
 */
export function getDeliveryStatus(
  settings: RestaurantSettings,
  postalCode: string,
  totalCount: number
): DeliveryStatus {
  // La zone est contrôlée en premier : hors secteur, aucun montant ne
  // rendrait la livraison possible, il ne faut donc pas parler de seuil.
  const code = postalCode.trim();
  if (!isValidPostalCode(code)) return { eligible: false, block: "no-postal" };

  const zone = (settings.deliveryZones ?? []).find((z) => code.startsWith(z.code));
  if (!zone) return { eligible: false, block: "out-of-zone" };

  const min = settings.deliveryMinItems ?? 0;
  if (totalCount < min) {
    return { eligible: false, block: "below-min", missing: min - totalCount, zone };
  }

  return { eligible: true, zone };
}

/**
 * Zone de livraison générique reconnue à partir des informations
 * publiques LOT 2B.1 -- réutilise DIRECTEMENT DeliveryZone (ci-dessus,
 * import), jamais un type parallèle. Corrige L2B2-01 (contre-audit
 * Work) : PublicDeliveryZone/PublicDeliveryStatus, introduits dans le
 * tour précédent, sont supprimés -- ils dupliquaient un concept
 * métier identique (le résultat d'une recherche de zone de livraison)
 * sans raison de coexister. DeliveryZone.label a été élargi à
 * `string | null` (voir restaurants-config.ts) précisément pour
 * pouvoir servir aux DEUX résolveurs.
 */

/**
 * Détermine si la livraison est proposée, à partir des informations
 * publiques déjà résolues par LOT 2B.1
 * (get_restaurant_public_delivery_info, via lib/sale-modes-public.ts)
 * et du code postal/montant du panier saisis par le client.
 *
 * Fonction PURE, SYNCHRONE, SANS accès Supabase, sans logique
 * spécifique à un établissement précis -- reçoit uniquement des
 * données déjà résolues par l'appelant (jamais un appel réseau
 * interne). Le SEUL import lié à restaurants-config.ts qu'elle
 * partage avec getDeliveryStatus est le type DeliveryZone/DeliveryStatus
 * eux-mêmes (un import de TYPE uniquement, jamais RestaurantSettings
 * ni aucune donnée de configuration établissement) -- nécessaire pour
 * unifier le modèle de résultat des deux résolveurs, comme exigé.
 *
 * areaLabel = null : jamais de texte inventé en repli ("Unknown",
 * "Zone", etc.) -- transmis tel quel dans zone.label, dont le type
 * autorise désormais explicitement `null`.
 *
 * LEGACY CALL PATH STILL ACTIVE -- MIGRATION PREPARED, NOT SWITCHED :
 * cette fonction est prête à être appelée dès que MenuView.tsx sera
 * migré (sous-lot séparé) pour fournir un PublicDeliveryInfo déjà
 * récupéré de façon asynchrone, au lieu de RestaurantSettings.
 * getDeliveryStatus() ci-dessus reste le chemin RÉELLEMENT actif en
 * runtime tant que cette bascule n'a pas eu lieu.
 */
export function getDeliveryStatusFromPublicInfo(
  deliveryInfo: PublicDeliveryInfo | null,
  postalCode: string,
  totalCount: number
): DeliveryStatus {
  const code = postalCode.trim();
  if (!isValidPostalCode(code)) return { eligible: false, block: "no-postal" };

  // info = null : livraison non disponible pour cet établissement
  // (mode delivery non activé/configuré, ou établissement non actif)
  // -- traité comme "hors zone", cohérent avec le contrat existant
  // (aucune zone ne peut jamais correspondre).
  if (!deliveryInfo) return { eligible: false, block: "out-of-zone" };

  // zonePrefixes = [] : aucune zone desservie, même traitement.
  const matchedPrefix = deliveryInfo.zonePrefixes.find((prefix) => code.startsWith(prefix));
  if (!matchedPrefix) return { eligible: false, block: "out-of-zone" };

  const zone: DeliveryZone = { code: matchedPrefix, label: deliveryInfo.areaLabel };

  // minItems = 0 : aucun minimum, toute quantité positive est éligible.
  const min = deliveryInfo.minItems ?? 0;
  if (totalCount < min) {
    return { eligible: false, block: "below-min", missing: min - totalCount, zone };
  }

  return { eligible: true, zone };
}

/**
 * FULFILLMENT ROUTING LOT B — résolution fulfillment PURE, additive,
 * sans modifier getDeliveryStatus/getDeliveryStatusFromPublicInfo
 * ci-dessus (aucune des deux n'est touchée par cette fonction).
 *
 * CORRIGÉ EN LOT B.1 (audit Work, finding FRB-B-01/HIGH) : cette
 * fonction utilisait auparavant `isValidPostalCode` (lib/customer.ts)
 * pour décider de la validité du code postal — un contrôle de FORMAT
 * France-specific (`/^\d{5}$/`), hérité des résolveurs LEGACY
 * getDeliveryStatus/getDeliveryStatusFromPublicInfo (LOT 2B.2, UI
 * customer-facing, INCHANGÉS, toujours basés dessus). Le résolveur
 * SQL interne (resolve_delivery_fulfillment), lui, ne pouvait
 * appliquer qu'un contrôle générique (trim + vide) — un moteur SQL
 * générique n'a aucune raison de connaître le format postal français.
 * Plutôt que d'ajouter une dépendance France-specific supplémentaire
 * côté SQL (hors sujet pour un moteur multi-format), LOT B.1 aligne
 * CETTE fonction sur le contrat GÉNÉRIQUE déjà implémentable des deux
 * côtés : trim uniquement, aucune validation de format. `"abc"` n'est
 * donc plus un code postal "invalide" ici (il ne matche simplement
 * aucun préfixe) — seul un code vide après trim (ou absent) déclenche
 * `block="no-postal"`. Voir
 * tests/fixtures/fulfillment-routing-cases.json, cas
 * postal-nonstandard-format-*, pour la preuve croisée SQL/frontend de
 * ce choix. `isValidPostalCode` reste utilisée EXACTEMENT comme avant
 * par getDeliveryStatus/getDeliveryStatusFromPublicInfo ci-dessus —
 * ce changement ne les affecte en rien.
 *
 * Réplique l'algorithme du résolveur interne serveur
 * (resolve_delivery_fulfillment, voir le fichier DRAFT SQL Lot B
 * "DRAFT-lot-fulfillment-routing-lot-b-rpc.sql", §4/§9 du rapport de
 * conception, section 1 pour le contrat de résolution complet
 * corrigé) : même ordre de priorité, mêmes règles de correspondance,
 * prouvé identique cas par cas (pas seulement "testé contre des
 * scénarios similaires") via
 * tests/fixtures/fulfillment-routing-cases.json, consommé par
 * tests/v97-fulfillment-routing-lot-b1-determinism.test.ts côté
 * TypeScript ET par le harnais SQL Lot B côté serveur (FRB-B-02).
 *
 *   1. NORMALISATION : trim() uniquement, AUCUNE validation de
 *      format. Code postal vide après trim (ou absent) -- refusé
 *      IMMÉDIATEMENT, block="no-postal", AVANT toute autre
 *      vérification -- AUCUNE règle n'est retenue, pas même le
 *      fallback (contrairement à un ancien comportement du résolveur
 *      SQL, corrigé en LOT B.1 : voir DRAFT-lot-fulfillment-routing-
 *      lot-b-rpc.sql).
 *   2. Parmi les règles NON-fallback, triées par displayOrder
 *      ASCENDANT : la première dont au moins un préfixe de
 *      zonePrefixes (dans l'ordre du TABLEAU, jamais réordonné) est
 *      un préfixe du code postal (`code.startsWith(prefix)`, même
 *      patron déjà utilisé par getDeliveryStatusFromPublicInfo) est
 *      retenue -- premier match dans l'ordre configuré, jamais le
 *      "plus spécifique". `matchedPrefix` (LOT B.1, FRB-B-02) porte
 *      le préfixe précis retenu, pour comparaison directe avec la
 *      colonne `matched_prefix` du résolveur SQL.
 *   3. Sinon, la règle fallback (isFallback=true) si elle existe --
 *      au plus une par construction (garantie côté base, jamais
 *      revérifiée ici). `matchedPrefix` reste `undefined` -- un
 *      fallback n'exige aucun préfixe.
 *   4. Sinon : aucune règle retenue, eligible=false,
 *      block="out-of-zone" -- jamais une règle inventée.
 *   5. Une fois une règle retenue (fallback ou non), son minItems (ou
 *      0 si NULL -- "aucun minimum déclaré") est comparé à
 *      totalCount ; en dessous, eligible=false, block="below-min",
 *      missing=le nombre exact manquant, MAIS matchedRule/
 *      matchedPrefix/fulfillmentCode/customerText restent renseignés
 *      (contrairement à DeliveryStatus, qui n'expose que `zone` dans
 *      ce cas) -- permet à un futur appelant d'afficher malgré tout
 *      le texte de la règle presque éligible, sans deviner quelle
 *      règle a été évaluée.
 *
 * `rules` n'est jamais muté (copie triée localement) -- l'appelant
 * garde la liste reçue de get_restaurant_public_delivery_fulfillments
 * dans son ordre d'origine si besoin ailleurs.
 *
 * AUCUN accès Supabase, AUCUN appel RPC, jamais asynchrone -- même
 * discipline que getDeliveryStatusFromPublicInfo. NON BRANCHÉE dans
 * MenuView.tsx ni aucun composant (LOT C, hors périmètre de ce lot) --
 * prouvé par test.
 */
export function resolveDeliveryFulfillment(
  rules: PublicDeliveryFulfillmentRule[],
  postalCode: string | null | undefined,
  totalCount: number
): DeliveryFulfillmentStatus {
  // Normalisation générique LOT B.1 : trim uniquement, jamais de
  // contrôle de format -- voir le commentaire ci-dessus (FRB-B-01).
  // Volontairement DÉCOUPLÉE de isValidPostalCode (France-specific,
  // 5 chiffres) utilisée par getDeliveryStatus/
  // getDeliveryStatusFromPublicInfo ci-dessus, qui reste inchangée.
  //
  // CORRIGÉ EN LOT B.2 (audit Work, FRB-B-01 restant/HIGH) : le
  // paramètre était typé `string` alors qu'un `null`/`undefined`
  // RÉEL peut légitimement l'atteindre au runtime (donnée non encore
  // saisie par le client, valeur JSON, etc. -- le typage TypeScript ne
  // protège personne contre ça, seulement contre une erreur de
  // COMPILATION) : `postalCode.trim()` faisait alors planter la
  // fonction (`TypeError: Cannot read properties of null/undefined
  // (reading 'trim')`), au lieu de retourner la même décision
  // `no-postal` que pour une chaîne vide -- reproduit et vérifié
  // AVANT correction (voir le rapport de mission Lot B.2). Le
  // résolveur SQL (resolve_delivery_fulfillment), lui, a toujours
  // traité un p_postal_code SQL NULL correctement (c'était déjà
  // vérifié en Lot B.1) -- seul le frontend divergeait, par un crash
  // plutôt qu'une simple décision différente, ce qui est d'autant
  // plus grave : un crash empêche même de RENDRE la décision
  // "no-postal" à l'appelant.
  //
  // `?? ""` traite `null` et `undefined` exactement comme une chaîne
  // vide (même branche `code === ""` ci-dessous, aucune décision
  // dupliquée) -- jamais une exception, jamais un contrôle de format
  // supplémentaire, conforme au contrat générique déjà en vigueur.
  const code = postalCode?.trim() ?? "";
  if (code === "") return { eligible: false, block: "no-postal" };

  const sorted = [...rules].sort((a, b) => a.displayOrder - b.displayOrder);

  let matchedRule: PublicDeliveryFulfillmentRule | undefined;
  let matchedPrefix: string | undefined;

  for (const candidate of sorted) {
    if (candidate.isFallback) continue;
    const prefix = candidate.zonePrefixes.find((p) => code.startsWith(p));
    if (prefix !== undefined) {
      matchedRule = candidate;
      matchedPrefix = prefix;
      break;
    }
  }
  if (!matchedRule) {
    matchedRule = sorted.find((candidate) => candidate.isFallback);
    matchedPrefix = undefined;
  }

  if (!matchedRule) return { eligible: false, block: "out-of-zone" };

  const min = matchedRule.minItems ?? 0;
  if (totalCount < min) {
    return {
      eligible: false,
      block: "below-min",
      missing: min - totalCount,
      matchedRule,
      matchedPrefix,
      fulfillmentCode: matchedRule.fulfillmentCode,
      customerText: matchedRule.customerText,
    };
  }

  return {
    eligible: true,
    matchedRule,
    matchedPrefix,
    fulfillmentCode: matchedRule.fulfillmentCode,
    customerText: matchedRule.customerText,
  };
}
