import "server-only";
import {
  getPaymentTransactionCorrelation,
  confirmPaymentAttempt,
  updatePaymentProviderEventProcessingStatus,
  type ClaimedPaymentProviderEvent,
} from "@/lib/server/payment-service";
import {
  PaymentServerUnavailableError,
  PaymentServerRpcError,
  classifyRpcSqlstate,
} from "@/lib/server/payment-errors";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4 — STAGE B : TRAITEMENT
 * DURABLE PARTAGÉ (ferme P3B-V4-ACK-RECOVERY-01, mandat §15-§21).
 *
 * SEULE implémentation du traitement métier d'un évènement REVENDIQUÉ
 * (claim/lease) -- appelée IDENTIQUEMENT par :
 *   1. le chemin SYNCHRONE (payment-callback-runtime.ts, juste après
 *      `claimPaymentProviderEventById` sur l'évènement qu'il vient
 *      d'enregistrer) ;
 *   2. le futur worker de reprise (app/api/internal/payments/monetico/
 *      recover/route.ts, après `claimPaymentProviderEvents` par lot).
 * Mandat §17 : "Do not create a second processing implementation" --
 * les deux appelants diffèrent UNIQUEMENT par la façon dont ils
 * REVENDIQUENT (id précis vs lot générique), jamais par ce qu'ils font
 * ENSUITE d'un évènement revendiqué.
 *
 * PRÉCONDITION : `claimed` provient d'un appel RÉUSSI à
 * `claimPaymentProviderEventById`/`claimPaymentProviderEvents` --
 * cette fonction ne revendique JAMAIS elle-même, elle ne fait que
 * traiter puis finaliser via `updatePaymentProviderEventProcessingStatus`
 * (PAYMENT P3-B5 v2, INCHANGÉE) avec le `claimToken` déjà obtenu.
 *
 * RÈGLES DURES v3 PRÉSERVÉES SANS EXCEPTION : seul `providerEventType
 * === "paid"`, avec montant/devise AUTORITATIFS correspondants, appelle
 * jamais `confirmPaymentAttempt`. `refused`/`pending`/`unknown`
 * n'appellent JAMAIS `confirmPaymentAttempt` -- ils sont marqués
 * `ignored` (terminal non-financier, mandat §21).
 *
 * REPRISE APRÈS CRASH / CLAIMANT PÉRIMÉ (mandat §16 point 9, crash
 * matrix scénario E) : si `updatePaymentProviderEventProcessingStatus`
 * échoue (jeton de bail périmé -- un autre claimant a repris cet
 * évènement entre-temps), cette fonction NE relève PAS l'exception --
 * elle renvoie `outcome: "stale_claim"`, un résultat NORMAL (perte de
 * course sûre par construction, jamais une double application), jamais
 * une erreur remontée à l'appelant.
 */

export type ProcessedPaymentProviderEventOutcome =
  | "applied"
  | "ignored"
  | "failed_retryable"
  | "failed_terminal"
  /** Conflit RÉEL de revendication/bail (SQLSTATE P0004 --
   *  `update_payment_provider_event_processing_status`) : un autre
   *  claimant a repris cet évènement entre-temps, ou le bail de CE
   *  worker a expiré avant qu'il n'ait pu finaliser. Perte de course
   *  SÛRE par construction, jamais une double application, jamais
   *  une erreur remontée à l'appelant. */
  | "stale_claim"
  /**
   * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.3 — ferme
   * P3BV42-TERMINAL-TRANSITION-MISMATCH-01.
   *
   * Transition RÉELLEMENT refusée par la machine à états SQL
   * (SQLSTATE 42501 -- jamais un conflit de bail/revendication,
   * malgré leur proximité de code). AVANT ce lot, `finalize()`
   * masquait INCONDITIONNELLEMENT ce cas (comme tout autre échec) en
   * `stale_claim` -- "A rejected state transition is NOT a stale
   * claim" (mandat §8, littéral). Depuis la correction SQL
   * accompagnant ce lot (received -> failed_terminal désormais
   * autorisée), ce cas ne devrait plus jamais survenir pour un chemin
   * de traitement NORMAL -- sa présence indique soit un bug de
   * programmation (transition non anticipée demandée), soit une
   * course EXTRÊMEMENT rare de verrouillage terminal (deux
   * revendications valides concurrentes, l'une ayant déjà finalisé
   * avant l'autre) -- dans les deux cas, un signal DISTINCT et
   * explicite, jamais silencieusement absorbé.
   */
  | "finalize_rejected_transition"
  /**
   * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.3 — ferme
   * P3BV42-TERMINAL-TRANSITION-MISMATCH-01.
   *
   * L'appel de finalisation lui-même (`update_payment_provider_event_
   * processing_status`) a échoué pour une raison TRANSITOIRE ou
   * INCONNUE (panne de transport, SQLSTATE transitoire/inconnu --
   * jamais P0004 ni 42501, traités séparément ci-dessus). Comportement
   * sûr : le bail de CE worker reste en vigueur jusqu'à expiration
   * naturelle (aucune mutation n'a eu lieu côté base), après quoi
   * l'évènement redevient éligible à une nouvelle revendication --
   * jamais une double application, jamais une erreur remontée à
   * l'appelant, jamais confondu avec un conflit de bail RÉEL
   * (`stale_claim`) qui, lui, signifie qu'un AUTRE claimant a déjà
   * repris la main.
   */
  | "finalize_failed_transient";

export interface ProcessedPaymentProviderEventResult {
  outcome: ProcessedPaymentProviderEventOutcome;
  eventId: string;
}

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2 — ferme
 * P3BV41-RECOVERY-STARVATION-01 (audit de travail v4.1 indépendant,
 * blocage HIGH). MÊME plafond que `c_max_retry_attempts` côté SQL
 * (update_payment_provider_event_processing_status,
 * DRAFT-lot-payment-p3b5-durable-provider-callback-inbox.sql) --
 * DÉLIBÉRÉMENT dupliqué ici (pas une source de vérité UNIQUE) :
 * la RPC reste l'AUTORITÉ qui ne peut jamais être contournée (défense
 * en profondeur, voir son commentaire), mais vérifier AUSSI ici permet
 * de choisir directement `failed_terminal` plutôt que de compter sur
 * l'escalade automatique de la RPC pour un évènement dont on sait déjà
 * ICI, avant l'appel, que le plafond est atteint -- comportement
 * observable identique dans les deux cas (la RPC escaladerait de toute
 * façon), mais plus explicite pour la relecture de ce fichier.
 */
