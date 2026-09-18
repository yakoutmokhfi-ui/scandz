import { NextResponse, type NextRequest } from "next/server";
import { getOrderTracking, upgradeLegacyTrackingCapability } from "@/lib/server/tracking-service";
import { TrackingServerUnavailableError } from "@/lib/server/tracking-errors";
import {
  assertTrackingSessionConfigured,
  createTrackingSessionToken,
  TrackingSessionConfigError,
  TRACKING_SESSION_COOKIE_NAME,
  TRACKING_SESSION_MAX_AGE_SECONDS,
} from "@/lib/server/tracking-session";
import { isPlausibleUuid } from "@/lib/tracking/uuid";
import { isPlausibleCapabilitySecret } from "@/lib/tracking/capability";

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
 *   2. échanger la preuve legacy contre une capacité de suivi via
 *      `upgrade_legacy_tracking_capability` (v3.1, one-shot -- voir
 *      plus bas) ;
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
 * d'erreur brut -- `tracking-service`/`tracking-session` gardent déjà
 * cette discipline en amont ; ce fichier n'ajoute aucun `console.*`.
 *
 * CUSTOMER TRACKING v3.1 : l'étape 2 n'est plus une lecture
 * `get_order_tracking` mais l'échange ONE-SHOT
 * `upgrade_legacy_tracking_capability` -- ce corps POST est le SEUL
 * endroit où `public_token` est encore présenté. La session posée
 * porte la capacité liée à la commande, jamais `public_token`. Un
 * rejeu (capacité déjà réclamée) reçoit la même réponse générique
 * "invalid" qu'une paire incorrecte. La configuration de session est
 * vérifiée AVANT l'échange : une capacité mintée qui ne pourrait pas
 * être posée en cookie serait perdue définitivement.
 *
 * CUSTOMER TRACKING v3.1 — E-MAIL RÉUTILISABLE : le corps peut aussi
 * porter `{ orderId, capabilityId, secret }` (fragment `#c1.` des
 * nouveaux e-mails de commande, lib/tracking/link.ts). Cette forme
 * n'est qu'une LECTURE liée à la commande -- rien n'est consommé ni
 * réémis, le même lien reste donc valable jusqu'à son expiration SQL.
 */

interface ExchangeRequestBody {
  orderId?: unknown;
  publicToken?: unknown;
  capabilityId?: unknown;
  secret?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // CUSTOMER TRACKING v3.1 — CSRF : le cookie de session est désormais
  // SameSite=Lax (voir plus bas) ; ce point de terminaison, qui POSE ce
  // cookie, n'accepte donc qu'une requête JSON de MÊME ORIGINE -- un
  // formulaire inter-sites (text/plain, Sec-Fetch-Site: cross-site,
  // Origin étranger) ne peut jamais y fixer une session.
  if (!isSameOriginJsonRequest(request)) {
    return invalidResponse();
  }

  let body: ExchangeRequestBody;
  try {
    body = (await request.json()) as ExchangeRequestBody;
  } catch {
    return invalidResponse();
  }
  if (typeof body !== "object" || body === null) {
    return invalidResponse();
  }

  const orderId = typeof body.orderId === "string" ? body.orderId : null;
  const publicToken = typeof body.publicToken === "string" ? body.publicToken : null;
  const capabilityId = typeof body.capabilityId === "string" ? body.capabilityId : null;
  const secret = typeof body.secret === "string" ? body.secret : null;

  // Échec fermé AVANT tout appel réseau pour une entrée manifestement
  // malformée -- même discipline que lib/server/tracking-service.ts
  // (mandat §13, aucune distinction observable avec un couple bien
  // formé mais incorrect : les deux tombent sur invalidResponse()).
  // v3.1 : EXACTEMENT une des deux formes -- preuve legacy
  // (publicToken) OU capacité réutilisable d'un e-mail (capabilityId +
  // secret), jamais un mélange.
  if (!orderId || !isPlausibleUuid(orderId)) {
    return invalidResponse();
  }
  const isLegacy = publicToken !== null && capabilityId === null && secret === null;
  const isCapability = publicToken === null && capabilityId !== null && secret !== null;
  if (isLegacy ? !isPlausibleUuid(publicToken) : !isCapability) {
    return invalidResponse();
  }
  if (isCapability && (!isPlausibleUuid(capabilityId) || !isPlausibleCapabilitySecret(secret))) {
    return invalidResponse();
  }

