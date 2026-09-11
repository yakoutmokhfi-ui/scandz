import "server-only";
import {
  getDeliveryProviderCredential,
  getDeliveryProviderConfigStatus,
} from "@/lib/server/delivery-provider-service";
import { DeliveryProviderServerRpcError } from "@/lib/server/delivery-provider-errors";
import { StuartMerchantCredentialMissingError } from "@/lib/server/delivery-provider-errors";
import {
  parseStuartMerchantCredential,
  StuartCredentialError,
  type StuartMerchantCredentialPayload,
} from "@/lib/server/delivery-providers/stuart/credentials";

/**
 * LOT A-0 — MERCHANT STUART CREDENTIAL FOUNDATION v1.
 * ÉDITÉ PAR STUART LOT A (QUOTE / VALIDATE / ETA / SCHEDULING
 * FOUNDATION v1) — fermeture du A-0 LOW finding, voir ci-dessous.
 *
 * RUNTIME RULE (mandat, non-négociable) : tout chemin Stuart réel pour
 * un marchand doit résoudre son credential par contexte restaurant
 * AUTORITATIF, jamais un `restaurant_id` fourni par le client sans
 * vérification côté serveur (voir Discovery v1 §8 : `create_order`
 * résout déjà `restaurant_id` server-side à partir d'un slug, jamais
 * fait confiance à une valeur brute du client — le même appelant doit
 * réutiliser CE `restaurant_id` déjà authentifié, pas en accepter un
 * second depuis une entrée non fiable).
 *
 * FERMETURE DU A-0 LOW FINDING (mandat STUART LOT A, "FIRST — CLOSE
 * A-0 LOW FINDING") : `delivery_provider_configs.mode` est désormais
 * l'UNIQUE source de vérité du mode d'un marchand — le payload
 * credential ne peut PLUS jamais en porter un (voir credentials.ts,
 * `ALLOWED_KEYS` ne contient plus `mode` — toute tentative est rejetée
 * de façon déterministe). Cette fonction résout donc désormais en DEUX
 * étapes distinctes et SÉQUENTIELLES :
 *   1. `getDeliveryProviderConfigStatus()` (STUART LOT A, ADDITIF,
 *      lecture SEULE de métadonnées — mode, configuration_status —
 *      JAMAIS le secret) → vérifie que le mode est une valeur valide
 *      ET que la configuration est dans un état exploitable ;
 *   2. `getDeliveryProviderCredential()` (LOT A-0, INCHANGÉE) → lit le
 *      secret déchiffré.
 * AUCUNE des deux étapes ne peut jamais faire diverger le mode utilisé
 * pour authentifier le marchand : le mode retourné provient
 * EXCLUSIVEMENT de l'étape 1 (colonne SQL), jamais du payload analysé
 * à l'étape 2.
 *
 * PREUVE STRUCTURELLE D'ABSENCE DE REPLI GLOBAL SANDBOX (mandat
 * "Explicit proof of no global-Sandbox fallback for merchant runtime") :
 * ce fichier ne référence NULLE PART `process.env`, ni directement ni
 * via un import de `lib/server/delivery-providers/stuart/auth.ts` ou
 * `environment.ts` (les deux seuls modules du dépôt qui lisent
 * `STUART_CLIENT_ID`/`STUART_CLIENT_SECRET`/`STUART_ENV`) — vérifiable
 * par lecture directe des imports ci-dessus, et couvert par un test
 * structurel dédié (voir `tests/v154-stuart-merchant-credential-
 * foundation.test.ts`, scénario "no STUART_CLIENT_ID/STUART_ENV
 * reference"). Si `getStuartCredentialForRestaurant` ne trouve aucune
 * configuration marchande, elle lève `StuartMerchantCredentialMissingError`
 * — elle ne retourne JAMAIS de valeur par défaut, ni ne délègue à un
 * quelconque autre module qui pourrait, lui, lire les variables
 * globales.
 */

export interface ResolvedStuartMerchantCredential extends StuartMerchantCredentialPayload {
  restaurantId: string;
  /** AUTORITATIF, lu EXCLUSIVEMENT depuis
   *  `delivery_provider_configs.mode` (étape 1) — jamais depuis le
   *  payload credential (STUART LOT A, fermeture du A-0 LOW finding). */
  mode: "sandbox" | "production";
}

const STUART_PROVIDER_CODE = "stuart";