const MAX_RETRY_ATTEMPTS = 5;

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2 — ferme
 * P3BV41-RECOVERY-STARVATION-01. AVANT ce lot, TOUTE exception levée
 * pendant le traitement (corrélation indisponible OU
 * `confirmPaymentAttempt` en échec) devenait inconditionnellement
 * `failed_retryable` -- aucune distinction transitoire/permanente
 * (mandat §13 : "Do NOT classify every failure as retryable"). Deux
 * classes d'erreur RÉELLEMENT distinctes existent déjà dans
 * `payment-service.ts` et sont réutilisées ICI, sans en inventer une
 * troisième :
 *   - `PaymentServerUnavailableError` : l'appel RPC lui-même a échoué
 *     AVANT toute exécution côté base (panne réseau/connectivité) --
 *     TRANSITOIRE par construction (mandat §13, "temporary
 *     infrastructure failure"), rejouer la MÊME entrée peut réussir
 *     dès que la connectivité revient.
 *   - `PaymentServerRpcError` : la RPC a RÉELLEMENT été exécutée et la
 *     base a renvoyé un rejet DÉTERMINISTE (contrainte violée,
 *     `raise exception` explicite -- p.ex. "tentative de paiement
 *     introuvable pour ce prestataire/référence", l'exemple LITTÉRAL
 *     du mandat §13 pour "impossible provider/transaction
 *     correlation") -- rejouer la MÊME entrée produit le MÊME rejet
 *     déterministe pour toujours. PERMANENT par construction --
 *     classée TERMINALE.
 *   - Toute AUTRE exception (bug de programmation non anticipé) :
 *     traitée avec la MÊME prudence que le mandat §13 recommande ("If
 *     exact error classification is uncertain: design conservatively
 *     so poison events still cannot cause infinite FIFO starvation")
 *     -- classée `failed_retryable`, mais reste soumise au MÊME
 *     plafond `MAX_RETRY_ATTEMPTS`/escalade automatique côté SQL que
 *     toute autre tentative retryable : jamais infiniment éligible,
 *     même dans le cas non anticipé.
 */
/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.3 — ferme
 * P3BV42-RPC-TRANSIENT-CLASSIFICATION-01.
 *
 * AVANT ce lot : classification PAR TYPE D'EXCEPTION JS uniquement
 * (`instanceof PaymentServerRpcError` -> TOUJOURS `failed_terminal`,
 * quel que soit le SQLSTATE réel) -- exactement l'anti-patron que le
 * mandat §4 interdit explicitement ("Do not classify solely from
 * JavaScript exception-vs-error-object shape"). Un `40001`/`40P01`
 * réellement transitoire, remontant PAR CE MÊME type d'exception
 * (voir payment-service.ts, ferme SQLSTATE-PRESERVATION-01 v4.3),
 * était donc classé à tort `failed_terminal` -- PERMANENT -- alors
 * qu'une nouvelle tentative aurait pu réussir.
 *
 * v4.3 : classification RÉELLE à partir de `error.sqlstate`
 * (`classifyRpcSqlstate`, politique UNIQUE et explicite, mandat §5),
 * jamais du seul type JS. `PaymentServerUnavailableError` reste
 * TOUJOURS transitoire par construction (échec de TRANSPORT avant
 * toute exécution côté base -- aucun SQLSTATE n'existe pour ce cas,
 * il n'y a littéralement rien à classifier davantage).
 */
function classifyProcessingError(err: unknown): "failed_retryable" | "failed_terminal" {
  if (err instanceof PaymentServerUnavailableError) {
    return "failed_retryable";
  }
  if (err instanceof PaymentServerRpcError) {
    const classification = classifyRpcSqlstate(err.sqlstate);
    // "deterministic" -> failed_terminal (rejouer ne changerait rien).
    // "transient"/"unknown" -> failed_retryable, prudence mandat §5
    // ("must NOT silently become immediately terminal... use bounded
    // retry unless there is positive evidence of deterministic
    // failure") -- reste de toute façon soumis au MÊME plafond
    // MAX_RETRY_ATTEMPTS que toute autre tentative retryable, jamais
    // infiniment éligible.
    return classification === "deterministic" ? "failed_terminal" : "failed_retryable";
  }
  // Erreur non reconnue (bug de programmation non anticipé) -- même
  // prudence explicite : retryable-bornée, jamais terminale
  // immédiatement.
  return "failed_retryable";
}

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.3 — ferme
 * P3BV42-TERMINAL-TRANSITION-MISMATCH-01.
 *
 * AVANT ce lot : `catch { return { outcome: "stale_claim" } }`
 * inconditionnel -- masquait indistinctement un VRAI conflit de bail
 * (P0004), une transition refusée par la machine à états (42501, sans
 * AUCUN rapport avec un bail), une panne de transport, ou tout autre
 * SQLSTATE, sous UNE SEULE étiquette trompeuse. Le mandat §8 l'énonce
 * littéralement : "A rejected state transition is NOT a stale claim.
 * A database outage is NOT a stale claim."
 *
 * v4.3 : inspection DIRECTE du SQLSTATE de l'erreur capturée --
 * jamais un `instanceof` seul, jamais `classifyRpcSqlstate` non plus
 * (cette politique concerne la fiabilité transitoire/déterministe des
 * RPC MÉTIER, une préoccupation DIFFÉRENTE de l'intégrité du modèle
 * claim/lease ici) :
 *   - P0004                              -> "stale_claim" (RÉEL) ;
 *   - 42501                              -> "finalize_rejected_transition" ;
 *   - PaymentServerUnavailableError, ou
 *     tout autre SQLSTATE (transitoire/
 *     inconnu/programmation)             -> "finalize_failed_transient".
 * Dans les TROIS cas, comportement identique côté appelant : aucune
 * exception remontée, aucune double application, le bail reste géré
 * par son propre mécanisme d'expiration naturel -- seule l'ÉTIQUETTE
 * change, pour permettre une observabilité/alerte différenciée
 * (mandat §8, "Tests must prove this").
 */
async function finalize(
  claimed: ClaimedPaymentProviderEvent,
  newStatus: "applied" | "ignored" | "failed_retryable" | "failed_terminal",
  errorClass?: string
): Promise<ProcessedPaymentProviderEventResult> {
  try {
    const applied = await updatePaymentProviderEventProcessingStatus({
      eventId: claimed.id,
      claimToken: claimed.claimToken,
      newStatus,
      errorClass,
    });
    // PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.3 -- découverte
    // pendant la construction de la matrice intégrée TS<->SQL
    // (v133) : AVANT cette correction, cette fonction renvoyait
    // aveuglément le paramètre `newStatus` DEMANDÉ localement, jamais
    // l'état RÉELLEMENT persisté renvoyé par la RPC. Or la RPC peut
    // escalader AUTORITAIREMENT `failed_retryable` demandé en
    // `failed_terminal` réellement appliqué (plafond de tentatives
    // atteint, voir son propre commentaire SQL : "le contrat de
    // retour reflète TOUJOURS l'état RÉELLEMENT appliqué -- aucune
    // surprise silencieuse pour un appelant qui lit sa propre
    // réponse"). Ignorer cette valeur de retour aurait signifié que
    // CET appelant, précisément, ne respectait pas cette garantie --
    // un appelant en aval (worker de reprise, alerte, tableau de
    // bord) aurait pu croire l'évènement encore réessayable alors
    // qu'il est déjà définitivement clos. `applied.processingStatus`
    // est désormais la SEULE source de vérité pour l'issue retournée.
    return {
      outcome: applied.processingStatus as ProcessedPaymentProviderEventOutcome,
      eventId: claimed.id,
    };
  } catch (err) {
    if (err instanceof PaymentServerRpcError && err.sqlstate === "P0004") {
      // Conflit RÉEL de revendication/bail -- voir le commentaire de
      // fichier. Perte de course SÛRE, jamais une double application.
      return { outcome: "stale_claim", eventId: claimed.id };
    }
    if (err instanceof PaymentServerRpcError && err.sqlstate === "42501") {
      // Transition refusée par la machine à états -- JAMAIS un
      // conflit de bail (voir le commentaire de fichier).
      return { outcome: "finalize_rejected_transition", eventId: claimed.id };
    }
    // PaymentServerUnavailableError (panne de transport), ou tout
    // autre SQLSTATE non anticipé -- traité avec la même prudence
    // conservatrice que le reste de ce module (mandat §5/§11) :
    // jamais une double application, jamais une erreur remontée.
    return { outcome: "finalize_failed_transient", eventId: claimed.id };
  }
}

export async function processClaimedPaymentProviderEvent(
  claimed: ClaimedPaymentProviderEvent
): Promise<ProcessedPaymentProviderEventResult> {
  if (claimed.providerEventType !== "paid") {
    // refused/pending/unknown (y compris un mode-mismatch dégradé en
    // amont, PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4, code-retour.ts)
    // -- terminal non-financier, jamais confirmPaymentAttempt (règle
    // dure v3, INCHANGÉE, mandat §21).
    return finalize(claimed, "ignored");
  }

  // PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2 -- ferme
  // P3BV41-RECOVERY-STARVATION-01 (mandat §12 "bounded maximum retry
  // count" / §17 "retry threshold test... do not permit endless
  // retries even for nominally transient classes"). Défense en
  // profondeur AVANT TOUT appel RPC de traitement (corrélation ET
  // confirmPaymentAttempt) -- déplacé ICI (avant la corrélation),
  // PAS après elle : un évènement qui a déjà épuisé son plafond de
  // tentatives ne doit générer NI un appel de corrélation NI un appel
  // confirmPaymentAttempt supplémentaire. Voir test v132 "défense en
  // profondeur AVANT tout appel" -- ce contrôle doit précéder la
  // PREMIÈRE RPC de ce chemin, pas seulement la seconde.
  if (claimed.retryCount >= MAX_RETRY_ATTEMPTS) {
    return finalize(claimed, "failed_terminal", "RETRY_LIMIT_EXCEEDED");
  }

  // Ré-vérification défense-en-profondeur, TOUJOURS depuis une lecture
  // FRAÎCHE (mandat §16 point 4) -- jamais une confiance dans les
  // valeurs observées au moment de l'ingestion seules (Stage A a pu
  // avoir lieu bien avant, un worker de reprise traite potentiellement
  // cet évènement longtemps après).
  let correlation: Awaited<ReturnType<typeof getPaymentTransactionCorrelation>>;
  try {
    correlation = await getPaymentTransactionCorrelation({
      providerCode: claimed.providerCode,
      providerReference: claimed.providerReference,
    });
  } catch (err) {
    // PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2 -- ferme
    // P3BV41-RECOVERY-STARVATION-01 (mandat §13) : classification
    // RÉELLE au lieu d'un `failed_retryable` inconditionnel --
    // `getPaymentTransactionCorrelation` renvoie `PaymentServerRpcError`
    // précisément lorsque AUCUNE ligne de corrélation n'existe pour ce
    // (providerCode, providerReference) -- "impossible provider/
    // transaction correlation", l'exemple TERMINAL littéral du mandat.
    const classification = classifyProcessingError(err);
    return finalize(
      claimed,
      classification,
      classification === "failed_terminal" ? "CORRELATION_IMPOSSIBLE" : "CORRELATION_UNAVAILABLE"
    );
  }

  // Même discipline de comparaison numérique que payment-callback-
  // runtime.ts (V2-04) -- magnitude bornée numeric(12,2), aucune perte
  // de précision possible à cette échelle pour une simple comparaison.
  const authoritativeAmount = Number(correlation.amount);
  const authoritativeCurrency = correlation.currency.toUpperCase();
  const observedAmount = claimed.amount === null ? Number.NaN : Number(claimed.amount);
  const observedCurrency = (claimed.currency ?? "").toUpperCase();
  const matches =
    claimed.amount !== null &&
    claimed.currency !== null &&
    Number.isFinite(authoritativeAmount) &&
    Number.isFinite(observedAmount) &&
    observedAmount === authoritativeAmount &&
    observedCurrency === authoritativeCurrency;

  if (!matches) {
    // Montant/devise manquants ou divergents -- JAMAIS appliqué
    // (V2-04, INCHANGÉ). L'évènement reste durablement enregistré
    // (Stage A, déjà fait) -- terminal non-financier ici (mandat §21 :
    // "safe audited final state").
    return finalize(claimed, "ignored", "AMOUNT_CURRENCY_MISMATCH");
  }

  try {
    await confirmPaymentAttempt({
      providerCode: claimed.providerCode,
      providerReference: claimed.providerReference,
      status: "paid",
      authorizationReference: claimed.authorizationReference ?? undefined,
    });
  } catch (err) {
    // PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2 -- ferme
    // P3BV41-RECOVERY-STARVATION-01 (mandat §13). AVANT ce lot :
    // TOUJOURS `failed_retryable`, quelle que soit la cause -- un rejet
    // PERMANENT de `confirm_payment_attempt` (référence introuvable,
    // statut invalide -- voir DRAFT-lot-payment-p1-foundation.sql) créait
    // donc un évènement "poison" éligible pour toujours (avant ce lot,
    // sans même le bénéfice d'un délai). Classification RÉELLE :
    // `PaymentServerUnavailableError` (panne réseau/connectivité,
    // transitoire par construction) reste `failed_retryable`, éligible à
    // une FUTURE revendication APRÈS le délai de backoff (le bail est
    // relâché par cette même transition, PAYMENT P3-B5 v2, INCHANGÉ) --
    // crash matrix scénario F. `PaymentServerRpcError` (rejet
    // déterministe de la base -- "impossible provider/transaction
    // correlation" ou état incompatible) est désormais `failed_terminal`
    // -- rejouer ne changerait rien.
    const classification = classifyProcessingError(err);
    return finalize(
      claimed,
      classification,
      classification === "failed_terminal"
        ? "CONFIRM_ATTEMPT_PERMANENT_FAILURE"
        : "CONFIRM_ATTEMPT_TRANSIENT_FAILURE"
    );
  }

  // `confirmPaymentAttempt` est idempotent sous verrouillage terminal
  // (PAYMENT P1, INCHANGÉ) -- un rejeu qui atteint cette ligne alors
  // que la transaction est DÉJÀ `paid` (crash matrix scénario D :
  // mutation réussie AVANT un crash précédent, mais finalisation
  // d'inbox jamais atteinte) réussit ici comme un no-op sûr, jamais une
  // double application -- l'inbox atteint alors correctement `applied`.
  return finalize(claimed, "applied");
}
