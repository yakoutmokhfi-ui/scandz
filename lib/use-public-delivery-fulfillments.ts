import { useEffect, useState } from "react";
import { getPublicDeliveryFulfillments } from "@/lib/sale-modes-public";
import type { FulfillmentRulesResolution } from "@/lib/delivery";
import type { PublicDeliveryFulfillmentRule } from "@/lib/sale-modes-types";

/**
 * FULFILLMENT ROUTING LOT C — hook d'activation runtime des règles
 * publiques de fulfillment (get_restaurant_public_delivery_fulfillments,
 * LOT 2B.1/LOT B), jusqu'ici préparées mais jamais consommées par
 * aucun hook (voir lib/sale-modes-public.ts et
 * tests/v96-fulfillment-routing-lot-b.test.ts, dont un test est mis à
 * jour par ce lot précisément pour documenter cette activation).
 *
 * Réutilise EXCLUSIVEMENT getPublicDeliveryFulfillments()
 * (lib/sale-modes-public.ts) : aucun appel Supabase direct ici, aucune
 * nouvelle RPC.
 *
 * `FulfillmentRulesResolution` (le type d'état lui-même) est importé
 * depuis lib/delivery.ts, PAS redéfini ici : lib/delivery.ts reste le
 * fichier pur/synchrone (aucune dépendance React) qui modélise ce
 * concept, pour que resolveActiveDeliveryStatus (le pont de
 * migration, lib/delivery.ts) puisse le consommer sans jamais importer
 * de hook -- une seule source de vérité pour cette forme d'état,
 * jamais deux modélisations parallèles.
 *
 * Race-safety : reprend EXACTEMENT le double mécanisme déjà établi et
 * corrigé par LOT 2B.4a.1/L2B4A1-01
 * (lib/use-public-field-requirements.ts) plutôt que le mécanisme plus
 * simple de LOT 2B.3 (lib/use-public-delivery-info.ts, `cancelled`
 * seul) -- demandé explicitement par la mission (§5 : "Reuse the
 * race-safety lessons from Lot 2B.4a.1... On restaurant ID change: do
 * not expose previous tenant rules while new rules are loading") :
 *   1. réinitialisation SYNCHRONE pendant le rendu (jamais dans un
 *      effet) dès que `restaurantId` change par rapport à la clé
 *      mémorisée -- empêche d'exposer, ne serait-ce qu'un seul rendu,
 *      les règles de l'ANCIEN restaurant sous le NOUVEL identifiant ;
 *   2. flag `cancelled` dans l'effet -- empêche qu'une réponse
 *      asynchrone OBSOLÈTE (restaurant déjà changé, ou composant
 *      démonté) ne s'applique après coup. Les deux mécanismes sont
 *      nécessaires, aucun des deux ne remplace l'autre (même
 *      justification que le commentaire dédié de
 *      lib/use-public-field-requirements.ts).
 *
 * Ici, une seule dimension de clé (`restaurantId`, contrairement aux
 * deux dimensions {restaurantId, modeCode} de
 * usePublicFieldRequirements) : get_restaurant_public_delivery_fulfillments
 * ne prend qu'un `p_restaurant_id`, jamais de mode -- la RPC est déjà
 * implicitement scopée au mode delivery côté base (LOT A/B).
 *
 * Contrat fail-closed (mission §6/§7) : "loading" et "error" ne sont
 * JAMAIS des réponses métier valides -- resolveActiveDeliveryStatus
 * (lib/delivery.ts) les traite tous deux comme un état sûr non
 * éligible, jamais comme "zéro règle" (legacy) ni comme une
 * éligibilité positive. "loaded" avec un tableau VIDE EST une réponse
 * métier valide (c'est le cas de TOUS les établissements réels
 * aujourd'hui, Sanaa inclus) et déclenche le pont de migration vers le
 * chemin legacy -- jamais confondu avec "loading"/"error" par le type
 * lui-même (états distincts, voir FulfillmentRulesResolution).
 */
export function usePublicDeliveryFulfillments(restaurantId: string): {
  state: FulfillmentRulesResolution;
  data: PublicDeliveryFulfillmentRule[] | null;
} {
  const [state, setState] = useState<FulfillmentRulesResolution>({ status: "loading" });
  const [stateKey, setStateKey] = useState(restaurantId);

  // Réinitialisation SYNCHRONE pendant le rendu -- voir le commentaire
  // "Race-safety" ci-dessus (patron React documenté "adjusting state
  // during rendering", jamais un useEffect). Distincte de la
  // protection unmount/race (`cancelled`, ci-dessous).
  if (stateKey !== restaurantId) {
    setStateKey(restaurantId);
    setState({ status: "loading" });
  }

  useEffect(() => {
    let cancelled = false;
    getPublicDeliveryFulfillments(restaurantId)
      .then((rules) => {
        if (!cancelled) setState({ status: "loaded", rules });
      })
      .catch(() => {
        // Aucun détail technique exposé au client, aucun crash --
        // comportement sûr : jamais un repli vers le chemin legacy
        // (une erreur RPC N'EST PAS "zéro règle constaté", voir
        // resolveActiveDeliveryStatus/lib/delivery.ts), jamais une
        // éligibilité faussement positive.
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [restaurantId]);

  const data = state.status === "loaded" ? state.rules : null;
  return { state, data };
}
