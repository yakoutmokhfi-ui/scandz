import { useEffect, useState } from "react";
import { getPublicFieldRequirements } from "@/lib/sale-modes-public";
import type { SaleModeFieldRequirement } from "@/lib/sale-modes-types";

/**
 * LOT 2B.4a.1 — fondations génériques des customer requirements.
 *
 * Réutilise EXCLUSIVEMENT getPublicFieldRequirements()
 * (lib/sale-modes-public.ts, LOT 2B.1) : aucun appel Supabase direct
 * ici, aucune nouvelle RPC. Même patron que usePublicDeliveryInfo
 * (lib/use-public-delivery-info.ts, LOT 2B.3) : états explicites,
 * jamais un simple booléen ; protection changement
 * restaurant/mode (dépendances d'effet) + unmount/race (flag
 * `cancelled`, identique au hook LOT 2B.3).
 *
 * GENERIC CUSTOMER REQUIREMENTS FOUNDATION READY — ACTIVE FORM STILL
 * LEGACY : ce hook n'est consommé par AUCUN composant du parcours
 * public actif dans ce lot. Le formulaire (FulfillmentSelector.tsx
 * via MenuView.tsx) continue de lire exclusivement
 * settings.requiredCustomerFields (lib/restaurants-config.ts), sans
 * aucun changement de comportement. La bascule réelle du formulaire
 * est le périmètre de LOT 2B.4a.2, explicitement hors de celui-ci.
 *
 * Contrat fail-closed préparé ici (section 11 de la mission),
 * PAS ENCORE appliqué à un formulaire actif :
 *   - "loading" et "error" NE SONT JAMAIS des réponses métier valides
 *     -- un futur formulaire consommateur doit bloquer la soumission
 *     tant que l'un de ces deux états est courant ;
 *   - "loaded" avec un tableau VIDE (aucune exigence pour ce mode)
 *     EST une réponse métier valide et autorise la soumission ;
 *   - loading ≠ loaded([]) et error ≠ loaded([]) -- jamais confondus,
 *     ni par le type (états distincts), ni par le helper ci-dessous.
 * Voir canAttemptSubmit(), exportée pour réutilisation directe par
 * LOT 2B.4a.2 -- aucune seconde implémentation de ce contrat à
 * écrire ailleurs.
 *
 * delivery_address (voir aussi le commentaire dédié dans
 * lib/sale-modes-types.ts) : ce hook retourne le champ
 * "delivery_address" tel quel, comme n'importe quel autre champ de
 * SaleModeFieldRequirement -- aucun traitement spécial ici. La
 * décomposition en 3 sous-champs UI (street/postalCode/city) est un
 * problème de RENDU, réservé à LOT 2B.4a.2, jamais résolu dans ce
 * hook ni dans lib/sale-modes-public.ts.
 *
 * Corrige L2B4A1-01 (audit Work, HIGH, LOT 2B.4a.1 v2) : l'ancienne
 * version remettait l'état à "loading" UNIQUEMENT depuis
 * useEffect -- au premier rendu suivant un changement de
 * restaurantId/modeCode, avant que cet effet n'ait eu l'occasion de
 * s'exécuter, le hook exposait encore l'ancien état "loaded" (données
 * de l'ANCIEN restaurant/mode) sous la NOUVELLE clé. canAttemptSubmit()
 * aurait alors pu momentanément retourner `true` pour la mauvaise
 * clé -- contrat fail-closed rompu.
 *
 * Correction : comparaison de la clé {restaurantId, modeCode} PENDANT
 * le rendu (patron React documenté "adjusting state during
 * rendering", jamais un useEffect) -- si l'état mémorisé appartient
 * encore à l'ancienne clé, il est réinitialisé ICI, avant que ce
 * rendu ne soit commité. React relance alors immédiatement le rendu
 * du composant avec l'état réinitialisé, sans jamais peindre l'ancien
 * "loaded" sous la nouvelle clé, même un seul frame -- ne repose ni
 * sur useEffect, ni sur un setState différé, ni sur un flush, ni sur
 * un timing React quelconque. Reproduit et confirmé absent de cette
 * garantie sur l'implémentation précédente via un test dédié (voir
 * tests/v90-lot2b4a1-l2b4a1-01-fail-closed-key-change.dom.test.ts).
 */
export type PublicFieldRequirementsState =
  | { status: "loading" }
  | { status: "loaded"; data: SaleModeFieldRequirement[] }
  | { status: "error" };

/** Clé non ambiguë identifiant une requête {restaurantId, modeCode} --
 *  séparateur U+0000 (jamais présent dans un UUID ni un code de mode
 *  réel), élimine toute collision entre ("ab", "c") et ("a", "bc")
 *  qu'une simple concaténation ou un séparateur imprimable pourrait
 *  produire. */
function requestKey(restaurantId: string, modeCode: string): string {
  return `${restaurantId}\u0000${modeCode}`;
}

export function usePublicFieldRequirements(
  restaurantId: string,
  modeCode: string
): {
  state: PublicFieldRequirementsState;
  data: SaleModeFieldRequirement[] | null;
} {
  const key = requestKey(restaurantId, modeCode);
  const [state, setState] = useState<PublicFieldRequirementsState>({ status: "loading" });
  const [stateKey, setStateKey] = useState(key);

  // Réinitialisation SYNCHRONE pendant le rendu, jamais dans un effet
  // -- voir le commentaire "Corrige L2B4A1-01" ci-dessus. Distincte de
  // la protection unmount/race (`cancelled`, ci-dessous) : ceci
  // protège contre l'exposition de l'ANCIEN état résolu sous la
  // NOUVELLE clé ; `cancelled` protège contre une réponse asynchrone
  // OBSOLÈTE qui s'appliquerait à tort après un changement de clé ou
  // un démontage -- les deux mécanismes sont nécessaires, ni l'un ni
  // l'autre ne remplace l'autre.
  if (stateKey !== key) {
    setStateKey(key);
    setState({ status: "loading" });
  }

  useEffect(() => {
    let cancelled = false;
    getPublicFieldRequirements(restaurantId, modeCode)
      .then((data) => {
        if (!cancelled) setState({ status: "loaded", data });
      })
      .catch(() => {
        // Aucun détail technique exposé au client, aucun crash --
        // comportement sûr : traité comme "exigences indisponibles",
        // jamais un fallback vers restaurants-config.ts/
        // settings.requiredCustomerFields (legacy) ni une exigence
        // faussement résolue.
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [restaurantId, modeCode]);

  const data = state.status === "loaded" ? state.data : null;
  return { state, data };
}

/**
 * Contrat fail-closed explicite (section 11 de la mission) : la
 * soumission ne doit être tentée que lorsque les exigences sont
 * RÉELLEMENT résolues (état "loaded", y compris loaded([])) --
 * jamais pendant "loading" ni après "error". Pure, sans effet de
 * bord, testable indépendamment du hook. Pas encore appelée par le
 * formulaire actif dans ce lot -- réservée à la consommation par
 * LOT 2B.4a.2.
 */
export function canAttemptSubmit(state: PublicFieldRequirementsState): boolean {
  return state.status === "loaded";
}
