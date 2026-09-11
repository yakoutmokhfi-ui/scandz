import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import {
  DeliveryProviderServerRpcError,
  DeliveryProviderServerUnavailableError,
} from "@/lib/server/delivery-provider-errors";

/**
 * LOT A-0 — MERCHANT STUART CREDENTIAL FOUNDATION v1.
 *
 * Couche serveur de confiance pour `public.delivery_provider_configs`
 * et ses trois RPC SECURITY DEFINER (`set_/clear_/get_
 * delivery_provider_credentials`, `supabase/DRAFT-lot-stuart-merchant-
 * credential-foundation-v1.sql`). Domaine PARALLÈLE et SÉPARÉ de
 * `lib/server/payment-service.ts` (décision CIO/CTO explicite du
 * mandat LOT A-0) — ce fichier n'importe rien de `payment-service.ts`
 * et n'appelle aucune RPC `*_payment_provider_*`.
 *
 * Réutilise `getServiceRoleSupabaseClient()` (lib/server/supabase-
 * admin.ts) — le client `service_role` PARTAGÉ du projet, déjà utilisé
 * par le domaine paiement ; ce module n'instancie PAS un second client
 * service_role (réutilisation délibérée de l'infrastructure existante,
 * pas une duplication).
 *
 * Ce module ne sait RIEN de Stuart spécifiquement (aucun champ
 * clientId/clientSecret ici) — le payload `p_secret`/la valeur de
 * retour de `getDeliveryProviderCredential` restent un texte opaque du
 * point de vue de ce fichier ; le parsing/la validation spécifiques à
 * Stuart vivent dans `lib/server/delivery-providers/stuart/
 * credentials.ts` et `credential-resolver.ts`, qui appellent ce
 * module.
 */

function logRpcFailure(rpcName: string, sqlstate: string | null | undefined): void {
  console.error(`[delivery-provider-service] RPC "${rpcName}" a échoué (SQLSTATE=${sqlstate ?? "?"})`);
}

// ------------------------------------------------------------------
// set_delivery_provider_credentials(p_restaurant_id uuid,
//   p_provider_code text, p_secret text, p_mode text default
//   'sandbox') returns table (config_id, provider_code, mode,
//   configuration_status, last_updated)
// ------------------------------------------------------------------

export interface SetDeliveryProviderCredentialsInput {
  restaurantId: string;
  providerCode: string;
  /** Payload secret opaque (par convention, une chaîne JSON) — jamais
   *  interprété par ce module. */
  secret: string;
  mode?: "sandbox" | "production";
}

export interface DeliveryProviderConfigSummary {
  configId: string;
  providerCode: string;
  mode: string;
  configurationStatus: string;
  lastUpdated: string;
}

/**
 * Écrit (crée ou remplace en place) le credential d'un prestataire de
 * livraison pour un restaurant donné. Ne retourne JAMAIS le secret —
 * uniquement des métadonnées de configuration (mandat §"never returns
 * plaintext"). service_role UNIQUEMENT côté RPC (`REVOKE ALL FROM
 * public, anon, authenticated`) — ce module lui-même n'ajoute AUCUNE
 * vérification d'autorisation applicative supplémentaire : c'est à
 * l'appelant serveur (un futur point d'entrée Admin/Operator, hors
 * périmètre de ce lot) de s'assurer qu'il n'invoque cette fonction
 * qu'après avoir authentifié un opérateur/admin autorisé — voir
 * README-LOT-A0.md.
 */
export async function setDeliveryProviderCredentials(
  input: SetDeliveryProviderCredentialsInput
): Promise<DeliveryProviderConfigSummary> {
  const client = getServiceRoleSupabaseClient();

  let data: unknown;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("set_delivery_provider_credentials", {
      p_restaurant_id: input.restaurantId,
      p_provider_code: input.providerCode,
      p_secret: input.secret,
      p_mode: input.mode ?? "sandbox",
    }));
  } catch {
    throw new DeliveryProviderServerUnavailableError();
  }

  if (error) {
    logRpcFailure("set_delivery_provider_credentials", error.code);
    throw new DeliveryProviderServerRpcError("set_delivery_provider_credentials", error.code);
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (
    !row ||
    typeof row !== "object" ||
    typeof (row as Record<string, unknown>).config_id !== "string"
  ) {
    logRpcFailure("set_delivery_provider_credentials", "EMPTY_RESULT");
    throw new DeliveryProviderServerRpcError("set_delivery_provider_credentials", null);
  }

  const r = row as Record<string, unknown>;
  return {
    configId: String(r.config_id),
    providerCode: String(r.provider_code),
    mode: String(r.mode),
    configurationStatus: String(r.configuration_status),
    lastUpdated: String(r.last_updated),
  };
}

