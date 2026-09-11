import "server-only";
import {
  getDeliveryProviderCredential,
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
}

const STUART_PROVIDER_CODE = "stuart";

/**
 * Résout le credential Stuart du restaurant fourni, pour un usage
 * runtime réel (marchand). Le `restaurantId` doit provenir d'un
 * contexte serveur déjà authentifié (jamais d'une valeur brute
 * client) — cette fonction elle-même ne réalise AUCUNE vérification
 * d'authentification/autorisation supplémentaire ; c'est la
 * responsabilité de l'appelant, exactement comme
 * `getPaymentProviderCredential` pour le domaine paiement.
 *
 * FAIL CLOSED : lève `StuartMerchantCredentialMissingError` si aucun
 * credential n'est configuré (ou si la configuration existe mais n'est
 * pas encore dans un état lisible — `not_configured`), ou
 * `StuartCredentialError` si le payload stocké est corrompu/invalide.
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
    ...payload,
  };
}
