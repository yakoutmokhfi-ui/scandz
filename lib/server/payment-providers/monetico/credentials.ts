import "server-only";
import type { MoneticoCredentialPayload } from "@/lib/server/payment-providers/monetico/types";
import { MoneticoCredentialError } from "@/lib/server/payment-providers/monetico/errors";

/**
 * PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
 *
 * Analyse et validation STRICTE du credential Monetico lu via
 * `getPaymentProviderCredential()` (PAYMENT P3-A1, mandat §27 -- ce
 * module n'accède JAMAIS à Vault directement, n'appelle jamais
 * `vault.decrypted_secrets`). La chaîne brute reçue est une charge
 * JSON définie par CE lot (voir types.ts) -- `p_secret text` côté SQL
 * (PAYMENT P2A) n'impose aucune structure, donc rien ici ne "devine"
 * le protocole Monetico lui-même, seulement la convention de stockage
 * choisie par cette application.
 *
 * Ne journalise JAMAIS le contenu analysé, sous quelque forme que ce
 * soit -- ni en cas de succès, ni en cas d'échec (mandat §8/§28).
 */

const TPE_PATTERN = /^[A-Za-z0-9]{7}$/;
const SECURITY_KEY_PATTERN = /^[0-9A-Fa-f]{40}$/;
const SOCIETE_MAX_LENGTH = 64;
const SOCIETE_PATTERN = /^[\x20-\x7E]+$/;

/** Seules ces trois propriétés sont acceptées -- toute propriété
 *  supplémentaire inattendue est REJETÉE (mandat §8 : "unexpected
 *  unsafe types" / §36 : "extra unsupported property policy"), pour
 *  empêcher qu'un champ additionnel non prévu ne soit silencieusement
 *  ignoré ou ne finisse par fuiter plus loin dans le pipeline. */
const ALLOWED_KEYS = new Set(["tpe", "societe", "securityKey"]);

export function parseMoneticoCredential(raw: string): MoneticoCredentialPayload {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new MoneticoCredentialError("MONETICO_CREDENTIAL_EMPTY");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MoneticoCredentialError("MONETICO_CREDENTIAL_MALFORMED_JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MoneticoCredentialError("MONETICO_CREDENTIAL_INVALID_SHAPE");
  }

  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new MoneticoCredentialError("MONETICO_CREDENTIAL_UNEXPECTED_FIELD");
    }
  }

  const tpe = obj.tpe;
  const societe = obj.societe;
  const securityKey = obj.securityKey;

  if (typeof tpe !== "string" || tpe.length === 0) {
    throw new MoneticoCredentialError("MONETICO_CREDENTIAL_MISSING_TPE");
  }
  if (typeof societe !== "string" || societe.length === 0) {
    throw new MoneticoCredentialError("MONETICO_CREDENTIAL_MISSING_SOCIETE");
  }
  if (typeof securityKey !== "string" || securityKey.length === 0) {
    throw new MoneticoCredentialError("MONETICO_CREDENTIAL_MISSING_KEY");
  }

  if (!TPE_PATTERN.test(tpe)) {
    throw new MoneticoCredentialError("MONETICO_CREDENTIAL_INVALID_TPE");
  }
  if (societe.length > SOCIETE_MAX_LENGTH || !SOCIETE_PATTERN.test(societe)) {
    throw new MoneticoCredentialError("MONETICO_CREDENTIAL_INVALID_SOCIETE");
  }
  if (!SECURITY_KEY_PATTERN.test(securityKey)) {
    throw new MoneticoCredentialError("MONETICO_CREDENTIAL_INVALID_KEY");
  }

  return {
    tpe,
    societe,
    // Normalisée en minuscules ici -- l'hexadécimal est
    // insensible à la casse ; voir mac.ts::transformSecurityKey qui
    // re-vérifie et re-normalise indépendamment avant conversion en
    // représentation binaire, sans jamais faire confiance à un appelant
    // qui contournerait ce parseur.
    securityKey: securityKey.toLowerCase(),
  };
}
