import "server-only";
import { createHash } from "node:crypto";
import { recordStuartProviderEvent, type StuartProviderEventRecord } from "@/lib/server/delivery-providers/stuart/provider-events";

/**
 * STUART LOT D1 §E — WEBHOOK ROUTE FOUNDATION (2/3 : INGESTION).
 *
 * Reçoit un évènement DÉJÀ AUTHENTIFIÉ (voir `webhook-auth-adapter.ts`
 * -- ce module ne vérifie lui-même AUCUNE signature) et le persiste
 * durablement via `recordStuartProviderEvent`
 * (`stuart_provider_events`, mandat §D). SÉPARÉ du traitement
 * (`webhook-processor.ts`) -- l'ingestion ne fait QUE recevoir/
 * persister, jamais interpréter/appliquer un statut.
 *
 * FINGERPRINT (mandat, même discipline que
 * `payment-provider-event-fingerprint.ts`, PAYMENT P3-B5 v2) :
 * canonicalise D'ABORD les champs structurés reçus, PUIS calcule le
 * SHA-256 EXCLUSIVEMENT à partir de ces valeurs canoniques -- aucun
 * appelant ne peut fournir un fingerprint indépendant des champs
 * réellement envoyés (ce module n'accepte d'ailleurs AUCUN paramètre
 * de fingerprint externe).
 */

export interface RawStuartWebhookFields {
  providerEventType: string;
  providerJobIdRaw?: string | null;
  providerStatusRaw?: string | null;
  /** Corps brut COMPLET reçu (avant tout parsing applicatif) --
   *  INCLUS dans le calcul du fingerprint pour que deux livraisons
   *  distinctes portant les mêmes champs structurés mais un corps
   *  différent (ex. un identifiant d'évènement prestataire non encore
   *  modélisé structurellement) ne soient jamais confondues en un seul
   *  évènement logique. JAMAIS stocké tel quel dans
   *  `stuart_provider_events` (mandat §D, "no raw provider payload
   *  storage" -- décision explicite, même choix que
   *  payment_provider_events) -- utilisé UNIQUEMENT pour le calcul du
   *  fingerprint, jamais persisté. */
  rawBody: string;
}

function canonicalizeStuartWebhookFields(input: RawStuartWebhookFields): {
  providerEventType: string;
  providerJobIdRaw: string | null;
  providerStatusRaw: string | null;
  rawBody: string;
} {
  return {
    providerEventType: input.providerEventType.trim(),
    providerJobIdRaw: input.providerJobIdRaw ? input.providerJobIdRaw.trim() : null,
    providerStatusRaw: input.providerStatusRaw ? input.providerStatusRaw.trim() : null,
    rawBody: input.rawBody,
  };
}

function computeStuartWebhookEventFingerprint(canonical: {
  providerEventType: string;
  providerJobIdRaw: string | null;
  providerStatusRaw: string | null;
  rawBody: string;
}): string {
  const material = JSON.stringify([
    canonical.providerEventType,
    canonical.providerJobIdRaw,
    canonical.providerStatusRaw,
    canonical.rawBody,
  ]);
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * Canonicalise, calcule le fingerprint, puis persiste durablement
 * l'évènement via `record_stuart_provider_event`. Idempotent sous rejeu
 * exact (même corps brut -> même fingerprint -> `isNewEvent: false`).
 */
export async function ingestStuartWebhookEvent(input: RawStuartWebhookFields): Promise<StuartProviderEventRecord> {
  const canonical = canonicalizeStuartWebhookFields(input);
  const eventFingerprint = computeStuartWebhookEventFingerprint(canonical);
  return recordStuartProviderEvent({
    eventFingerprint,
    providerEventType: canonical.providerEventType,
    providerJobIdRaw: canonical.providerJobIdRaw,
    providerStatusRaw: canonical.providerStatusRaw,
  });
}
