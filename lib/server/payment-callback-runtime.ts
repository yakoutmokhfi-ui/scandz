import "server-only";
import type { MoneticoCallbackRawFields } from "@/lib/server/payment-providers/monetico/types";
import {
  parseMoneticoCallback,
  verifyMoneticoCallback,
} from "@/lib/server/payment-providers/monetico/callback";
import { buildMoneticoAcknowledgement } from "@/lib/server/payment-providers/monetico/ack";
import { parseMoneticoCredential } from "@/lib/server/payment-providers/monetico/credentials";
import { classifyMoneticoCodeRetourForMode } from "@/lib/server/payment-providers/monetico/code-retour";
import {
  getPaymentTransactionCorrelation,
  getPaymentProviderCredential,
  getPaymentRuntimeProviderEnvironment,
  recordPaymentProviderEvent,
  claimPaymentProviderEventById,
} from "@/lib/server/payment-service";
import { processClaimedPaymentProviderEvent } from "@/lib/server/payment-provider-event-processor";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4 — CALLBACK PROCESSING
 * ORCHESTRATION (interface "Retour").
 *
 * RESTRUCTURATION v4 EN DEUX ÉTAPES EXPLICITES (ferme
 * P3B-V3-ACK-RECOVERY-01, mandat §15-§19) :
 *
 *   STAGE A -- INGESTION : analyse structurelle, corrélation,
 *   credential + VÉRIFICATION MAC RÉELLE, classification v4
 *   MODE-AWARE (`classifyMoneticoCodeRetourForMode` -- ferme
 *   P3B-V3-MODE-ENDPOINT-01, un `paid` dont le code-retour est
 *   incompatible avec le `mode` persisté P3-B4 est DÉGRADÉ en
 *   `unknown` AVANT même l'enregistrement durable, jamais appliqué),
 *   enregistrement DURABLE (PAYMENT P3-B5, TOUJOURS, pour les 4
 *   classifications), PUIS ACK -- INCHANGÉ dans son principe (V2-03 :
 *   ACK basé UNIQUEMENT sur MAC valide + preuve durable acquise,
 *   JAMAIS sur le succès d'un traitement métier ultérieur).
 *
 *   STAGE B -- TRAITEMENT DURABLE (`payment-provider-event-processor.ts`,
 *   PARTAGÉ avec le futur worker de reprise, mandat §17 : "do not
 *   create a second processing implementation") : tentée
 *   SYNCHRONEMENT ici, immédiatement après un enregistrement durable
 *   réussi, via `claimPaymentProviderEventById` (revendication CIBLÉE
 *   sur l'évènement qu'on vient d'enregistrer, jamais le lot générique)
 *   puis `processClaimedPaymentProviderEvent`. Une revendication VIDE
 *   (évènement déjà terminal -- rejeu, ou déjà en cours de traitement
 *   ailleurs) est un résultat NORMAL, jamais une erreur : rien de plus
 *   à faire ici, l'évènement est soit déjà traité, soit sous la
 *   responsabilité d'un autre traitement en cours.
 *
 * L'ACK NE DÉPEND JAMAIS DU RÉSULTAT DE STAGE B (invariant central,
 * mandat §19 : "positive ACK is allowed only once the authenticated
 * notification is durable enough... crash after claim... crash after
 * paid application but before inbox finalization... prove idempotent
 * recovery") -- un STAGE B en échec transitoire (`failed_retryable`)
 * ou une perte de course sûre (`stale_claim`) reste TOUJOURS un ACK
 * succès : l'évènement demeure durablement disponible pour une future
 * revendication (par ce même chemin synchrone lors d'un rejeu exact,
 * OU par le worker de reprise par lot), Monetico ne doit JAMAIS
 * recevoir un ACK d'échec pour une panne interne qui lui est
 * étrangère.
 *
 * DÉCISION ARCHITECTURALE PRÉSERVÉE (v3, INCHANGÉE) — KILL SWITCH NON
 * APPLIQUÉ ICI : `PAYMENT_CHECKOUT_RUNTIME_ENABLED` gate UNIQUEMENT
 * l'INITIATION d'un NOUVEAU checkout. Traiter un callback authentique
 * reste TOUJOURS actif, indépendamment de ce commutateur.
 *
 * ORDRE CRITIQUE CORRÉLATION → CREDENTIAL → VÉRIFICATION MAC --
 * INCHANGÉ (v3).
 *
 * RÈGLES DURES v3 PRÉSERVÉES SANS EXCEPTION (appliquées maintenant à
 * la fois par la classification mode-aware de Stage A ET par
 * `processClaimedPaymentProviderEvent`, Stage B) :
 *   - `refused` N'APPELLE JAMAIS `confirmPaymentAttempt('failed')`.
 *   - `unknown` (y compris un mode-mismatch dégradé) N'APPELLE JAMAIS
 *     `confirmPaymentAttempt`.
 *   - `pending` N'APPELLE JAMAIS `confirmPaymentAttempt`.
 *   - Seul `paid`, mode-compatible, AVEC montant/devise autoritatifs
 *     correspondants, appelle `confirmPaymentAttempt('paid')`.
 */

const PROVIDER_CODE = "monetico";

export type MoneticoCallbackProcessingOutcome =
  | "malformed"
  | "unrecognized_reference"
  | "mac_invalid"
  | "record_failed"
  | "recorded_refused"
  | "recorded_pending"
  | "recorded_unknown"
  | "recorded_mode_mismatch"
  | "applied_paid"
  | "recorded_paid_not_yet_applied";

export interface ProcessMoneticoCallbackResult {
  /** Octets EXACTS à renvoyer tels quels en `text/plain`. */
  ack: string;
  outcome: MoneticoCallbackProcessingOutcome;
  /** Absent uniquement pour `malformed`/`unrecognized_reference`/
   *  `mac_invalid`/`record_failed`. */
  eventId?: string;
  isNewEvent?: boolean;
}

/**
 * Format Monetico documenté du champ `montant` --
 * "[0-9]+(\.[0-9]{1,2})?[A-Z]{3}" (v2.0 §1.4.2.2, p.12). Fonction PURE,
 * ne lève jamais.
 */
function parseMoneticoMontant(raw: string): { amount: string; currency: string } | null {
  const match = /^(\d+(?:\.\d{1,2})?)([A-Z]{3})$/.exec(raw);
  if (!match) return null;
  return { amount: match[1], currency: match[2] };
}

export async function processMoneticoCallback(
  raw: MoneticoCallbackRawFields
): Promise<ProcessMoneticoCallbackResult> {
  // Étape 1 -- analyse STRUCTURELLE seule.
  let parsed: { fields: Record<string, string>; mac: string };
  try {
    parsed = parseMoneticoCallback(raw);
  } catch {
    return { ack: buildMoneticoAcknowledgement(false), outcome: "malformed" };
  }

  const unauthenticatedReference = parsed.fields["reference"];

  // Étape 2 -- corrélation (lecture pure, sûre avant authentification).
  let correlation: Awaited<ReturnType<typeof getPaymentTransactionCorrelation>>;
  try {
    correlation = await getPaymentTransactionCorrelation({
      providerCode: PROVIDER_CODE,
      providerReference: unauthenticatedReference,
    });
  } catch {
    return { ack: buildMoneticoAcknowledgement(false), outcome: "unrecognized_reference" };
  }

  // Étape 3 -- credential marchand puis VÉRIFICATION MAC RÉELLE.
  let credential: ReturnType<typeof parseMoneticoCredential>;
  try {
    const credentialRaw = await getPaymentProviderCredential({
      restaurantId: correlation.restaurantId,
      providerCode: PROVIDER_CODE,
    });
    credential = parseMoneticoCredential(credentialRaw);
  } catch {
    return { ack: buildMoneticoAcknowledgement(false), outcome: "unrecognized_reference" };
  }

  let verified: ReturnType<typeof verifyMoneticoCallback>;
  try {
    verified = verifyMoneticoCallback(raw, credential);
  } catch {
    return { ack: buildMoneticoAcknowledgement(false), outcome: "mac_invalid" };
  }

  // Étape 3bis (PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4, ferme
  // P3B-V3-MODE-ENDPOINT-01) -- `mode` AUTORITAIRE P3-B4 pour la
  // classification MODE-AWARE ci-dessous. Une panne à cette lecture
  // (environnement disparu entre-temps) est traitée comme une panne
  // fermée : impossible de classifier de façon sûre sans connaître le
  // mode -- même politique de repli que `unrecognized_reference` (rien
  // enregistré, ACK échec, Monetico réessaiera).
  let mode: "test" | "live";
  try {
    const environment = await getPaymentRuntimeProviderEnvironment({
      restaurantId: correlation.restaurantId,
      providerCode: PROVIDER_CODE,
    });
    mode = environment.mode;
  } catch {
    return { ack: buildMoneticoAcknowledgement(false), outcome: "unrecognized_reference" };
  }

  // Étape 4 -- classification v4 MODE-AWARE (ferme P3B-V3-MODE-ENDPOINT-01).
  // JAMAIS `verified.status` (mapping hérité 3 valeurs, PAYMENT P3-A2).
  const classified = classifyMoneticoCodeRetourForMode(verified.codeRetour, mode);
  const providerEventType = classified.classification;
  const parsedMontant = verified.rawMontant ? parseMoneticoMontant(verified.rawMontant) : null;

  // Étape 5 (V2-03) -- enregistrement DURABLE, TOUJOURS, AVANT tout ACK
  // positif -- pour LES QUATRE classifications (mode-mismatch inclus,
  // enregistré comme `unknown`, jamais silencieusement perdu -- l'audit
  // reste possible via `provider_event_code` brut préservé tel quel).
  let recorded: Awaited<ReturnType<typeof recordPaymentProviderEvent>>;
  try {
    recorded = await recordPaymentProviderEvent({
      providerCode: PROVIDER_CODE,
      providerReference: verified.providerReference,
      providerEventType,
      providerEventCode: verified.codeRetour,
      amount: parsedMontant?.amount,
      currency: parsedMontant?.currency,
      authorizationReference: verified.authorizationReference ?? undefined,
    });
  } catch {
    return { ack: buildMoneticoAcknowledgement(false), outcome: "record_failed" };
  }

  if (providerEventType !== "paid") {
    const outcome: MoneticoCallbackProcessingOutcome = classified.modeMismatch
      ? "recorded_mode_mismatch"
      : providerEventType === "refused"
        ? "recorded_refused"
        : providerEventType === "pending"
          ? "recorded_pending"
          : "recorded_unknown";
    // Stage B (mandat §21 : ne jamais laisser un évènement traité avec
    // succès indéfiniment `received`) -- tentative synchrone de
    // finalisation non-financière. Best-effort : son résultat n'a
    // AUCUNE incidence sur l'ACK (déjà acquis via l'enregistrement
    // durable ci-dessus) ni sur `outcome` renvoyé à l'appelant HTTP --
    // un worker de reprise reste le filet de sécurité si cette
    // tentative synchrone échoue elle-même.
    try {
      const claimed = await claimPaymentProviderEventById({ eventId: recorded.id });
      if (claimed) {
        await processClaimedPaymentProviderEvent(claimed);
      }
    } catch {
      // Jamais remonté -- voir le commentaire ci-dessus.
    }
    return {
      ack: buildMoneticoAcknowledgement(true),
      outcome,
      eventId: recorded.id,
      isNewEvent: recorded.isNewEvent,
    };
  }

  // Étape 6 -- Stage B SYNCHRONE pour `paid` (ferme
  // P3B-V3-ACK-RECOVERY-01) : revendication CIBLÉE sur l'évènement
  // qu'on vient d'enregistrer, puis traitement PARTAGÉ (même fonction
  // que le futur worker de reprise) -- vérifie corrélation/montant/
  // devise AUTORITATIFS et applique `confirmPaymentAttempt('paid')`
  // uniquement si tout correspond. AUCUNE incidence sur l'ACK, déjà
  // acquis (V2-03).
  let claimed: Awaited<ReturnType<typeof claimPaymentProviderEventById>> = null;
  try {
    claimed = await claimPaymentProviderEventById({ eventId: recorded.id });
  } catch {
    claimed = null;
  }

  if (!claimed) {
    // Rejeu d'un évènement déjà terminal, OU déjà revendiqué ailleurs
    // (traitement concurrent en cours) -- résultat NORMAL, jamais une
    // erreur. L'ACK reste un succès (preuve durable déjà acquise) ; le
    // worker de reprise (ou le traitement concurrent en cours) reste
    // seul responsable de la finalisation le cas échéant.
    return {
      ack: buildMoneticoAcknowledgement(true),
      outcome: "recorded_paid_not_yet_applied",
      eventId: recorded.id,
      isNewEvent: recorded.isNewEvent,
    };
  }

  const processed = await processClaimedPaymentProviderEvent(claimed);

  return {
    ack: buildMoneticoAcknowledgement(true),
    outcome: processed.outcome === "applied" ? "applied_paid" : "recorded_paid_not_yet_applied",
    eventId: recorded.id,
    isNewEvent: recorded.isNewEvent,
  };
}