function isValidStuartMode(value: string): value is "sandbox" | "production" {
  return value === "sandbox" || value === "production";
}

/**
 * Résout le credential Stuart du restaurant fourni, pour un usage
 * runtime réel (marchand). Le `restaurantId` doit provenir d'un
 * contexte serveur déjà authentifié (jamais d'une valeur brute
 * client) — cette fonction elle-même ne réalise AUCUNE vérification
 * d'authentification/autorisation supplémentaire ; c'est la
 * responsabilité de l'appelant, exactement comme
 * `getPaymentProviderCredential` pour le domaine paiement.
 *
 * FAIL CLOSED : lève `StuartMerchantCredentialMissingError` si aucune
 * configuration n'existe, si son mode n'est pas une valeur valide, ou
 * si aucun credential n'est configuré (ou si la configuration existe
 * mais n'est pas encore dans un état lisible — `not_configured`), ou
 * `StuartCredentialError` si le payload stocké est corrompu/invalide
 * (y compris s'il porte encore un champ `mode` — désormais rejeté).
 * Ne retombe JAMAIS sur un credential Scanym global de diagnostic
 * Sandbox — voir le commentaire de fichier ci-dessus pour la preuve
 * structurelle.
 */
export async function getStuartCredentialForRestaurant(
  restaurantId: string
): Promise<ResolvedStuartMerchantCredential> {
  if (typeof restaurantId !== "string" || restaurantId.length === 0) {
    throw new StuartMerchantCredentialMissingError();
  }

  // Étape 1 — mode AUTORITATIF (métadonnées seules, jamais le secret).
  let mode: string;
  try {
    const status = await getDeliveryProviderConfigStatus({
      restaurantId,
      providerCode: STUART_PROVIDER_CODE,
    });
    mode = status.mode;
  } catch (err) {
    // P0002 (configuration introuvable) — même traduction déterministe
    // que l'étape 2 ci-dessous : du point de vue d'un appelant
    // runtime, "pas de ligne de config" et "pas de credential lisible"
    // signifient identiquement "ce marchand n'a pas encore de Stuart
    // utilisable".
    if (err instanceof DeliveryProviderServerRpcError && err.sqlstate === "P0002") {
      throw new StuartMerchantCredentialMissingError();
    }
    throw err;
  }

  if (!isValidStuartMode(mode)) {
    // Défense en profondeur -- la contrainte CHECK SQL sur
    // delivery_provider_configs.mode devrait déjà rendre ce cas
    // impossible, mais un appelant runtime ne doit JAMAIS authentifier
    // un marchand contre un environnement ambigu.
    throw new StuartMerchantCredentialMissingError();
  }

  // Étape 2 — secret déchiffré (LOT A-0, inchangée).
  let raw: string;
  try {
    raw = await getDeliveryProviderCredential({
      restaurantId,
      providerCode: STUART_PROVIDER_CODE,
    });
  } catch (err) {
    // P0002 (configuration introuvable) et 42501 (état non éligible —
    // ex. not_configured) sont TOUS DEUX traduits en la même erreur
    // déterministe "credential marchand manquant" : du point de vue
    // d'un appelant runtime, l'un et l'autre signifient identiquement
    // "ce marchand n'a pas encore de Stuart utilisable", jamais une
    // panne d'infrastructure à réessayer aveuglément.
    if (
      err instanceof DeliveryProviderServerRpcError &&
      (err.sqlstate === "P0002" || err.sqlstate === "42501")
    ) {
      throw new StuartMerchantCredentialMissingError();
    }
    // Toute autre erreur (panne infrastructure, RPC inattendue) est
    // propagée TELLE QUELLE — ne JAMAIS la masquer derrière
    // StuartMerchantCredentialMissingError, qui doit rester réservée
    // au cas "pas encore configuré", jamais à "infrastructure en
    // panne" (deux causes racines distinctes, deux réponses
    // opérationnelles distinctes).
    throw err;
  }

  let payload: StuartMerchantCredentialPayload;
  try {
    payload = parseStuartMerchantCredential(raw);
  } catch (err) {
    if (err instanceof StuartCredentialError) {
      throw err;
    }
    throw new StuartCredentialError("STUART_CREDENTIAL_INVALID_SHAPE");
  }

  return {
    restaurantId,
    mode,
    ...payload,
  };
}
