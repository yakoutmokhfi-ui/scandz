import { useEffect, useState } from "react";
import { getPublicSaleModes } from "@/lib/sale-modes-public";
import type { SaleMode } from "@/lib/sale-modes-types";

/**
 * AU LAIT CRU — SALE MODES / FULFILLMENT PREPARATION — bascule
 * runtime vers la liste RÉELLE des modes de vente activés pour cet
 * établissement (get_restaurant_public_sale_modes, LOT 2B.1) via
 * getPublicSaleModes() (lib/sale-modes-public.ts) -- jamais un appel
 * Supabase direct dans le composant appelant.
 *
 * NEW PUBLIC SALE MODES RESOLVER ACTIVE IN RUNTIME.
 *
 * Avant le lot d'activation, `getPublicSaleModes()` existait déjà
 * (LOT 2B.1), entièrement testé, mais n'était consommé par AUCUN
 * composant -- exactement le même statut dormant que
 * `usePublicFieldRequirements` avant LOT 2B.4a.2 (voir
 * lib/use-public-field-requirements.ts). Le choix RÉEL des modes
 * proposés au client restait piloté par `settings.allowedServiceModes`
 * (lib/restaurants-config.ts, statique, codé en dur par établissement
 * connu) -- cause racine identifiée du problème Au Lait Cru : cet
 * établissement n'a aucune entrée dans cette table statique, retombe
 * donc sur DEFAULT_SETTINGS (`{ allowedServiceModes: ["table"] }`),
 * quelle que soit la configuration réelle en base.
 *
 * Corrige ALC-SM-01 (audit Work, HIGH, CASE 1) : la version précédente
 * ne réinitialisait l'état à "loading" que depuis `useEffect`, et
 * affirmait à tort (dans ce commentaire même) que la protection
 * "changement de clé pendant le rendu" -- déjà appliquée à
 * usePublicFieldRequirements pour corriger L2B4A1-01 -- n'était pas
 * nécessaire ici, au motif que `restaurantId` serait une prop fixe de
 * MenuView pour toute la durée de vie du composant. Ce raisonnement
 * est FAUX en tant que garantie du HOOK lui-même : rien dans la
 * signature de `usePublicSaleModes(restaurantId)` n'empêche un futur
 * appelant (ou une future évolution de MenuView -- navigation
 * client-side entre établissements sans démontage complet, aperçu
 * multi-tenant, etc.) de faire varier `restaurantId` sans démonter le
 * composant. Sans cette protection, au premier rendu suivant un tel
 * changement, AVANT que useEffect n'ait eu l'occasion de s'exécuter,
 * le hook continuait d'exposer l'ancien état "loaded" (modes de
 * l'ANCIEN restaurant) sous la NOUVELLE clé -- `canAttemptToSelectSaleMode`
 * pouvait alors momentanément retourner `true` pour le mauvais
 * restaurant, et `availableServiceModes` (MenuView.tsx) exposer des
 * modes qui n'ont plus cours pour le tenant réellement affiché.
 *
 * Correction : IDENTIQUE au patron déjà audité et en production de
 * usePublicFieldRequirements (corrige L2B4A1-01) -- comparaison de la
 * clé `restaurantId` PENDANT le rendu ("adjusting state during
 * rendering", jamais un useEffect) : si l'état mémorisé appartient
 * encore à l'ancien restaurantId, il est réinitialisé ICI, avant que
 * ce rendu ne soit commité. React relance alors immédiatement le
 * rendu avec l'état réinitialisé, sans jamais peindre l'ancien
 * "loaded" sous la nouvelle clé, même un seul frame -- ne repose ni
 * sur useEffect, ni sur un setState différé, ni sur un flush, ni sur
 * un timing React quelconque.
 *
 * Deux protections DISTINCTES, aucune ne remplace l'autre :
 *   - la comparaison de clé pendant le rendu (ci-dessous) empêche
 *     d'exposer l'ANCIEN état résolu sous la NOUVELLE clé ;
 *   - le flag `cancelled` (useEffect) empêche qu'une réponse
 *     asynchrone OBSOLÈTE (une requête pour un restaurantId qui n'est
 *     déjà plus celui affiché -- ex. A démarre, B démarre avant que A
 *     ne réponde, A répond enfin après) écrase l'état déjà résolu pour
 *     la clé courante. Chaque exécution de l'effet capture son propre
 *     `cancelled` local (fermeture par exécution) : le cleanup de
 *     l'effet pour A s'exécute AVANT le nouvel effet pour B (React
 *     nettoie l'effet précédent avant de relancer le suivant sur
 *     changement de dépendance), donc la réponse tardive de A trouve
 *     forcément `cancelled === true` et ne peut jamais écraser l'état
 *     déjà posé par/pour B.
 */
export type PublicSaleModesState =
  | { status: "loading" }
  | { status: "loaded"; data: SaleMode[] }
  | { status: "error" };

export function usePublicSaleModes(restaurantId: string): {
  state: PublicSaleModesState;
  data: SaleMode[] | null;
} {
  const [state, setState] = useState<PublicSaleModesState>({ status: "loading" });
  const [stateKey, setStateKey] = useState(restaurantId);

  // Réinitialisation SYNCHRONE pendant le rendu -- voir "Corrige
  // ALC-SM-01" ci-dessus. Doit s'exécuter AVANT tout calcul dérivé de
  // `state` plus bas dans ce même rendu (et, en amont, avant tout
  // calcul dérivé dans le composant appelant lors de CE rendu) --
  // jamais après un `await`/useEffect.
  if (stateKey !== restaurantId) {
    setStateKey(restaurantId);
    setState({ status: "loading" });
  }

  useEffect(() => {
    let cancelled = false;
    getPublicSaleModes(restaurantId)
      .then((data) => {
        if (!cancelled) setState({ status: "loaded", data });
      })
      .catch(() => {
        // Aucun détail technique exposé au client, aucun crash --
        // traité comme "aucun mode disponible" : jamais un repli vers
        // settings.allowedServiceModes (legacy), jamais un mode
        // faussement disponible.
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [restaurantId]);

  const data = state.status === "loaded" ? state.data : null;
  return { state, data };
}

/**
 * Contrat fail-closed (même principe que canAttemptSubmit(),
 * lib/use-public-field-requirements.ts) : la liste des modes proposés
 * ne doit être considérée comme définitive que lorsque l'état est
 * RÉELLEMENT résolu ("loaded") -- jamais pendant "loading" ni après
 * "error", pour ne jamais présenter une liste vide comme si elle
 * était la réponse réelle, ni retomber sur un mode par défaut
 * arbitraire.
 */
export function canAttemptToSelectSaleMode(state: PublicSaleModesState): boolean {
  return state.status === "loaded";
}
