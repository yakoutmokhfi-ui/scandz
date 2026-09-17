import type { MerchantRestaurant } from "@/lib/dashboard-types";

/**
 * URL du menu public de l'établissement courant, dérivée de
 * `mappings` — jamais codée en dur. `null` tant que l'établissement
 * courant n'a pas de slug exploitable (mapping absent, `restaurants`
 * null, slug vide/blanc) : appelant responsable de ne rien afficher
 * dans ce cas plutôt que de générer `/r/undefined` ou `/r/null`.
 *
 * Le slug normalisé (bordures nettoyées) est encodé via
 * `encodeURIComponent()` avant insertion dans l'URL : défense en
 * profondeur, les slugs actuels (illico-presto, sanaa-cookies)
 * n'exigent rien de plus, mais rien ne garantit qu'un futur slug
 * reste toujours strictement alphanumérique-tiret.
 */
export function publicMenuHref(
  restaurantId: string,
  mappings: MerchantRestaurant[]
): string | null {
  const slug = mappings.find(
    (m) => m.restaurant_id === restaurantId
  )?.restaurants?.slug;
  if (typeof slug !== "string") return null;
  const normalizedSlug = slug.trim();
  if (!normalizedSlug) return null;
  return `/r/${encodeURIComponent(normalizedSlug)}`;
}

/**
 * DASHBOARD RESTAURANT CONTEXT NAVIGATION v1 -- résolution de
 * l'établissement sélectionné à l'ouverture d'une page du tableau de
 * bord commerçant.
 *
 * Défaut corrigé : `setRestaurantId((match ?? mappings[0]).restaurant_id)`
 * bascule SILENCIEUSEMENT sur le premier rattachement quand l'URL
 * demande explicitement un établissement introuvable dans les
 * rattachements du compte. Reproduit : un opérateur Scanym consultant
 * "Au lait cru" (hors de ses propres rattachements) depuis Réglages
 * arrivait sur "Sanaa Cookies & Fondant" en cliquant "Commandes" --
 * `?r=` était pourtant bien transmis par la navigation.
 *
 * Fonction PURE, sans accès réseau ni DOM : la décision est isolée du
 * cycle de vie React pour être testable directement et partagée par
 * les pages, plutôt que redupliquée page par page.
 *
 * Règles (mandat §4) :
 *   A. `?r=` présent ET rattaché au compte  -> cet établissement, exactement ;
 *      `?r=` présent, NON rattaché, mais compte opérateur Scanym
 *      -> cet établissement (contexte opérateur légitime, déjà en
 *      place sur les autres pages ; l'autorisation RÉELLE reste
 *      côté serveur -- RLS `is_member_of` et
 *      `assert_receipt_settings_read_access`/`is_scanym_operator`) ;
 *   B. `?r=` présent, NON rattaché, compte NON opérateur
 *      -> `unavailable` : état de contexte indisponible explicite,
 *      JAMAIS un autre établissement ;
 *   C. aucun `?r=` -> premier rattachement (`default`). C'est le seul
 *      repli autorisé, et il est INTENTIONNEL : sans contexte demandé,
 *      aucun contexte n'est trahi. `mappings` est trié par
 *      `created_at` croissant (getMerchantRestaurants), donc ce choix
 *      est stable et ne dépend pas de l'ordre de réponse.
 *
 * CONTEXT HARDENING v1.1 -- cette fonction reste INCHANGÉE par la
 * remédiation v1.1 : l'audit indépendant a confirmé que le résolveur
 * SYNCHRONE était correct (« the synchronous resolver was correct »).
 * Le blocage CTXHARD-V1-STALE-RESPONSE-01 portait exclusivement sur le
 * chemin ASYNCHRONE, traité par lib/restaurant-context-guard.ts. En
 * particulier, le comportement « fail closed » (règle B) et le fait
 * que l'URL seule n'accorde AUCUN privilège opérateur (`isOperator`
 * vient de `isScanymOperator()`, jamais de `?r=`) sont préservés tels
 * quels (mandat §10 et §11).
 */
