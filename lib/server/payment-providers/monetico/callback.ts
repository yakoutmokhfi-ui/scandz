import "server-only";
import type {
  MoneticoCallbackRawFields,
  MoneticoCredentialPayload,
  MoneticoResultStatus,
  MoneticoVerifiedCallbackResult,
} from "@/lib/server/payment-providers/monetico/types";
import { transformSecurityKey, verifyMac } from "@/lib/server/payment-providers/monetico/mac";
import {
  MoneticoCallbackError,
  MoneticoMacVerificationError,
} from "@/lib/server/payment-providers/monetico/errors";

/**
 * PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
 * VÉRIFICATION ET ANALYSE DU CALLBACK (interface "Retour").
 *
 * Champs listés indépendamment confirmés (v2.0 §1.4.3.1, p.26-35,
 * plage effectivement atteinte par l'outil de récupération -- à
 * distinguer explicitement de §9.3/p.80, non atteinte, voir
 * canonicalization.ts).
 *
 * §21 CETTE FONCTION NE MUTE JAMAIS D'ÉTAT : elle renvoie un résultat
 * TYPÉ à la couche de paiement générique. Le câblage futur (hors
 * périmètre de ce lot bibliothèque pur, mandat §31/§32) doit suivre
 * exactement : callback vérifié -> `confirmPaymentAttempt()` (PAYMENT
 * P3-A1, déjà publié) -- jamais de mutation directe de
 * `orders`/`payment_transactions` depuis ce module.
 *
 * §23 IDEMPOTENCE : ces fonctions sont PURES (aucun effet de bord,
 * aucun état interne, aucune écriture) -- appeler
 * `verifyMoneticoCallback` deux fois avec exactement les mêmes champs
 * bruts produit exactement le même résultat les deux fois, par
 * construction. Voir le test dédié dans
 * tests/v111e-payment-p3a2-callback.test.ts.
 */

/**
 * Mapping traçable des valeurs `code-retour` confirmées (v2.0 §1.4.3.1,
 * p.26-35) vers le modèle générique interne (mandat §24) :
 *   payetest            -> paid    ("paiement accepté", bac à sable uniquement)
 *   paiement             -> paid    ("paiement accepté", Production uniquement)
 *   paiement_pf[N]       -> paid    (échéance N d'un paiement fractionné accepté)
 *   annulation           -> failed  ("paiement refusé")
 *   Annulation_pf[N]     -> failed  (échéance N d'un paiement fractionné refusé)
 *   attente_partenaire   -> pending ("paiement en attente d'une validation par
 *                                    le partenaire externe")
 *   toute autre valeur   -> pending -- repli SÛR et EXPLICITE (mandat §24 :
 *                           "Do not invent semantic mappings" / "Every
 *                           mapping must be traceable") : une valeur non
 *                           documentée dans la plage atteinte par l'agent
 *                           n'est JAMAIS traitée comme un succès par
 *                           défaut. Elle est traitée comme "pending" (donc
 *                           "pas encore confirmé comme payé") plutôt que
 *                           de faire échouer bruyamment tout le callback,
 *                           ce qui laisse la couche appelante décider --
 *                           documenté explicitement comme un choix
 *                           conservateur, pas une garantie de complétude
 *                           du mapping.
 */
function mapCodeRetour(codeRetour: string): MoneticoResultStatus {
  if (
    codeRetour === "payetest" ||
    codeRetour === "paiement" ||
    /^paiement_pf[1-9][0-9]*$/.test(codeRetour)
  ) {
    return "paid";
  }
  if (codeRetour === "annulation" || /^Annulation_pf[1-9][0-9]*$/.test(codeRetour)) {
    return "failed";
  }
  return "pending";
}

/** Analyse les champs bruts reçus en un jeu de chaînes strictement
 *  typées, prêt pour le calcul du MAC -- rejette tout type inattendu
 *  plutôt que de le coercer silencieusement (même politique stricte
 *  que credentials.ts). */
export function parseMoneticoCallback(raw: MoneticoCallbackRawFields): {
  fields: Record<string, string>;
  mac: string;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MoneticoCallbackError("MONETICO_CALLBACK_MALFORMED");
  }

  const mac = raw["MAC"];
  if (typeof mac !== "string" || mac.length === 0) {
    throw new MoneticoCallbackError("MONETICO_CALLBACK_MISSING_MAC");
  }
  const codeRetour = raw["code-retour"];
  if (typeof codeRetour !== "string" || codeRetour.length === 0) {
    throw new MoneticoCallbackError("MONETICO_CALLBACK_MISSING_CODE_RETOUR");
  }
  const reference = raw["reference"];
  if (typeof reference !== "string" || reference.length === 0) {
    throw new MoneticoCallbackError("MONETICO_CALLBACK_MISSING_REFERENCE");
  }

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "MAC") continue; // jamais inclus dans son propre calcul (§21.2)
    if (typeof value !== "string") {
      throw new MoneticoCallbackError("MONETICO_CALLBACK_INVALID_FIELD_TYPE");
    }
    fields[key] = value;
  }

  return { fields, mac };
}

/**
 * Vérifie le MAC d'un callback puis mappe son résultat vers le modèle
 * générique. Reconstruit la chaîne canonique à partir de TOUS les
 * paramètres effectivement reçus (mandat §11/§21.2 -- "callback
 * verification uses received parameters"), jamais d'une liste fixe
 * pré-déterminée.
 */
export function verifyMoneticoCallback(
  raw: MoneticoCallbackRawFields,
  credential: MoneticoCredentialPayload
): MoneticoVerifiedCallbackResult {
  const { fields, mac } = parseMoneticoCallback(raw);
  const keyBuffer = transformSecurityKey(credential.securityKey);

  if (!verifyMac(fields, keyBuffer, mac)) {
    throw new MoneticoMacVerificationError();
  }

  const codeRetour = fields["code-retour"];
  const numauto = fields["numauto"];
  const montant = fields["montant"];

  return {
    status: mapCodeRetour(codeRetour),
    codeRetour,
    providerReference: fields["reference"],
    authorizationReference: typeof numauto === "string" && numauto.length > 0 ? numauto : null,
    rawMontant: typeof montant === "string" && montant.length > 0 ? montant : null,
  };
}