  try {
    assertTrackingSessionConfigured();
  } catch {
    // TrackingSessionConfigError : panne de déploiement, vérifiée AVANT
    // de consommer l'échange one-shot.
    return unavailableResponse();
  }

  let capability: { capabilityId: string; secret: string };
  try {
    if (isLegacy) {
      // Échange one-shot (v3.1). La capacité n'est jamais renvoyée au
      // client dans le corps -- uniquement posée en cookie HttpOnly.
      capability = await upgradeLegacyTrackingCapability({ orderId, publicToken: publicToken! });
    } else {
      // Capacité réutilisable (e-mail de commande) : simple LECTURE
      // liée à la commande (get_order_tracking_by_capability, expiration
      // comprise) -- jamais consommée, jamais tournée, donc réutilisable
      // sur ce navigateur, après suppression du cookie, ou sur un autre
      // appareil.
      await getOrderTracking({ orderId, capabilityId: capabilityId!, secret: secret! });
      capability = { capabilityId: capabilityId!, secret: secret! };
    }
  } catch (err) {
    if (err instanceof TrackingServerUnavailableError) return unavailableResponse();
    // TrackingLinkInvalidError (paire incorrecte, rejeu legacy, capacité
    // fausse/expirée/d'une autre commande), ou toute autre exception
    // inattendue : traité de façon IDENTIQUE, jamais propagé (mandat §13).
    return invalidResponse();
  }

  let sessionToken: string;
  try {
    sessionToken = createTrackingSessionToken(orderId, capability.capabilityId, capability.secret);
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
    // v3.1 : Lax (et non plus Strict). Un lien ouvert depuis un webmail
    // externe est une navigation GET de premier niveau INTER-SITES :
    // Strict y retirait le cookie, forçant un nouvel échange -- fatal
    // pour un lien legacy (one-shot, rejeu refusé). Lax l'envoie sur
    // cette seule navigation GET ; jamais sur un POST ni une
    // sous-requête inter-sites. Le cookie n'autorise qu'une LECTURE
    // (page de suivi, aucun effet de bord) et ce point de terminaison
    // exige une requête JSON de même origine (isSameOriginJsonRequest)
    // -- aucune surface CSRF nouvelle.
    sameSite: "lax",
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

/**
 * Requête JSON de même origine uniquement. `Content-Type:
 * application/json` ne peut pas être émis par un formulaire HTML et
 * déclenche un preflight CORS pour tout `fetch` inter-origines ;
 * `Sec-Fetch-Site`/`Origin`, lorsque le navigateur les envoie, doivent
 * désigner cette même origine. Lit des en-têtes de TRANSPORT seulement
 * -- jamais un matériel de possession.
 */
function isSameOriginJsonRequest(request: NextRequest): boolean {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.split(";")[0]!.trim() !== "application/json") return false;

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null) return fetchSite === "same-origin";

  // Navigateur sans Fetch Metadata : repli sur Origin, s'il est présent.
  // "null" (émis pour un POST de même origine sous Referrer-Policy:
  // no-referrer, next.config.mjs) n'est pas concluant : la contrainte
  // application/json ci-dessus suffit alors (préflight CORS obligatoire
  // pour tout envoi inter-origines, jamais accordé ici).
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null") {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    if (originHost !== request.headers.get("host")) return false;
  }
  return true;
}

function invalidResponse(): NextResponse {
  return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
}

function unavailableResponse(): NextResponse {
  return NextResponse.json({ ok: false, reason: "unavailable" }, { status: 503 });
}