export type RestaurantContextResolution =
  | { kind: "selected"; restaurantId: string; source: "explicit" | "operator" | "default" }
  | { kind: "unavailable"; requestedId: string }
  | { kind: "none" };

export function resolveRestaurantContext(params: {
  /** Valeur brute de `?r=` (souvent `URLSearchParams.get("r")`). */
  requestedId: string | null | undefined;
  mappings: MerchantRestaurant[];
  /** Résultat de `isScanymOperator()` pour le compte connecté. */
  isOperator: boolean;
}): RestaurantContextResolution {
  const { mappings, isOperator } = params;
  // `?r=` vide ou blanc = aucun contexte demandé (jamais un
  // établissement "introuvable" qui ferait échouer la page).
  const requestedId = (params.requestedId ?? "").trim();

  if (requestedId) {
    const match = mappings.find((m) => m.restaurant_id === requestedId);
    if (match) {
      return { kind: "selected", restaurantId: match.restaurant_id, source: "explicit" };
    }
    if (isOperator) {
      return { kind: "selected", restaurantId: requestedId, source: "operator" };
    }
    // Règle B -- fail closed. Le repli sur mappings[0] serait ici une
    // bascule silencieuse d'établissement : exactement le défaut.
    return { kind: "unavailable", requestedId };
  }

  if (mappings.length === 0) return { kind: "none" };
  return { kind: "selected", restaurantId: mappings[0].restaurant_id, source: "default" };
}

/**
 * DASHBOARD RESTAURANT CONTEXT HARDENING v1 (§17) -- représentation
 * honnête de l'établissement courant dans la barre de navigation.
 *
 * Le sélecteur ne listait que les rattachements du compte. En contexte
 * OPÉRATEUR, l'établissement réellement consulté n'en fait pas partie :
 * aucune option ne correspondait, et le navigateur retombait sur la
 * PREMIÈRE option -- le sélecteur annonçait donc "Sanaa" alors que la
 * page travaillait sur "Au lait cru". C'est un mensonge d'interface.
 *
 * Décision de conception (une des options explicitement permises par le
 * mandat) : dans ce cas, NE PAS afficher de sélecteur multi-choix, mais
 * une représentation NON SÉLECTIONNABLE du contexte courant.
 *
 * Pourquoi pas simplement ajouter l'établissement consulté à la liste :
 * cela ferait apparaître, dans une vue opérateur ciblée sur
 * l'établissement X, les noms des PROPRES rattachements de l'opérateur
 * (ex. "Sanaa Cookies") -- des établissements sans rapport avec la
 * page consultée. Vérifié : cette variante a fait échouer les garanties
 * existantes de v149 ("le rendu ciblé sur Au lait cru ne doit jamais
 * contenir Sanaa Cookies"). La représentation en lecture seule est donc
 * à la fois plus honnête ET moins intrusive.
 */
export type RestaurantSelectorModel =
  | { mode: "select"; options: { restaurantId: string; label: string }[] }
  | { mode: "current-context"; restaurantId: string; label: string }
  | { mode: "hidden" };

export function buildRestaurantSelectorModel(params: {
  restaurantId: string;
  mappings: MerchantRestaurant[];
  /** Nom affiché de l'établissement courant (entête). */
  currentContextName?: string | null;
}): RestaurantSelectorModel {
  const { restaurantId, mappings, currentContextName } = params;

  // Contexte hors rattachements (opérateur) : lecture seule, jamais un
  // sélecteur qui désignerait un AUTRE établissement.
  if (restaurantId && !mappings.some((m) => m.restaurant_id === restaurantId)) {
    return {
      mode: "current-context",
      restaurantId,
      label: currentContextName ?? restaurantId,
    };
  }

  // Comportement historique strictement préservé : le sélecteur
  // n'apparaît qu'à partir de deux rattachements.
  if (mappings.length > 1) {
    return {
      mode: "select",
      options: mappings.map((m) => ({
        restaurantId: m.restaurant_id,
        label: m.restaurants?.name ?? m.restaurant_id,
      })),
    };
  }
  return { mode: "hidden" };
}
