/**
 * Scanym — CUSTOMER TRACKING EXPERIENCE v2 — construction du lien de
 * suivi.
 *
 * Fonction PURE (aucun accès réseau, aucune dépendance Supabase) --
 * extraite pour rester testable sans DOM, même discipline que
 * lib/services/order-payload.ts.
 *
 * AUTORITÉ DE POSSESSION (mandat §5) : EXACTEMENT `order_id` +
 * `public_token`, tels que renvoyés par `create_order` (jamais
 * recalculés, jamais un second secret généré ici).
 *
 * TRANSPORT DU JETON — CHANGEMENT DE SÉCURITÉ MAJEUR PAR RAPPORT À v1
 * (mandat §6/§7, ferme le blocage de publication CTE-V1-TOKEN-LOG-01) :
 * v1 utilisait `/track/<order_id>/<public_token>` -- un chemin de
 * requête HTTP, donc potentiellement visible dans les journaux
 * d'infrastructure/CDN (Vercel request path, logs de plateforme). v2
 * utilise EXCLUSIVEMENT un FRAGMENT d'URL :
 * `/track/<order_id>#<public_token>`.
 *
 * Propriété HTTP décisive : tout ce qui suit `#` dans une URL n'est
 * JAMAIS envoyé par le navigateur dans la requête HTTP réelle vers le
 * serveur (RFC 3986 §3.5) -- ni dans le chemin, ni dans les en-têtes,
 * ni dans un éventuel Referer. Seul du JavaScript côté navigateur peut
 * lire `location.hash` après le chargement de la page. Voir
 * TOKEN-TRANSPORT-SECURITY-REPORT.txt pour l'analyse complète
 * (scanners de lien, CDN, journaux, historique).
 *
 * Ce module NE fournit PLUS `buildTrackingUrl` (URL absolue) : cette
 * fonction n'existait que pour l'e-mail de notification (lib/server/
 * notification-outbox.ts, lot EXCLU de v2 par mandat §4/§26 -- voir
 * EMAIL-ARCHITECTURE-GAP-REPORT.txt). v2 n'a besoin que d'un CHEMIN
 * relatif (le CTA de confirmation de commande est un lien interne).
 */

import { isPlausibleUuid } from "@/lib/tracking/uuid";
import { isPlausibleCapabilitySecret } from "@/lib/tracking/capability";

/**
 * Lien d'ENTRÉE client (mandat §7) : porte le jeton de possession en
 * FRAGMENT, jamais en segment de chemin ni en chaîne de requête.
 * `encodeURIComponent` reste appliqué par prudence (aucun caractère
 * spécial n'est attendu dans un UUID, mais ce module ne suppose jamais
 * la forme de son entrée -- voir lib/tracking/uuid.ts pour la
 * validation de forme, effectuée séparément par l'appelant).
 */
export function buildTrackingPath(orderId: string, publicToken: string): string {
  return `/track/${encodeURIComponent(orderId)}#${encodeURIComponent(publicToken)}`;
}

/**
 * CUSTOMER TRACKING v3.1 — préfixe VERSIONNÉ du fragment porteur d'une
 * capacité de suivi RÉUTILISABLE (e-mail de commande) :
 * `#c1.<capability_id>.<secret>`. Jamais confondable avec un fragment
 * legacy (UUID nu).
 */
const CAPABILITY_FRAGMENT_PREFIX = "c1.";

/**
 * CUSTOMER TRACKING v3.1 — lien d'entrée des NOUVEAUX e-mails de
 * commande : capacité liée à la commande (émise par
 * `issue_order_email_tracking_capability`), EXCLUSIVEMENT en fragment
 * -- jamais dans le chemin ni la chaîne de requête, donc jamais dans
 * une requête HTTP ni un journal serveur (même propriété que
 * `buildTrackingPath`). Réutilisable : l'échange correspondant n'est
 * qu'une LECTURE (app/api/track/exchange/route.ts).
 */
export function buildCapabilityTrackingPath(
  orderId: string,
  capabilityId: string,
  secret: string
): string {
  return `/track/${encodeURIComponent(orderId)}#${CAPABILITY_FRAGMENT_PREFIX}${encodeURIComponent(capabilityId)}.${encodeURIComponent(secret)}`;
}

export type TrackingFragment =
  | { kind: "legacy"; publicToken: string }
  | { kind: "capability"; capabilityId: string; secret: string };

/**
 * Interprète le fragment (déjà décodé, sans '#') d'un lien d'entrée.
 * Retourne `null` pour TOUTE forme non reconnue -- l'appelant la
 * traite comme n'importe quel lien invalide, sans appel réseau.
 */
