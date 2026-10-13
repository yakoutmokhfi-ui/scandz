import "server-only";

/**
 * MONETICO PAYMENT SIMULATOR v1 — DETERMINISTIC SCENARIO CATALOG.
 *
 * Each scenario is a PLAN: an ordered list of server-to-server
 * notifications ("steps") the simulator will send to the REAL
 * application callback route, plus the browser redirect Monetico would
 * perform afterwards. Every step maps to a REAL documented `code-retour`
 * (see code-retour.ts): the simulator never invents provider semantics,
 * it only chooses WHICH documented outcome to emit and whether to
 * corrupt the message on purpose (bad MAC, tampered amount/currency) to
 * exercise the application's defenses.
 *
 * `expected` documents the application outcome the integrated tests
 * assert (tests/v163-*.test.ts). It is documentation, never read at
 * runtime.
 *
 * Scenario ids are the ONLY accepted selector; they are validated against
 * this catalog (`resolveScenario`) -- any unknown id is rejected.
 */

export interface SimulatedNotificationStep {
  /** Documented Monetico `code-retour` to emit. */
  codeRetour: string;
  /** Corrupt the MAC on purpose (application must ACK cdr=1, record nothing). */
  corruptMac?: boolean;
  /** Add this many EUR cents to the authoritative amount (MAC stays valid). */
  amountTamperCents?: number;
  /** Replace the currency (MAC stays valid). */
  currencyOverride?: string;
}

export interface ScenarioPlan {
  id: ScenarioId;
  label: string;
  description: string;
  steps: SimulatedNotificationStep[];
  /** Which merchant return URL the browser is sent to afterwards. */
  redirect: "ok" | "err";
  /** Number of leading delivery attempts the notifier deliberately treats
   *  as a provider-side timeout (no HTTP call made) before the real
   *  delivery -- exercises the bounded retry policy deterministically. */
  simulatedTransportFailures: number;
  expected: string;
}

