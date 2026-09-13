import "server-only";

/**
 * STUART LOT D1 §E — WEBHOOK ROUTE FOUNDATION (1/3 : ADAPTATEUR
 * D'AUTHENTIFICATION).
 *
 * Le contrat réel de signature/authentification des webhooks Stuart
 * N'EST PAS PROUVÉ à ce jour (mandat, littéral : "do NOT invent a
 * signature algorithm, do NOT claim Production webhook security
 * complete"). Ce module fournit UNIQUEMENT le point d'extension --
 * séparé de l'ingestion (`webhook-ingestion.ts`) et du traitement
 * (`webhook-processor.ts`), mandat §E, "so auth can be completed later
 * without redesign" -- jamais une implémentation réelle.
 *
 * `NON_LIVE_STUART_WEBHOOK_AUTH_ADAPTER` est l'adaptateur PAR DÉFAUT et
 * SEUL fourni par ce lot : il REJETTE INCONDITIONNELLEMENT toute
 * requête (`authenticated: false`), quel que soit son contenu -- fail
 * closed explicite. Un futur D2, une fois le contrat de signature réel
 * documenté/confirmé, fournira un adaptateur DIFFÉRENT implémentant
 * `StuartWebhookAuthAdapter` -- AUCUNE modification de l'ingestion ni
 * du traitement ne sera nécessaire pour ce faire.
 */

export interface StuartWebhookAuthResult {
  authenticated: boolean;
  /** Motif court, JAMAIS une pile d'appel/un secret -- diagnostic
   *  interne uniquement. */
  reason?: string;
}

export interface StuartWebhookAuthAdapter {
  verify(rawBody: string, headers: Readonly<Record<string, string>>): Promise<StuartWebhookAuthResult> | StuartWebhookAuthResult;
}

/**
 * Adaptateur NON-LIVE -- rejette INCONDITIONNELLEMENT. C'est
 * l'adaptateur utilisé par `app/api/internal/stuart/webhook/route.ts`
 * tant qu'aucun contrat de signature réel n'est fourni -- garantit
 * structurellement qu'aucune requête externe non authentifiée ne peut
 * jamais atteindre l'ingestion via CE chemin (mandat, "do NOT expose an
 * unauthenticated Production mutation endpoint").
 */
export const NON_LIVE_STUART_WEBHOOK_AUTH_ADAPTER: StuartWebhookAuthAdapter = {
  verify(): StuartWebhookAuthResult {
    return { authenticated: false, reason: "STUART_WEBHOOK_AUTH_CONTRACT_NOT_PROVEN" };
  },
};