export function parseTrackingFragment(value: string): TrackingFragment | null {
  if (value.startsWith(CAPABILITY_FRAGMENT_PREFIX)) {
    const parts = value.slice(CAPABILITY_FRAGMENT_PREFIX.length).split(".");
    if (parts.length !== 2) return null;
    const [capabilityId, secret] = parts as [string, string];
    if (!isPlausibleUuid(capabilityId) || !isPlausibleCapabilitySecret(secret)) return null;
    return { kind: "capability", capabilityId, secret };
  }
  if (isPlausibleUuid(value)) return { kind: "legacy", publicToken: value };
  return null;
}

/**
 * Chemin PROPRE (mandat §7/§20), sans aucun jeton -- c'est le chemin
 * effectivement envoyé au serveur pour CHAQUE requête HTTP (la
 * première visite comme les rafraîchissements suivants), et celui
 * écrit dans la barre d'adresse par `history.replaceState` juste après
 * l'échange de possession réussi (components/TrackingEntryGate.tsx).
 * Ne prend jamais `publicToken` en paramètre : cette fonction ne PEUT
 * PAS produire un lien porteur de jeton, par construction.
 */
export function buildCleanTrackingPath(
  orderId: string,
  view: TrackingView | null = null
): string {
  const base = `/track/${encodeURIComponent(orderId)}`;
  return view === TRACKING_VIEW_WITHDRAWAL
    ? `${base}?${TRACKING_VIEW_PARAM}=${TRACKING_VIEW_WITHDRAWAL}`
    : base;
}

/**
 * RÉTRACTATION DIRECTE -- vue « formulaire seul » de la page de suivi.
 *
 * Le bouton « Demander une rétractation » de l'écran de confirmation
 * ouvre directement le formulaire, sans afficher d'abord la page de
 * suivi : `/track/<order_id>?view=withdrawal#<jeton>`.
 *
 * `view` est un paramètre de PRÉSENTATION, pas un droit d'accès :
 *   - il n'accorde RIEN : sans session de suivi valide pour CETTE
 *     commande, la page affiche la même passerelle d'entrée qu'avant
 *     (le jeton reste dans le fragment, jamais envoyé au serveur) ;
 *   - l'éligibilité reste décidée côté serveur par la RPC liée à la
 *     capacité (jamais par ce paramètre) ;
 *   - c'est une LISTE BLANCHE stricte à une seule valeur, comparée
 *     par égalité exacte : toute autre valeur (casse, espaces,
 *     répétition, tableau, vide) retombe sur la vue de suivi par
 *     défaut.
 */
export const TRACKING_VIEW_PARAM = "view";
export const TRACKING_VIEW_WITHDRAWAL = "withdrawal";
export type TrackingView = typeof TRACKING_VIEW_WITHDRAWAL;

/** `searchParams.view` -> vue reconnue, ou `null` (vue par défaut). */
export function parseTrackingView(raw: unknown): TrackingView | null {
  return raw === TRACKING_VIEW_WITHDRAWAL ? TRACKING_VIEW_WITHDRAWAL : null;
}

/**
 * Vue conservée par la passerelle d'entrée après l'échange : la chaîne
 * de requête doit être EXACTEMENT `?view=withdrawal` -- ni autre
 * paramètre, ni répétition, ni casse différente. Tout le reste est
 * abandonné (chemin propre), comme avant ce lot.
 */
export function parseTrackingViewFromSearch(search: string): TrackingView | null {
  return search === `?${TRACKING_VIEW_PARAM}=${TRACKING_VIEW_WITHDRAWAL}`
    ? TRACKING_VIEW_WITHDRAWAL
    : null;
}

/** Lien de la vue formulaire, à partir de l'identifiant et du jeton. */
export function buildWithdrawalViewPath(orderId: string, publicToken: string): string {
  return `${buildCleanTrackingPath(orderId, TRACKING_VIEW_WITHDRAWAL)}#${encodeURIComponent(publicToken)}`;
}

/**
 * Dérive le lien de la vue formulaire d'un lien de suivi DÉJÀ construit
 * (`/track/<order_id>#<fragment>`). Échec FERMÉ : toute entrée qui n'a
 * pas EXACTEMENT cette forme (chemin absolu autre que `/track/<uuid>`,
 * requête déjà présente, plusieurs `#`, fragment qui n'est ni un jeton
 * ni une capacité reconnus) renvoie `null` -- jamais une URL « réparée ».
 */
export function withdrawalViewPathFromTrackingPath(trackingPath: string): string | null {
  const prefix = "/track/";
  if (typeof trackingPath !== "string" || !trackingPath.startsWith(prefix)) return null;
  const hashAt = trackingPath.indexOf("#");
  if (hashAt === -1) return null;
  const rawId = trackingPath.slice(prefix.length, hashAt);
  const rawFragment = trackingPath.slice(hashAt + 1);
  if (!isPlausibleUuid(rawId)) return null;
  if (rawFragment.length === 0 || /[#?/]/.test(rawFragment)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawFragment);
  } catch {
    return null;
  }
  if (parseTrackingFragment(decoded) === null) return null;
  return `${buildCleanTrackingPath(rawId, TRACKING_VIEW_WITHDRAWAL)}#${rawFragment}`;
}
