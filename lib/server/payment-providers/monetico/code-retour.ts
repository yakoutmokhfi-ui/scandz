import "server-only";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3 — CLASSIFICATEUR
 * CODE-RETOUR CANONIQUE (ferme V2-05).
 *
 * POURQUOI CE MODULE EST SÉPARÉ ET NE MODIFIE PAS
 * lib/server/payment-providers/monetico/callback.ts (PAYMENT P3-A2,
 * déjà publié, INCHANGÉ) : `callback.ts` reste la seule autorité de
 * VÉRIFICATION MAC (`verifyMoneticoCallback`, réutilisée telle quelle
 * par ce lot) -- son mapping interne `mapCodeRetour` (privé, non
 * exporté) a été construit avec un modèle à 3 valeurs
 * (`MoneticoResultStatus = "paid"|"failed"|"pending"`) et un
 * comportement de repli délibérément conservateur ("toute valeur non
 * reconnue -> pending"), documenté et testé comme tel. Le mandat v3
 * (§18) exige un classificateur EXHAUSTIF à 4 valeurs distinguant
 * explicitement "connu comme non abouti" (refused) de "jamais observé
 * dans la documentation officielle" (unknown) -- un contrat DIFFÉRENT,
 * pas une correction du contrat existant. Plutôt que de redéfinir un
 * module déjà publié et déjà couvert par ses propres tests (violerait
 * la contrainte "ne jamais redéfinir un travail déjà livré sans défaut
 * prouvé"), ce fichier introduit un classificateur NOUVEAU et
 * SÉPARÉ : la couche d'orchestration v3 appelle
 * `verifyMoneticoCallback` UNIQUEMENT pour la vérification MAC et
 * l'extraction des champs (jamais pour son `.status`), puis reclasse
 * le `code-retour` brut via `classifyMoneticoCodeRetour` ci-dessous.
 *
 * RE-VÉRIFICATION FRAÎCHE (mandat §12, jamais une hypothèse héritée
 * d'une session précédente) : le document technique Monetico v2.0
 * (https://www.monetico.com/online/en/info/documentations/Monetico_Paiement_technical_documentation_v2.0.pdf,
 * §1.4.3.1, tableau des valeurs `code-retour`, p.26-35 -- même plage
 * effectivement atteinte et déjà citée par callback.ts/PAYMENT P3-A2)
 * documente EXACTEMENT les valeurs suivantes :
 *   - `payetest`            -> paiement accepté, BAC À SABLE uniquement.
 *   - `paiement`            -> paiement accepté, PRODUCTION uniquement.
 *   - `paiement_pf2`/`_pf3`/`_pf4` -> échéance 2, 3 ou 4 d'un paiement
 *     fractionné ACCEPTÉE. AUCUNE variante `paiement_pf1` n'existe
 *     dans le document -- la première échéance d'un paiement fractionné
 *     est rapportée via le code `paiement` de base, jamais un
 *     suffixe `_pf1` distinct.
 *   - `Annulation`          -> paiement REFUSÉ/annulé (le document
 *     utilise la CASSE CAPITALISÉE `Annulation` pour cette valeur de
 *     base -- PAS `annulation` tout en minuscules, à la différence de
 *     ce que `callback.ts`/`mapCodeRetour` teste actuellement pour son
 *     propre cas de base ; ceci N'EST PAS corrigé dans `callback.ts`
 *     par ce lot -- voir CODE-RETOUR-MATRIX-REPORT du paquet livré
 *     pour la divergence documentée sans être redéfinie).
 *   - `Annulation_pf2`/`_pf3`/`_pf4` -> échéance 2, 3 ou 4 d'un
 *     paiement fractionné REFUSÉE. AUCUNE variante `Annulation_pf1`
 *     n'existe, par le même raisonnement que pour `paiement_pf1`.
 *   - `attente_partenaire`  -> paiement EN ATTENTE d'une validation
 *     par un partenaire externe (ex. 3-D Secure asynchrone) --
 *     explicitement PAS un état terminal.
 *   - TOUTE AUTRE VALEUR, y compris `paiement_pf1`/`Annulation_pf1`
 *     (dont l'existence n'est PAS confirmée par le document) et toute
 *     valeur absente du document -> `unknown` -- posture FAIL-CLOSED
 *     explicite (mandat §18/§24 : "never treat an unverified value as
 *     paid or refused by default"). Une valeur `unknown` N'EST NI
 *     `paid` NI `refused` -- la couche d'orchestration l'enregistre
 *     via PAYMENT P3-B5 (`provider_event_type='unknown'`) et n'appelle
 *     JAMAIS `confirm_payment_attempt` pour elle, exactement comme
 *     pour `refused`/`pending`.
 *
 * §9.3/p.80 (canonicalisation MAC) reste INDÉPENDAMMENT non atteignable
 * (re-confirmé par une tentative fraîche, cohérent avec la
 * confidence de canonicalization.ts) -- SANS RAPPORT avec ce module,
 * qui ne touche jamais au calcul du MAC.
 *
 * FONCTION PURE, TOTALE (ne lève JAMAIS d'exception, y compris pour
 * une entrée vide/malformée -- renvoie `unknown` dans tous les cas non
 * reconnus) -- même politique que verifyMoneticoCallback (aucun effet
 * de bord).
 */

export type MoneticoCodeRetourClassification = "paid" | "refused" | "pending" | "unknown";

export interface ClassifiedMoneticoCodeRetour {
  /** Classification canonique v3 (4 valeurs) -- JAMAIS le `.status` à
   *  3 valeurs de callback.ts/PAYMENT P3-A2. */
  classification: MoneticoCodeRetourClassification;
  /** Valeur brute d'entrée, telle que reçue (jamais normalisée en
   *  casse -- la casse documentée est significative, voir en-tête). */
  codeRetour: string;
  /** true uniquement pour un code-retour _pf[2-4] reconnu (paid ou
   *  refused). false pour tout le reste, y compris `unknown`. */
  isSplitPaymentInstallment: boolean;
  /** Numéro d'échéance (2, 3 ou 4) si isSplitPaymentInstallment=true,
   *  sinon null. */
  splitInstallmentNumber: 2 | 3 | 4 | null;
}

const PAID_EXACT = new Set<string>(["payetest", "paiement"]);
const REFUSED_EXACT = new Set<string>(["Annulation"]);
const PENDING_EXACT = new Set<string>(["attente_partenaire"]);

// Exclusivement pf2/pf3/pf4 -- PAS [1-9] ni [2-9]+ : seules CES TROIS
// valeurs précises sont confirmées par le document v2.0 fraîchement
// re-vérifié. Toute variante non listée ICI (pf1, pf5, pf-quoi que ce
// soit d'autre) tombe délibérément dans `unknown`, jamais dans une
// correspondance regex générique optimiste.
const PAID_SPLIT_INSTALLMENT: Record<string, 2 | 3 | 4> = {
  paiement_pf2: 2,
  paiement_pf3: 3,
  paiement_pf4: 4,
};
const REFUSED_SPLIT_INSTALLMENT: Record<string, 2 | 3 | 4> = {
  Annulation_pf2: 2,
  Annulation_pf3: 3,
  Annulation_pf4: 4,
};

function unknownResult(codeRetour: string): ClassifiedMoneticoCodeRetour {
  return {
    classification: "unknown",
    codeRetour,
    isSplitPaymentInstallment: false,
    splitInstallmentNumber: null,
  };
}

export function classifyMoneticoCodeRetour(codeRetour: unknown): ClassifiedMoneticoCodeRetour {
  if (typeof codeRetour !== "string" || codeRetour.length === 0) {
    return unknownResult(typeof codeRetour === "string" ? codeRetour : "");
  }

  if (PAID_EXACT.has(codeRetour)) {
    return {
      classification: "paid",
      codeRetour,
      isSplitPaymentInstallment: false,
      splitInstallmentNumber: null,
    };
  }
  if (codeRetour in PAID_SPLIT_INSTALLMENT) {
    return {
      classification: "paid",
      codeRetour,
      isSplitPaymentInstallment: true,
      splitInstallmentNumber: PAID_SPLIT_INSTALLMENT[codeRetour],
    };
  }

  if (REFUSED_EXACT.has(codeRetour)) {
    return {
      classification: "refused",
      codeRetour,
      isSplitPaymentInstallment: false,
      splitInstallmentNumber: null,
    };
  }
  if (codeRetour in REFUSED_SPLIT_INSTALLMENT) {
    return {
      classification: "refused",
      codeRetour,
      isSplitPaymentInstallment: true,
      splitInstallmentNumber: REFUSED_SPLIT_INSTALLMENT[codeRetour],
    };
  }

  if (PENDING_EXACT.has(codeRetour)) {
    return {
      classification: "pending",
      codeRetour,
      isSplitPaymentInstallment: false,
      splitInstallmentNumber: null,
    };
  }

  // Inclut explicitement "paiement_pf1"/"Annulation_pf1" (aucune
  // variante _pf1 n'existe dans le document v2.0), "annulation" tout
  // en minuscules (casse non documentée pour la valeur de base --
  // callback.ts la teste par erreur, ce module ne réplique PAS cette
  // erreur), et toute valeur jamais documentée.
  return unknownResult(codeRetour);
}

/**
 * Convention `provider_event_type` v3 (documentée en tête de
 * DRAFT-lot-payment-p3b-monetico-checkout-runtime-v3.sql) --
 * dérivation MÉCANIQUE à partir de la classification ci-dessus,
 * jamais une seconde source de vérité indépendante.
 */
export function moneticoClassificationToProviderEventType(
  classification: MoneticoCodeRetourClassification
): "paid" | "refused" | "pending" | "unknown" {
  return classification;
}

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4 — COHÉRENCE MODE /
 * CODE-RETOUR (ferme P3B-V4-MODE-ENDPOINT-01, section 5 du mandat).
 *
 * RE-VÉRIFICATION FRAÎCHE (session v4, jamais une hypothèse héritée) :
 * le document technique v2.0 (§1.4.3.1, re-fetché indépendamment dans
 * cette session) confirme explicitement :
 *   - `payetest` : "paiement accepté (en « sandbox » uniquement)".
 *   - `paiement`/`paiement_pf[2-4]` : "paiement accepté ... (en
 *     Production uniquement)" pour la valeur de base -- AUCUNE
 *     variante `payetest_pf[2-4]` n'est documentée nulle part ; un
 *     paiement fractionné n'existe donc, par construction documentaire,
 *     QU'en Production. Traité ici comme Production-only, par la même
 *     discipline fail-closed déjà appliquée à `paiement_pf1` (jamais
 *     observé -> `unknown`, jamais supposé).
 *   - `Annulation`/`Annulation_pf[2-4]`/`attente_partenaire` :
 *     AUCUNE restriction sandbox/production n'est documentée pour ces
 *     valeurs -- compatibles avec les deux modes.
 *
 * Un `code-retour` `paid` INCOMPATIBLE avec le `mode` persisté P3-B4
 * du restaurant (ex. `payetest` reçu alors que `mode='live'`, ou
 * `paiement` reçu alors que `mode='test'`) est DÉGRADÉ ici en
 * `unknown` -- JAMAIS classifié `paid`, JAMAIS `refused` (on ne sait
 * réellement rien de fiable sur l'issue financière d'un évènement dont
 * l'environnement déclaré ne correspond pas), fail-closed (mandat
 * §5 : "Classify mismatch as non-paid/unknown/ignored"). `modeMismatch`
 * distingue explicitement ce cas d'un `unknown` "jamais documenté" pour
 * l'audit/la traçabilité, sans jamais changer le comportement
 * (`confirmPaymentAttempt` n'est de toute façon jamais appelé pour
 * `unknown`, mode-mismatch ou non).
 *
 * FONCTION PURE, TOTALE -- ne lève jamais, ne modifie jamais
 * `classifyMoneticoCodeRetour` (ci-dessus, INCHANGÉE, toujours
 * utilisée telle quelle par tout appelant existant qui n'a pas encore
 * de `mode` disponible).
 */
export interface ClassifiedMoneticoCodeRetourWithMode extends ClassifiedMoneticoCodeRetour {
  /** `true` UNIQUEMENT lorsque le code-retour brut correspondait à un
   *  motif `paid` connu mais a été DÉGRADÉ en `unknown` faute de
   *  compatibilité avec `mode` -- `false` dans tous les autres cas, y
   *  compris pour un `unknown` "jamais documenté" ordinaire. */
  modeMismatch: boolean;
}

const SANDBOX_ONLY_PAID_CODES = new Set<string>(["payetest"]);

function isProductionOnlyPaidCode(codeRetour: string): boolean {
  return (
    codeRetour === "paiement" ||
    codeRetour === "paiement_pf2" ||
    codeRetour === "paiement_pf3" ||
    codeRetour === "paiement_pf4"
  );
}

export function classifyMoneticoCodeRetourForMode(
  codeRetour: unknown,
  mode: "test" | "live"
): ClassifiedMoneticoCodeRetourWithMode {
  const base = classifyMoneticoCodeRetour(codeRetour);
  if (base.classification !== "paid") {
    return { ...base, modeMismatch: false };
  }

  const raw = base.codeRetour;
  const compatible =
    (mode === "test" && SANDBOX_ONLY_PAID_CODES.has(raw)) ||
    (mode === "live" && isProductionOnlyPaidCode(raw));

  if (compatible) {
    return { ...base, modeMismatch: false };
  }

  // Motif `paid` reconnu mais environnement incompatible -- dégradé
  // fail-closed, jamais appliqué comme paiement (mandat §5/§22).
  return {
    classification: "unknown",
    codeRetour: raw,
    isSplitPaymentInstallment: base.isSplitPaymentInstallment,
    splitInstallmentNumber: base.splitInstallmentNumber,
    modeMismatch: true,
  };
}
