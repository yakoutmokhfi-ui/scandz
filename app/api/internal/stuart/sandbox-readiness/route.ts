import "server-only";
import { timingSafeEqual, createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveStuartEnvironment, StuartEnvironmentError } from "@/lib/server/delivery-providers/stuart/environment";

/**
 * DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.6.2
 * SONDE DE PRÉPARATION RUNTIME (lecture seule).
 *
 * OBJECTIF : permettre à l'auditeur de vérifier la PRÉSENCE/
 * RÉSOLUTION SÛRE de la configuration Stuart déployée sur Vercel
 * (métadonnées de déploiement Vercel n'exposent pas les valeurs
 * runtime de STUART_ENV/STUART_CLIENT_ID/STUART_CLIENT_SECRET) --
 * SANS jamais révéler la moindre valeur de secret.
 *
 * ZÉRO appel réseau Stuart, ZÉRO OAuth, ZÉRO Create Job, ZÉRO accès
 * base de données -- réutilise UNIQUEMENT `resolveStuartEnvironment()`
 * (v1, déjà audité, INCHANGÉ) pour la résolution d'URL, jamais une
 * seconde implémentation.
 *
 * AUTHENTIFICATION : secret DÉDIÉ, DISTINCT de
 * `STUART_SANDBOX_TRIGGER_SECRET` (mandat, littéral : "do not reuse
 * Stuart client credentials as auth" -- extension par prudence à tout
 * secret Stuart existant, y compris celui du déclencheur
 * d'orchestration : cette sonde est un privilège STRICTEMENT
 * INFÉRIEUR -- lecture seule, jamais d'orchestration -- partager le
 * même secret élargirait inutilement la surface d'un secret plus
 * sensible). Même patron exact (en-tête dédié, comparaison en temps
 * constant) que le déclencheur Sandbox et le worker de reprise
 * Monetico déjà audités.
 */
export const runtime = "nodejs";

const SECRET_HEADER = "x-stuart-sandbox-readiness-secret";
const EXPECTED_SANDBOX_BASE_URL = "https://api.sandbox.stuart.com";
const PRODUCTION_BASE_URL = "https://api.stuart.com";

/**
 * CORRECTIF v2.6.3 (STUART-V262-AUTH-TIMING-LENGTH-01, LOW) : la
 * version précédente retournait immédiatement `false` si les
 * longueurs UTF-8 différaient, AVANT d'appeler `timingSafeEqual` --
 * cette branche précoce dépendait de la longueur de la valeur fournie
 * par l'appelant, un canal auxiliaire théoriquement observable.
 * Corrigé : dérive une empreinte SHA-256 à LONGUEUR FIXE (32 octets,
 * toujours) des DEUX chaînes AVANT toute comparaison -- `timingSafeEqual`
 * ne reçoit ainsi jamais deux tampons de longueurs différentes,
 * éliminant structurellement le besoin de tout contrôle de longueur
 * préalable, quelle que soit la longueur réelle de la valeur fournie
 * par l'appelant. Aucune nouvelle dépendance -- uniquement
 * `node:crypto`, déjà utilisé.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * CORRECTIF v2.6.5 (STUART-V262-AUTH-TIMING-LENGTH-01, LOW, réouvert)
 * -- même correctif exact que le déclencheur : la valeur fournie par
 * l'appelant est normalisée en chaîne vide si absente, puis passe
 * TOUJOURS par l'empreinte SHA-256 à longueur fixe et
 * `timingSafeEqual`, sans aucun retour anticipé basé sur une entrée
 * contrôlée par l'appelant.
 */
function isAuthorized(request: NextRequest): boolean {
  const configured = process.env.STUART_SANDBOX_READINESS_SECRET;
  if (typeof configured !== "string" || configured.length === 0) return false;
  const provided = request.headers.get(SECRET_HEADER) ?? "";
  return timingSafeStringEqual(provided, configured);
}

interface ReadinessResponse {
  stuart_env: "sandbox" | "fail";
  stuart_client_id: "present" | "absent";
  stuart_client_secret: "present" | "absent";
  resolved_base_url: "https://api.sandbox.stuart.com" | "invalid";
  production_url_selected: boolean;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    // JAMAIS de détail -- même réponse générique que le déclencheur
    // d'orchestration pour une requête non autorisée.
    return NextResponse.json({ outcome: "unavailable" }, { status: 503 });
  }

  // PRÉSENCE UNIQUEMENT -- jamais la valeur elle-même transmise en
  // dehors de cette fonction, jamais journalisée, jamais incluse dans
  // une erreur.
  const clientIdPresent = typeof process.env.STUART_CLIENT_ID === "string" && process.env.STUART_CLIENT_ID.length > 0;
  const clientSecretPresent = typeof process.env.STUART_CLIENT_SECRET === "string" && process.env.STUART_CLIENT_SECRET.length > 0;

  // Réutilise EXCLUSIVEMENT le résolveur déjà audité -- jamais une
  // seconde implémentation de la logique de résolution d'environnement.
  let resolvedEnv: "sandbox" | "fail" = "fail";
  let resolvedBaseUrl: "https://api.sandbox.stuart.com" | "invalid" = "invalid";
  let productionUrlSelected = false;
  try {
    const { environment, baseUrl } = resolveStuartEnvironment();
    if (environment === "sandbox") {
      resolvedEnv = "sandbox";
    }
    if (baseUrl === EXPECTED_SANDBOX_BASE_URL) {
      resolvedBaseUrl = EXPECTED_SANDBOX_BASE_URL;
    }
    if (baseUrl === PRODUCTION_BASE_URL) {
      productionUrlSelected = true;
    }
  } catch (err) {
    // `StuartEnvironmentError` est attendue (STUART_ENV absente/
    // invalide) -- jamais journalisée avec un détail exploitable,
    // jamais incluse dans la réponse. Toute autre erreur inattendue
    // est traitée de façon identique -- fail-closed silencieux.
    void (err instanceof StuartEnvironmentError);
  }

  const response: ReadinessResponse = {
    stuart_env: resolvedEnv,
    stuart_client_id: clientIdPresent ? "present" : "absent",
    stuart_client_secret: clientSecretPresent ? "present" : "absent",
    resolved_base_url: resolvedBaseUrl,
    production_url_selected: productionUrlSelected,
  };

  return NextResponse.json(response, { status: 200 });
}
