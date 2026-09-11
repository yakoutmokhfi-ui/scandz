import "server-only";

/**
 * STUART LOT A — QUOTE / VALIDATE / ETA / SCHEDULING FOUNDATION v1.1.
 *
 * CORRECTIF v1.1 (CTO PRE-CONTROL, LOT-A-CONTRACT-01, BLOCKER) : v1
 * implémentait `validateDelivery(...)` en POSTant EXACTEMENT la même
 * charge utile (`StuartCreateJobPayload`) que Create Job/Pricing vers
 * `/v2/jobs/validate` -- alors que le rapport final de v1 lui-même
 * documentait EXPLICITEMENT qu'AUCUNE preuve documentaire du dépôt ne
 * prouve le schéma de requête NI de réponse de cet endpoint. Un test
 * avec réponse HTTP mockée ne peut JAMAIS établir un contrat externe
 * réel -- il prouve seulement que le CODE se comporte comme MOCKÉ,
 * jamais que Stuart accepte réellement cette forme de requête.
 * Violation directe du mandat : "Do NOT assume undocumented fields. If
 * Stuart contract/documentation in repo does not prove a request/
 * response field, STOP and report it instead of inventing it."
 *
 * REMÉDIATION v1.1 : `validateDelivery(...)` n'émet PLUS AUCUNE
 * requête HTTP vers `/v2/jobs/validate` (ni vers quoi que ce soit
 * d'autre) -- voir `StuartValidateContractUnverifiedError` ci-dessous
 * et `quote-service.ts` pour l'implémentation. AUCUN alias silencieux
 * vers Pricing -- Validate reste une FONCTIONNALITÉ NON PROUVÉE,
 * jamais implémentée par substitution.
 *
 * Couvre EXACTEMENT le modèle d'erreur du mandat STUART LOT A
 * ("ERROR MODEL", "normalize at minimum"), PLUS la condition v1.1
 * "contrat non vérifié" (propre à Scanym, hors énumération mandat
 * d'origine mais requise par le CTO pre-control) :
 *
 *   1. configuration error        -> StuartQuoteConfigurationError
 *   2. credential/auth error      -> StuartQuoteCredentialError
 *   3. invalid request/address    -> classification "invalid_request"
 *   4. unsupported delivery       -> classification "unsupported_delivery"
 *   5. provider rejection         -> classification "provider_rejection"
 *   6. transient provider/network failure -> classification "transient_failure"
 *   7. provider malformed response -> classification "malformed_response"
 *   8. (v1.1) contrat externe non vérifié -> StuartValidateContractUnverifiedError
 *
 * DÉCISION DE CONCEPTION EXPLICITE (propre à Scanym, PAS une
 * déduction du contrat Stuart lui-même) : les catégories 1-2 SONT
 * levées comme des EXCEPTIONS typées (`quote-service.ts` échoue AVANT
 * tout appel HTTP réel — on ne peut alors renvoyer aucun résultat
 * normalisé cohérent, faute de `mode`/`httpStatus` connus). Les
 * catégories 3-7, elles, décrivent le résultat d'un ALLER-RETOUR HTTP
 * réel vers Stuart (réponse reçue, ou tentative réseau ayant échoué
 * après authentification réussie) — elles sont donc portées par le
 * champ `errorClassification` de `NormalizedStuartQuoteResult` (voir
 * `quote-types.ts`), JAMAIS levées comme exception, pour offrir à
 * l'appelant un point de branchement unique et exhaustif sur le
 * résultat d'une tentative de validation/devis, plutôt que deux
 * chemins de contrôle distincts (retour normal vs exception) pour des
 * cas qui sont tous, du point de vue métier, des RÉPONSES viables sur
 * l'éligibilité/le prix d'une livraison.
 *
 * DISCIPLINE DE CLASSIFICATION HTTP -- IDENTIQUE à `create-job.ts`
 * (STUART-V21-HTTP-TERMINAL-CLASSIFICATION-01) : sémantique HTTP
 * GÉNÉRIQUE UNIQUEMENT, aucune supposition de code de statut
 * spécifique à Stuart (aucune preuve documentaire actuelle trouvée
 * pour `/v2/jobs/validate`, endpoint dont l'existence même n'est
 * confirmée QUE par le mandat, jamais par le dépôt — voir le livrable
 * final, section "unresolved Stuart contract questions") :
 *   - 2xx + JSON parseable -> succès (`eligible: true`, aucune
 *     classification d'erreur) ;
 *   - 2xx + JSON NON parseable -> "malformed_response" ;
 *   - 5xx, ou échec réseau/timeout AVANT réception d'une réponse ->
 *     "transient_failure" ;
 *   - tout 4xx -> "provider_rejection" (générique -- AUCUNE preuve
 *     documentaire actuelle ne permet de distinguer un 4xx "adresse
 *     invalide" (`invalid_request`) d'un 4xx "livraison non
 *     supportée" (`unsupported_delivery`) d'un 4xx "rejet générique"
 *     -- ces DEUX classifications plus fines restent définies dans
 *     l'union ci-dessous, pour documentation/extension future, mais
 *     ne sont JAMAIS affectées par ce lot -- fidèle au mandat :
 *     "STOP and report it instead of inventing it").
 */

