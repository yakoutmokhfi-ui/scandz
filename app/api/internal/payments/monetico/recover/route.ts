import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { claimPaymentProviderEvents } from "@/lib/server/payment-service";
import { processClaimedPaymentProviderEvent } from "@/lib/server/payment-provider-event-processor";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4 — WORKER DE REPRISE
 * (ferme P3B-V3-ACK-RECOVERY-01, mandat §18).
 *
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.4 -- ferme
 * P3BV43-RECOVERY-ACTIVATION-01 : cette route dispose désormais d'une
 * configuration de planification RÉUTILISABLE (voir vercel.json,
 * cron pointant vers CETTE route) -- réutilise EXACTEMENT le même
 * processeur (`payment-provider-event-processor.ts`) que le chemin
 * synchrone (`payment-callback-runtime.ts`), jamais une seconde
 * implémentation de traitement métier (mandat §8/§17, INCHANGÉ).
 *
 * GOUVERNANCE (mandat v4.4 §15, STRICTE) : la configuration
 * `vercel.json` livrée dans CE PAQUET DE DÉVELOPPEMENT rend le
 * scheduler DÉPLOYABLE/AUDITABLE -- elle ne l'ACTIVE PAS en
 * Production tant qu'aucun déploiement Production réel de ce paquet
 * n'a eu lieu (interdit explicitement par la gouvernance de ce lot,
 * section 25 : "DO NOT... push/PR/merge/deploy/activate Production
 * scheduler"). L'activation Production réelle appartient exclusivement
 * à une étape POST-GO CIO, hors du périmètre de ce paquet.
 *
 * AUTHENTIFIÉ, JAMAIS PUBLIC (mandat §18/§10 : "no public
 * unauthenticated processing trigger") -- DEUX mécanismes, désormais
 * STRICTEMENT SÉPARÉS PAR VERBE HTTP (ferme
 * P3BV44-CRON-AUTH-SEPARATION-01) :
 *   1. GET (planifié) : UNIQUEMENT en-tête
 *      `Authorization: Bearer <CRON_SECRET>` comparé à `CRON_SECRET`
 *      -- convention NATIVE de Vercel Cron. JAMAIS accepté avec le
 *      secret manuel, même correctement configuré.
 *   2. POST (manuel) : UNIQUEMENT en-tête
 *      `X-Payment-Recovery-Worker-Secret` comparé à
 *      `PAYMENT_RECOVERY_WORKER_SECRET`. JAMAIS accepté avec
 *      CRON_SECRET, même fourni en tant que Bearer.
 * AUCUN des deux secrets n'est le secret Monetico (MAC) ni le
 * `public_token` client (mandat §10/§14, littéral).
 * FAIL-CLOSED explicite : secret serveur absent, OU en-tête absent,
 * OU en-tête ne correspondant pas EXACTEMENT au mécanisme attendu
 * POUR CE VERBE -> 503, AUCUN appel RPC ne se produit. Aucun secret
 * n'apparaît jamais dans une URL (mandat §18/§10 : "no secrets in
 * URL") -- en-tête uniquement, jamais un
 * paramètre de requête.
 *
 * `runtime = "nodejs"` -- `node:crypto` transitif (comparaison en
 * temps constant), même règle que le reste de l'adaptateur Monetico.
 */
export const runtime = "nodejs";

const SECRET_HEADER = "x-payment-recovery-worker-secret";
const AUTHORIZATION_HEADER = "authorization";
const BEARER_PREFIX = "Bearer ";
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_LEASE_SECONDS = 60;

function timingSafeStringEqual(a: string, b: string): boolean {
  // `timingSafeEqual` exige des tampons de MÊME longueur -- une
  // comparaison de longueurs différente reste, par construction,
  // observable en temps (une chaîne plus courte échoue plus vite),
  // mais ne fuit RIEN sur le contenu du secret lui-même (seule fuite
  // tolérée ici : la LONGUEUR du secret configuré, jamais sa valeur).
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.4 -- ferme
 * P3BV43-RECOVERY-ACTIVATION-01 (volet authentification).
 *
 * Vérifie le mécanisme MANUEL historique (en-tête personnalisé,
 * INCHANGÉ depuis v4) -- jamais modifié pour ce lot.
 */
function isAuthorizedByManualSecret(request: NextRequest): boolean {
  const configured = process.env.PAYMENT_RECOVERY_WORKER_SECRET;
  if (typeof configured !== "string" || configured.length === 0) {
    return false;
  }
  const provided = request.headers.get(SECRET_HEADER);
  if (typeof provided !== "string" || provided.length === 0) {
    return false;
  }
  return timingSafeStringEqual(provided, configured);
}

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.4 -- ferme
 * P3BV43-RECOVERY-ACTIVATION-01 (volet authentification).
 *
 * Vérifie la convention NATIVE de Vercel Cron : en-tête
 * `Authorization: Bearer <CRON_SECRET>`, injecté automatiquement par
 * Vercel pour toute invocation PLANIFIÉE (jamais manuelle) lorsque la
 * variable d'environnement `CRON_SECRET` est configurée sur le
 * projet. `CRON_SECRET` est un secret DÉDIÉ au scheduler,
 * STRUCTURELLEMENT DISTINCT de `PAYMENT_RECOVERY_WORKER_SECRET`
 * (mécanisme manuel, ci-dessus), du secret MAC Monetico (jamais
 * référencé dans ce fichier), et du `public_token` client (jamais
 * référencé dans ce fichier) -- mandat §10, littéral : "scheduler
 * secret is NOT Monetico MAC key... Do not use customer
 * public_token."
 */
function isAuthorizedByCronSecret(request: NextRequest): boolean {
  const configured = process.env.CRON_SECRET;
  if (typeof configured !== "string" || configured.length === 0) {
    return false;
  }
  const provided = request.headers.get(AUTHORIZATION_HEADER);
  if (typeof provided !== "string" || !provided.startsWith(BEARER_PREFIX)) {
    return false;
  }
  const token = provided.slice(BEARER_PREFIX.length);
  if (token.length === 0) {
    return false;
  }
  return timingSafeStringEqual(token, configured);
}

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.5 -- ferme
 * P3BV44-CRON-AUTH-SEPARATION-01.
 *
 * AVANT ce lot : isAuthorized() acceptait indifféremment L'UN OU
 * L'AUTRE mécanisme (OR), quel que soit le VERBE HTTP utilisé --
 * signifiait qu'une requête GET portant l'en-tête manuel
 * (X-Payment-Recovery-Worker-Secret) était acceptée à tort, et
 * qu'une requête POST portant Authorization: Bearer <CRON_SECRET>
 * l'était ÉGALEMENT à tort. Le mandat §12 l'exige explicitement :
 * "Forbidden: GET + worker secret → accepted" et "Forbidden: POST +
 * CRON_SECRET → accepted unless separately and explicitly designed."
 *
 * v4.5 : SÉPARATION STRICTE PAR VERBE -- GET n'accepte JAMAIS le
 * secret manuel, POST n'accepte JAMAIS CRON_SECRET. Chaque handler
 * HTTP passe SA PROPRE fonction de vérification exclusive à
 * l'implémentation partagée -- aucun helper commun ne peut jamais
 * autoriser les deux mécanismes pour un même verbe (mandat §13,
 * littéral : "No shared helper may accidentally authorize both
 * mechanisms").
 */
type AuthCheck = (request: NextRequest) => boolean;

/**
 * Implémentation UNIQUE du TRAITEMENT MÉTIER, partagée par les deux
 * verbes HTTP (mandat §8 : "Reuse the SAME Stage B processing
 * implementation. Do not create a second payment-event processor") --
 * mais l'AUTHENTIFICATION elle-même reste STRICTEMENT paramétrée par
 * l'appelant, jamais partagée entre les deux mécanismes.
 */
async function handleRecoveryInvocation(request: NextRequest, authCheck: AuthCheck): Promise<NextResponse> {
  if (!authCheck(request)) {
    return NextResponse.json({ outcome: "unavailable" }, { status: 503 });
  }

  let claimed: Awaited<ReturnType<typeof claimPaymentProviderEvents>>;
  try {
    claimed = await claimPaymentProviderEvents({
      batchSize: DEFAULT_BATCH_SIZE,
      leaseSeconds: DEFAULT_LEASE_SECONDS,
    });
  } catch {
    return NextResponse.json({ outcome: "unavailable" }, { status: 502 });
  }

  const results = {
    claimed: claimed.length,
    applied: 0,
    ignored: 0,
    failedRetryable: 0,
    failedTerminal: 0,
    staleClaim: 0,
    finalizeRejectedTransition: 0,
    finalizeFailedTransient: 0,
  };

  for (const event of claimed) {
    const processed = await processClaimedPaymentProviderEvent(event);
    switch (processed.outcome) {
      case "applied":
        results.applied += 1;
        break;
      case "ignored":
        results.ignored += 1;
        break;
      case "failed_retryable":
        results.failedRetryable += 1;
        break;
      case "failed_terminal":
        results.failedTerminal += 1;
        break;
      case "stale_claim":
        results.staleClaim += 1;
        break;
      case "finalize_rejected_transition":
        results.finalizeRejectedTransition += 1;
        break;
      case "finalize_failed_transient":
        results.finalizeFailedTransient += 1;
        break;
    }
  }

  return NextResponse.json({ outcome: "ok", ...results }, { status: 200 });
}

/**
 * Invocation PLANIFIÉE (Vercel Cron -- voir vercel.json). Vercel émet
 * systématiquement une requête GET pour les jobs cron. AUTHENTIFIE
 * EXCLUSIVEMENT par isAuthorizedByCronSecret -- JAMAIS par le secret
 * manuel, même si celui-ci est correctement configuré et fourni.
 */
export async function GET(request: NextRequest) {
  return handleRecoveryInvocation(request, isAuthorizedByCronSecret);
}

/**
 * Invocation MANUELLE (développement local, en-tête personnalisé).
 * AUTHENTIFIE EXCLUSIVEMENT par isAuthorizedByManualSecret -- JAMAIS
 * par CRON_SECRET, même si celui-ci est correctement configuré et
 * fourni en tant que Bearer.
 */
export async function POST(request: NextRequest) {
  return handleRecoveryInvocation(request, isAuthorizedByManualSecret);
}
