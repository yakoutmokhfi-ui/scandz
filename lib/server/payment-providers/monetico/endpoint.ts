import "server-only";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.1 -- ferme
 * P3BV41-ENDPOINT-DOC-01 (audit de travail v4.1 indépendant, LOW) :
 * ce commentaire décrivait à l'origine (v3) une hypothèse "URL DE
 * SOUMISSION UNIQUE, IDENTIQUE pour le bac à sable ET la production",
 * affirmant que l'orchestration ne branchait JAMAIS sur `mode` pour
 * choisir une URL. Cette hypothèse s'est révélée INCORRECTE et a été
 * explicitement CORRIGÉE par le lot v4.1 (ferme
 * P3B-V4-MODE-ENDPOINT-01) juste en dessous : il existe bien DEUX URLs
 * de soumission DISTINCTES, une par mode persisté -- voir le
 * commentaire de `MONETICO_TEST_PAYMENT_SUBMISSION_URL` ci-dessous
 * pour la preuve complète et le détail de la correction. Ce
 * commentaire ne reformule donc plus la revendication "URL unique"
 * (fausse, obsolète) -- il documente uniquement CETTE constante,
 * `MONETICO_LIVE_PAYMENT_SUBMISSION_URL`, qui reste la valeur RÉELLE
 * et INCHANGÉE (le paiement.cgi de production), désormais résolue
 * exclusivement via `resolveMoneticoSubmissionUrl("live")` -- jamais
 * lue en isolation par l'orchestration (payment-checkout-runtime.ts).
 *
 * Cette constante reste délibérément confinée à
 * `lib/server/payment-providers/monetico/` (jamais dupliquée ni
 * inlinée ailleurs sous `lib/server/`) -- même discipline
 * architecturale déjà vérifiée structurellement par
 * tests/v110c-payment-p3a1-structural.test.ts pour toute autre
 * signature technique concrète (HMAC-SHA1, `TPE=`, `société=`,
 * calcul de MAC) : `lib/server/*` hors ce sous-dossier ne contient
 * JAMAIS un tel détail concret d'un prestataire donné.
 */
export const MONETICO_LIVE_PAYMENT_SUBMISSION_URL = "https://p.monetico-services.com/paiement.cgi";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.1 — ferme
 * P3B-V4-MODE-ENDPOINT-01 / correction finale mandat §16-§17 : deux
 * URLs de soumission DISTINCTES, une par mode persisté (jamais une
 * variable d'environnement globale).
 *
 * RE-VÉRIFICATION FRAÎCHE, RÉSULTAT DE CETTE SESSION (v4.1) : le texte
 * littéral des sous-sections 9.8.1/9.8.2 (p.123) du document technique
 * v2.0 reste, comme en v4, INACCESSIBLE à l'outil de récupération
 * documentaire disponible ici (troncature confirmée AVANT la page 123,
 * re-testée cette session, même symptôme que le rapport v4) — cette
 * limite d'outil est donc INCHANGÉE et honnêtement reportée à nouveau,
 * PAS contournée.
 *
 * Cependant, cette session a obtenu une preuve DIRECTE, distincte de la
 * simple prose tierce déjà écartée en v4 :
 *   1. Une requête directe (sans corps POST) vers
 *      https://p.monetico-services.com/test/paiement.cgi renvoie une
 *      page d'erreur Monetico authentique bilingue FR/EN ("Nous ne
 *      pouvons pas traiter votre demande de paiement car notre serveur
 *      n'a pas reçu de données." / "Your payment request cannot be
 *      processed because no data has been received by our server."),
 *      SUR LE DOMAINE DE PRODUCTION MONETICO LUI-MÊME
 *      (p.monetico-services.com) — pas un tiers, pas un miroir, pas une
 *      page 404 générique. Identique en forme à la même requête vers
 *      https://p.monetico-services.com/paiement.cgi (sans le segment
 *      /test/), qui renvoie la MÊME page d'erreur Monetico authentique.
 *      Les deux chemins sont donc des points de terminaison VIVANTS et
 *      DISTINCTS, servis par l'infrastructure Monetico réelle.
 *   2. Un module d'intégration CMCIC/Monetico open-source indépendant
 *      (github.com/nursit/bank, presta/cmcic/inc/cmcic.php, fonction
 *      cmcic_url_serveur()) contient une branche explicite : URL de
 *      base "https://p.monetico-services.com", segment "/test" ajouté
 *      SI ET SEULEMENT SI cmcic_is_sandbox($config) est vrai, puis
 *      "/paiement.cgi" concaténé dans les deux cas — exactement le
 *      patron des deux constantes ci-dessous.
 * Ces deux éléments, pris ensemble (endpoint réel qui répond en tant
 * que Monetico + code d'intégration tiers indépendant qui encode
 * exactement cette même distinction), constituent une CORROBORATION
 * FORTE bien qu'INDIRECTE (ni l'un ni l'autre n'est le texte littéral
 * de la section 9.8 elle-même). Le gap d'accès à la page 123 reste
 * donc noté comme LIMITE D'OUTIL CONNUE, jamais présenté comme résolu
 * — voir OFFICIAL-MONETICO-DOCUMENT-REPORT-v4.1.txt et
 * MODE-ENDPOINT-REPORT-v4.1.txt du paquet livré pour le détail complet
 * et les URLs de recherche consultées.
 *
 * `mode` (PAYMENT P3-B4, persisté, JAMAIS une variable d'environnement
 * globale) reste l'AUTORITÉ EXPLICITE et STRUCTURÉE de résolution --
 * fail-closed sur toute valeur hors `"test"`/`"live"`.
 */
export const MONETICO_TEST_PAYMENT_SUBMISSION_URL = "https://p.monetico-services.com/test/paiement.cgi";

/**
 * @deprecated Conservé UNIQUEMENT pour compatibilité descendante des
 * imports existants (v3/v4) qui référencent encore ce nom -- désigne
 * désormais explicitement l'URL LIVE/production (jamais utilisée pour
 * le mode "test" depuis ce lot v4.1). Les nouveaux appelants doivent
 * utiliser `resolveMoneticoSubmissionUrl(mode)` ou l'une des deux
 * constantes nommées par mode ci-dessus.
 */
export const MONETICO_PAYMENT_SUBMISSION_URL = MONETICO_LIVE_PAYMENT_SUBMISSION_URL;

export class MoneticoUnsupportedModeError extends Error {
  constructor(message = "MONETICO_UNSUPPORTED_MODE") {
    super(message);
    this.name = "MoneticoUnsupportedModeError";
  }
}

export function resolveMoneticoSubmissionUrl(mode: "test" | "live"): string {
  switch (mode) {
    case "test":
      return MONETICO_TEST_PAYMENT_SUBMISSION_URL;
    case "live":
      return MONETICO_LIVE_PAYMENT_SUBMISSION_URL;
    default:
      // Fail-closed explicite -- jamais un point de terminaison
      // financier deviné pour un mode non supporté (mandat §4 :
      // "Fail closed on any unsupported mode").
      throw new MoneticoUnsupportedModeError();
  }
}