export const SCENARIO_IDS = [
  "paid",
  "refused",
  "pending_partner",
  "abandoned",
  "delayed_confirmation",
  "unknown_code",
  "mode_mismatch",
  "bad_mac",
  "amount_tamper",
  "currency_tamper",
  "duplicate_paid",
  "refused_then_paid",
  "paid_then_refused",
  "provider_timeout_retry",
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

const PAID: SimulatedNotificationStep = { codeRetour: "payetest" };
const REFUSED: SimulatedNotificationStep = { codeRetour: "Annulation" };

const CATALOG: Record<ScenarioId, ScenarioPlan> = {
  paid: {
    id: "paid",
    label: "Paiement accepté (bac à sable)",
    description: "Monetico notifie `payetest` avec un numéro d'autorisation, puis redirige vers url_retour_ok.",
    steps: [PAID],
    redirect: "ok",
    simulatedTransportFailures: 0,
    expected: "applied_paid — payment_transactions.status=paid, orders.payment_status=paid, inbox applied.",
  },
  refused: {
    id: "refused",
    label: "Paiement refusé",
    description: "Monetico notifie `Annulation` avec un motif de refus, puis redirige vers url_retour_err.",
    steps: [REFUSED],
    redirect: "err",
    simulatedTransportFailures: 0,
    expected: "recorded_refused — inbox ignored, attempt stays pending (resumable), confirm_payment_attempt never called.",
  },
  pending_partner: {
    id: "pending_partner",
    label: "En attente du partenaire",
    description: "Monetico notifie `attente_partenaire` ; le paiement n'est ni accepté ni refusé.",
    steps: [{ codeRetour: "attente_partenaire" }],
    redirect: "ok",
    simulatedTransportFailures: 0,
    expected: "recorded_pending — inbox ignored, attempt stays pending.",
  },
  abandoned: {
    id: "abandoned",
    label: "Abandon client",
    description: "Le client ferme la page : AUCUNE notification S2S, simple redirection vers url_retour_err.",
    steps: [],
    redirect: "err",
    simulatedTransportFailures: 0,
    expected: "no event — attempt stays pending, a second checkout call RESUMES the same reference (P3-B3).",
  },
  delayed_confirmation: {
    id: "delayed_confirmation",
    label: "Confirmation différée",
    description:
      "Le navigateur revient sur url_retour_ok AVANT toute notification S2S ; la page de retour doit afficher 'en attente'. Rejouer ensuite le scénario `paid` sur la même référence fait converger.",
    steps: [],
    redirect: "ok",
    simulatedTransportFailures: 0,
    expected: "return page reads pending (never paid from a redirect alone); later `paid` S2S converges via callback or recovery worker.",
  },
  unknown_code: {
    id: "unknown_code",
    label: "Code-retour inconnu",
    description: "Monetico notifie un code-retour non documenté.",
    steps: [{ codeRetour: "xyz_unexpected" }],
    redirect: "err",
    simulatedTransportFailures: 0,
    expected: "recorded_unknown — never applied.",
  },
  mode_mismatch: {
    id: "mode_mismatch",
    label: "Code de PRODUCTION reçu en mode test",
    description: "Monetico notifie `paiement` (code production) alors que le marchand est en mode `test`.",
    steps: [{ codeRetour: "paiement" }],
    redirect: "ok",
    simulatedTransportFailures: 0,
    expected: "recorded_mode_mismatch — degraded to unknown BEFORE recording, never applied.",
  },
  bad_mac: {
    id: "bad_mac",
    label: "MAC invalide",
    description: "Notification `payetest` dont le MAC est corrompu (attaque / clé erronée).",
    steps: [{ ...PAID, corruptMac: true }],
    redirect: "ok",
    simulatedTransportFailures: 0,
    expected: "ACK cdr=1, NOTHING recorded, attempt stays pending.",
  },
  amount_tamper: {
    id: "amount_tamper",
    label: "Montant altéré (MAC valide)",
    description: "Notification `payetest` signée correctement mais dont le montant diffère de la tentative.",
    steps: [{ ...PAID, amountTamperCents: 100 }],
    redirect: "ok",
    simulatedTransportFailures: 0,
    expected: "recorded paid, Stage B ignored/AMOUNT_CURRENCY_MISMATCH, never applied.",
  },
  currency_tamper: {
    id: "currency_tamper",
    label: "Devise altérée (MAC valide)",
    description: "Notification `payetest` signée correctement mais en USD.",
    steps: [{ ...PAID, currencyOverride: "USD" }],
    redirect: "ok",
    simulatedTransportFailures: 0,
    expected: "recorded paid, Stage B ignored/AMOUNT_CURRENCY_MISMATCH, never applied.",
  },
  duplicate_paid: {
    id: "duplicate_paid",
    label: "Notification dupliquée",
    description: "Monetico envoie DEUX fois la même notification `payetest` (rejeu).",
    steps: [PAID, PAID],
    redirect: "ok",
    simulatedTransportFailures: 0,
    expected: "first applied_paid; second isNewEvent=false (fingerprint replay), single confirm, idempotent.",
  },
  refused_then_paid: {
    id: "refused_then_paid",
    label: "Refus puis acceptation",
    description: "Ordre des notifications : `Annulation` puis `payetest` sur la même référence.",
    steps: [REFUSED, PAID],
    redirect: "ok",
    simulatedTransportFailures: 0,
    expected: "refused ignored (attempt stays pending), then paid applied — ordering preserved.",
  },
  paid_then_refused: {
    id: "paid_then_refused",
    label: "Acceptation puis refus tardif",
    description: "Ordre des notifications : `payetest` puis `Annulation` tardive.",
    steps: [PAID, REFUSED],
    redirect: "ok",
    simulatedTransportFailures: 0,
    expected: "paid applied; late refused recorded and ignored — terminal lock-in untouched.",
  },
  provider_timeout_retry: {
    id: "provider_timeout_retry",
    label: "Timeout prestataire puis nouvelle tentative",
    description: "Les deux premières tentatives de notification expirent côté prestataire ; la troisième aboutit.",
    steps: [PAID],
    redirect: "ok",
    simulatedTransportFailures: 2,
    expected: "notifier attempts=3, delivered once, applied_paid; a notifier that exhausts its budget reports delivered=false without throwing.",
  },
};

export function listScenarios(): ReadonlyArray<ScenarioPlan> {
  return SCENARIO_IDS.map((id) => CATALOG[id]);
}

/** Strict resolution -- unknown/non-string ids are rejected, never defaulted. */
export function resolveScenario(id: unknown): ScenarioPlan | null {
  if (typeof id !== "string") return null;
  return (SCENARIO_IDS as readonly string[]).includes(id) ? CATALOG[id as ScenarioId] : null;
}
