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
 * Chemin PROPRE (mandat §7/§20), sans aucun jeton -- c'est le chemin
 * effectivement envoyé au serveur pour CHAQUE requête HTTP (la
 * première visite comme les rafraîchissements suivants), et celui
 * écrit dans la barre d'adresse par `history.replaceState` juste après
 * l'échange de possession réussi (components/TrackingEntryGate.tsx).
 * Ne prend jamais `publicToken` en paramètre : cette fonction ne PEUT
 * PAS produire un lien porteur de jeton, par construction.
 */
export function buildCleanTrackingPath(orderId: string): string {
  return `/track/${encodeURIComponent(orderId)}`;
}