export type StuartQuoteErrorClassification =
  | "invalid_request"
  | "unsupported_delivery"
  | "provider_rejection"
  | "transient_failure"
  | "malformed_response";

export class StuartQuoteError extends Error {
  constructor(message: string = "STUART_QUOTE_ERROR") {
    super(message);
    this.name = "StuartQuoteError";
  }
}

/**
 * Levée AVANT tout appel HTTP -- aucune configuration marchande
 * (`delivery_provider_configs`) exploitable n'existe pour ce
 * restaurant/provider (couvre, sans les distinguer davantage,
 * "aucune ligne de config" ET "mode invalide" ET "aucun credential
 * configuré" -- exactement la même absence de distinction déjà faite
 * par `StuartMerchantCredentialMissingError`, LOT A-0, dont cette
 * classe est la traduction dans le domaine QUOTE/VALIDATE).
 */
export class StuartQuoteConfigurationError extends StuartQuoteError {
  constructor(message: string = "STUART_QUOTE_CONFIGURATION_ERROR") {
    super(message);
    this.name = "StuartQuoteConfigurationError";
  }
}

/**
 * Levée AVANT tout appel `/v2/jobs/validate` ou `/v2/jobs/pricing" --
 * soit le payload credential stocké est corrompu/invalide (traduction
 * de `StuartCredentialError`, LOT A-0), soit l'authentification OAuth
 * marchande elle-même a échoué (traduction de `StuartMerchantAuthError`,
 * `merchant-auth.ts`, STUART LOT A) -- les DEUX causes sont fusionnées
 * en UNE SEULE classification, fidèle au mandat qui les liste ensemble
 * ("credential/auth error").
 */
export class StuartQuoteCredentialError extends StuartQuoteError {
  constructor(message: string = "STUART_QUOTE_CREDENTIAL_ERROR") {
    super(message);
    this.name = "StuartQuoteCredentialError";
  }
}

/**
 * STUART LOT A v1.1 (CTO PRE-CONTROL, LOT-A-CONTRACT-01) -- levée
 * UNIQUEMENT par `validateDelivery(...)`, IMMÉDIATEMENT, AVANT toute
 * résolution de credential et AVANT toute authentification OAuth
 * marchande (mandat, "no OAuth request is made merely to discover
 * that Validate is unsupported, if this can be established before
 * authentication" -- ici, c'est établissable AVANT MÊME la résolution
 * de credential : le contrat `/v2/jobs/validate` est inconnu quel que
 * soit le restaurant, donc la condition ne dépend d'AUCUNE donnée
 * marchande). ZÉRO appel RPC Supabase, ZÉRO requête OAuth, ZÉRO
 * requête HTTP Stuart de quelque nature que ce soit.
 *
 * DÉLIBÉRÉMENT distincte de `StuartQuoteConfigurationError`/
 * `StuartQuoteCredentialError` (mandat : "clearly distinguishable
 * from configuration / credential failures") -- cette erreur ne
 * signifie JAMAIS "ce marchand n'est pas configuré", elle signifie
 * "cette FONCTIONNALITÉ n'a pas encore de contrat externe prouvé",
 * une propriété du LOT, pas du marchand. Également DÉLIBÉRÉMENT
 * distincte de toute valeur de `StuartQuoteErrorClassification`
 * (mandat : "impossible for caller to mistake it for provider
 * rejection") -- ces classifications décrivent TOUJOURS un aller-
 * retour HTTP réel ayant eu lieu ; ici, AUCUN aller-retour n'a jamais
 * lieu, donc porter cette condition dans
 * `NormalizedStuartQuoteResult.errorClassification` (qui inclut un
 * `httpStatus`) aurait été trompeur -- une EXCEPTION typée dédiée est
 * la représentation la plus honnête de "cette opération n'a pas
 * encore été implémentée, faute de preuve", conformément au mandat :
 * "Do not over-engineer a new general framework."
 */
export class StuartValidateContractUnverifiedError extends StuartQuoteError {
  constructor(message: string = "STUART_VALIDATE_CONTRACT_UNVERIFIED") {
    super(message);
    this.name = "StuartValidateContractUnverifiedError";
  }
}
