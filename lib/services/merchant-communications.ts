import { supabase } from "@/lib/supabase";
import {
  COMMUNICATION_TEXT_KEYS,
  isCommunicationTextKey,
  overridesFromPublicProjection,
  sanitizeCommunicationTextOverrides,
  type CommunicationTextKey,
  type CommunicationTextOverrides,
} from "@/lib/communications/text-keys";
import {
  COMMUNICATION_EVENT_CODES,
  sanitizeCommunicationEventConfig,
  type CommunicationEventCode,
  type CommunicationEventConfig,
} from "@/lib/communications/events";
import { validateCommunicationTemplate } from "@/lib/communications/template-variables";

/**
 * Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 — relais de transport.
 *
 * Même patron que lib/services/tracking-status-text.ts, dont ce module
 * est le strict prolongement :
 *   - LECTURE MARCHANDE : `select` direct sur les deux tables, borné par
 *     leur RLS (membres du tenant ou opérateur Scanym, aucun accès
 *     anon) -- jamais une RPC de plus pour une lecture que la RLS sait
 *     déjà borner ;
 *   - LECTURE CLIENT : la projection PUBLIQUE
 *     `get_restaurant_public_communication_texts`, qui n'expose JAMAIS
 *     les gabarits d'e-mail ;
 *   - ÉCRITURE : EXCLUSIVEMENT les deux RPC SECURITY DEFINER. Les tables
 *     n'accordent aucun INSERT/UPDATE/DELETE : l'écriture RPC-only est
 *     garantie par le schéma, pas par convention de code.
 *
 * Ce module ne connaît AUCUN texte : il transporte de la configuration.
 * La résolution surcharge/base est faite ailleurs, par l'unique autorité
 * `resolveCommunicationText` (lib/communications/resolve.ts).
 */

interface CommunicationTextRow {
  text_key: string;
  body: string | null;
}

interface CommunicationEventRow {
  event_code: string;
  enabled: boolean | null;
}

/** Échec de lecture. DISTINCT d'une configuration vide : « aucun texte
 *  configuré » et « impossible de savoir » ne se confondent pas -- le
 *  second doit laisser le back-office refuser l'enregistrement plutôt
 *  qu'écraser une configuration qu'il n'a pas pu lire (même leçon que
 *  `legalProfileReady` dans SETTINGS SAVE RELIABILITY v1.3). */
export class CommunicationTextsReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommunicationTextsReadError";
  }
}

/**
 * CHEMIN MARCHAND — les 14 emplacements, gabarits d'e-mail INCLUS.
 * Borné par la RLS de la table.
 */
export async function getMerchantCommunicationTexts(
  restaurantId: string
): Promise<CommunicationTextOverrides> {
  const { data, error } = await supabase
    .from("merchant_communication_text")
    .select("text_key, body")
    .eq("restaurant_id", restaurantId);
  if (error) throw new CommunicationTextsReadError(error.message);

  const raw: Record<string, unknown> = {};
  for (const row of (data ?? []) as CommunicationTextRow[]) {
    raw[row.text_key] = row.body;
  }
  return sanitizeCommunicationTextOverrides(raw);
}

/**
 * CHEMIN CLIENT ANONYME — les 11 emplacements customer-facing d'UN
 * établissement. Les gabarits d'e-mail ne traversent pas cette
 * frontière, ni ici ni en SQL.
 *
 * Une lecture en échec renvoie un objet VIDE plutôt que de lever : la
 * vitrine doit continuer de fonctionner avec les formulations
 * plateforme, jamais tomber en panne parce qu'un texte facultatif n'a
 * pas pu être lu. C'est le repli SÛR (comportement d'avant ce lot), pas
 * un masquage d'erreur : aucune décision métier n'en dépend.
 */
export async function getPublicCommunicationTexts(
  restaurantId: string
): Promise<CommunicationTextOverrides> {
  const id = (restaurantId ?? "").trim();
  if (id === "") return {};
  const { data, error } = await supabase.rpc(
    "get_restaurant_public_communication_texts",
    { p_restaurant_id: id }
  );
  if (error || data === null || data === undefined) return {};
  return overridesFromPublicProjection(
    data as ReadonlyArray<{ text_key?: unknown; body?: unknown }>
  );
}

