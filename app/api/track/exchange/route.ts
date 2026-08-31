import { NextResponse, type NextRequest } from "next/server";
import { getOrderTracking } from "@/lib/server/tracking-service";
import {
  TrackingLinkInvalidError,
  TrackingServerUnavailableError,
} from "@/lib/server/tracking-errors";
import {
  createTrackingSessionToken,
  TrackingSessionConfigError,
  TRACKING_SESSION_COOKIE_NAME,
  TRACKING_SESSION_MAX_AGE_SECONDS,
} from "@/lib/server/tracking-session";
import { isPlausibleUuid } from "@/lib/tracking/uuid";

/**
 * CUSTOMER TRACKING EXPERIENCE v2 — point de terminaison d'ÉCHANGE
 * (mandat §8).
 *
 * SEUL point d'entrée où `public_token` transite encore par une
 * requête réseau explicite -- et EXCLUSIVEMENT dans le CORPS d'une
 * requête POST HTTPS (jamais l'URL, jamais une chaîne de requête,
 * mandat §6/§30.D). Ce fichier n'a PAS besoin du garde `import
 * "server-only"` : un fichier `route.ts` n'est, par construction du
 * routeur Next.js App Router, jamais un module important par un
 * composant client -- voir IMPLEMENTATION-REPORT.txt.
 *
 * Rôle STRICTEMENT limité à :
 *   1. valider la FORME de l'entrée (mandat §13, échec fermé avant
 *      tout appel réseau pour une entrée manifestement malformée) ;
 *   2. prouver la possession via la RPC déjà publiée et auditée
 *      `get_order_tracking` (mandat §5, AUCUNE redéfinition de
 *      l'autorité) ;
 *   3. si la possession est prouvée, émettre une session de
 *      présentation temporaire (lib/server/tracking-session.ts) et la
 *      poser en cookie HttpOnly, scindée par commande (mandat §10) ;
 *   4. répondre par un JSON MINIMAL (`{ ok: true }`) -- ne renvoie
 *      JAMAIS les données de suivi elles-mêmes ni le jeton de session
 *      en clair dans le corps de réponse (la page de suivi les relira
 *      via la RPC après le rafraîchissement client, voir
 *      components/TrackingEntryGate.tsx) ni `public_token` en écho.
 *
 * ÉNUMÉRATION (mandat §13) : TOUTE défaillance de possession
 * (malformé, mauvais jeton, mauvaise commande, couple croisé) produit
 * EXACTEMENT la même réponse générique -- seule une panne
 * d'infrastructure (mandat §13, "Infrastructure outage may use a
 * generic unavailable response") obtient une réponse différente,
 * elle-même toujours générique (elle ne révèle jamais si la commande
 * existe).
 *
 * JOURNALISATION (mandat §12) : ce fichier ne journalise JAMAIS le
 * corps de la requête, `orderId`/`publicToken`, ni aucun message
 * d'erreur brut -- `getOrderTracking`/`tracking-session` gardent déjà
 * cette discipline en amont ; ce fichier n'ajoute aucun `console.*`.
 */

interface ExchangeRequestBody {
  orderId?: unknown;
  publicToken?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: ExchangeRequestBody;
  try {
    body = (await request.json()) as ExchangeRequestBody;
  } catch {
    return invalidResponse();
  }

  const orderId = typeof body.orderId === "string" ? body.orderId : null;
  const publicToken = typeof body.publicToken === "string" ? body.publicToken : null;

  // Échec fermé AVANT tout appel réseau pour une entrée manifestement
  // malformée -- même discipline que lib/server/tracking-service.ts
  // (mandat §13, aucune distinction observable avec un couple bien
  // formé mais incorrect : les deux tombent sur invalidResponse()).
  if (!orderId || !publicToken || !isPlausibleUuid(orderId) || !isPlausibleUuid(publicToken)) {
    return invalidResponse();
  }

  try {
    // Preuve de possession via la SEULE autorité publiée (mandat §5).
    // Le résultat lui-même n'est jamais renvoyé au client ici -- voir
    // le commentaire de tête.
    await getOrderTracking({ orderId, publicToken });
  } catch (err) {
    if (err instanceof TrackingServerUnavailableError) return unavailableResponse();
    // TrackingLinkInvalidError, ou toute autre exception inattendue :
    // traité de façon IDENTIQUE, jamais propagé (mandat §13).
    return invalidResponse();
  }

  let sessionToken: string;
  try {
    sessionToken = createTrackingSessionToken(orderId, publicToken);
  } catch (err) {
    // TrackingSessionConfigError (secret d'environnement absent/mal
    // formé) : une panne D'INFRASTRUCTURE côté déploiement, jamais une
    // information sur la commande -- même catégorie de réponse
    // générique que TrackingServerUnavailableError, jamais le détail
    // de configuration exposé au client.
    if (err instanceof TrackingSessionConfigError) return unavailableResponse();
    return unavailableResponse();
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(TRACKING_SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    // Mandat §10 : "Secure in Production." NODE_ENV !== "production"
    // (tests locaux/dev) reste utilisable sur http://localhost sans
    // le drapeau Secure, qui exigerait HTTPS.
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    // Mandat §10 : "narrow path where practical" -- portée au SEUL
    // chemin de cette commande ; défense en profondeur uniquement,
    // l'isolation RÉELLE est appliquée dans
    // verifyTrackingSessionToken() (mandat §11), indépendamment de ce
    // comportement de portée, qui reste un détail de transport.
    path: `/track/${encodeURIComponent(orderId)}`,
    maxAge: TRACKING_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}

function invalidResponse(): NextResponse {
  return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
}

function unavailableResponse(): NextResponse {
  return NextResponse.json({ ok: false, reason: "unavailable" }, { status: 503 });
}