// ------------------------------------------------------------------
// clear_delivery_provider_credentials(p_restaurant_id uuid,
//   p_provider_code text) returns table (config_id, provider_code,
//   configuration_status, last_updated)
// ------------------------------------------------------------------

export interface ClearDeliveryProviderCredentialsInput {
  restaurantId: string;
  providerCode: string;
}

/**
 * Retire (reset) le credential d'un prestataire de livraison pour un
 * restaurant donné. service_role UNIQUEMENT côté RPC.
 */
export async function clearDeliveryProviderCredentials(
  input: ClearDeliveryProviderCredentialsInput
): Promise<DeliveryProviderConfigSummary> {
  const client = getServiceRoleSupabaseClient();

  let data: unknown;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("clear_delivery_provider_credentials", {
      p_restaurant_id: input.restaurantId,
      p_provider_code: input.providerCode,
    }));
  } catch {
    throw new DeliveryProviderServerUnavailableError();
  }

  if (error) {
    logRpcFailure("clear_delivery_provider_credentials", error.code);
    throw new DeliveryProviderServerRpcError("clear_delivery_provider_credentials", error.code);
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (
    !row ||
    typeof row !== "object" ||
    typeof (row as Record<string, unknown>).config_id !== "string"
  ) {
    logRpcFailure("clear_delivery_provider_credentials", "EMPTY_RESULT");
    throw new DeliveryProviderServerRpcError("clear_delivery_provider_credentials", null);
  }

  const r = row as Record<string, unknown>;
  return {
    configId: String(r.config_id),
    providerCode: String(r.provider_code),
    mode: "",
    configurationStatus: String(r.configuration_status),
    lastUpdated: String(r.last_updated),
  };
}

// ------------------------------------------------------------------
// get_delivery_provider_credential(p_restaurant_id uuid,
//   p_provider_code text) returns text
// ------------------------------------------------------------------

export interface GetDeliveryProviderCredentialInput {
  restaurantId: string;
  providerCode: string;
}

/**
 * Lit le credential déchiffré d'un prestataire de livraison pour un
 * restaurant donné, via la RPC de lecture. La valeur renvoyée (une
 * chaîne NUE, jamais enveloppée dans un objet) DOIT rester en mémoire
 * de confiance côté serveur : ce module ne la journalise jamais, ne la
 * renvoie jamais dans un message d'erreur.
 *
 * Lève systématiquement (jamais de valeur par défaut/repli silencieux)
 * si aucune configuration n'existe pour ce couple restaurant/provider
 * — c'est au SEUL appelant (`credential-resolver.ts`) de décider
 * comment traduire cette absence pour son propre domaine (Stuart :
 * `StuartMerchantCredentialMissingError`).
 */
export async function getDeliveryProviderCredential(
  input: GetDeliveryProviderCredentialInput
): Promise<string> {
  const client = getServiceRoleSupabaseClient();

  let data: string | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("get_delivery_provider_credential", {
      p_restaurant_id: input.restaurantId,
      p_provider_code: input.providerCode,
    }));
  } catch {
    throw new DeliveryProviderServerUnavailableError();
  }

  if (error) {
    // JAMAIS `data` ici, même en cas d'erreur.
    logRpcFailure("get_delivery_provider_credential", error.code);
    throw new DeliveryProviderServerRpcError("get_delivery_provider_credential", error.code);
  }

  if (typeof data !== "string" || data.length === 0) {
    logRpcFailure("get_delivery_provider_credential", "EMPTY_RESULT");
    throw new DeliveryProviderServerRpcError("get_delivery_provider_credential", null);
  }

  return data;
}