/**
 * Enregistre (ou efface) UN emplacement.
 *
 * Une chaîne vide/blanche est transmise telle quelle : le SQL la traite
 * comme un EFFACEMENT (ligne supprimée, repli sur la formulation
 * plateforme) -- un seul état pour « pas de surcharge », jamais une
 * ligne vide persistée.
 *
 * La validation de la liste blanche de variables est refaite ICI avant
 * l'aller-retour (MCC-V1-UNKNOWN-VARIABLE-RULE, moitié ÉCRITURE), mais
 * l'AUTORITÉ reste le serveur : la RPC et une contrainte CHECK refusent
 * de leur côté, donc contourner ce garde-fou client ne permet rien.
 */
export async function setMerchantCommunicationText(
  restaurantId: string,
  textKey: CommunicationTextKey,
  body: string
): Promise<void> {
  if (!isCommunicationTextKey(textKey)) {
    throw new Error("SCANYM_COMMUNICATION_UNKNOWN_TEXT_KEY");
  }
  const validation = validateCommunicationTemplate(body);
  if (!validation.ok) {
    throw new Error(
      `SCANYM_COMMUNICATION_UNKNOWN_VARIABLE: ${validation.unknownVariables.join(", ")}`
    );
  }
  const { error } = await supabase.rpc("set_merchant_communication_text", {
    p_restaurant_id: restaurantId,
    p_text_key: textKey,
    p_body: body,
  });
  if (error) throw new Error(error.message);
}

export async function getMerchantCommunicationEvents(
  restaurantId: string
): Promise<CommunicationEventConfig> {
  const { data, error } = await supabase
    .from("merchant_communication_event")
    .select("event_code, enabled")
    .eq("restaurant_id", restaurantId);
  if (error) throw new CommunicationTextsReadError(error.message);
  return sanitizeCommunicationEventConfig(
    (data ?? []) as CommunicationEventRow[]
  );
}

export async function setMerchantCommunicationEventEnabled(
  restaurantId: string,
  eventCode: CommunicationEventCode,
  enabled: boolean
): Promise<void> {
  if (!(COMMUNICATION_EVENT_CODES as readonly string[]).includes(eventCode)) {
    throw new Error("SCANYM_COMMUNICATION_UNKNOWN_EVENT");
  }
  const { error } = await supabase.rpc("set_merchant_communication_event_enabled", {
    p_restaurant_id: restaurantId,
    p_event_code: eventCode,
    p_enabled: enabled === true,
  });
  if (error) throw new Error(error.message);
}

/**
 * MERCHANT CUSTOMER COMMUNICATIONS v1 — preuve d'éligibilité à la
 * rétractation pour l'écran de confirmation.
 *
 * Passe par la route serveur app/api/checkout/withdrawal-eligibility, et
 * NON par un appel RPC anonyme : l'éligibilité par ligne est une
 * classification interne du commerçant, déjà retirée de la carte
 * publique par lib/services/restaurant.ts. Seul un agrégat booléen, pour
 * une commande dont l'appelant prouve la possession, traverse.
 *
 * FERMÉ AU REPOS : toute anomalie (réseau, HTTP non-2xx, corps
 * inattendu) renvoie `false`, donc aucun appel à l'action affiché.
 */
export async function fetchWithdrawalEligibility(
  orderId: string,
  publicToken: string
): Promise<boolean> {
  try {
    const response = await fetch("/api/checkout/withdrawal-eligibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, publicToken }),
    });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return (
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>).eligible === true
    );
  } catch {
    return false;
  }
}

/** Réexport pour les formulaires : l'ordre d'affichage du back-office
 *  est DÉRIVÉ du catalogue, jamais recopié. */
export { COMMUNICATION_TEXT_KEYS, COMMUNICATION_EVENT_CODES };
