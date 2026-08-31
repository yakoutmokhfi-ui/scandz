/**
 * Scanym — CUSTOMER TRACKING EXPERIENCE v1.
 *
 * Validation de FORME uniquement (pure, aucun accès réseau) : reconnaît
 * un UUID plausible (n'importe quelle version -- `orders.id`/
 * `orders.public_token` sont générés par `gen_random_uuid()`, version
 * 4, mais ce module ne l'exige pas strictement afin de ne pas coupler
 * la validation d'entrée à un détail d'implémentation de génération).
 *
 * Utilisé pour écarter une entrée manifestement malformée AVANT
 * d'appeler la RPC `get_order_tracking` (mandat §25/§34, "NULL/
 * malformed route input -> safe failure") -- sans jamais produire un
 * message DIFFÉRENT de celui d'un couple bien formé mais incorrect
 * (voir lib/server/tracking-service.ts, qui traite les deux cas de
 * façon strictement identique : TrackingLinkInvalidError générique).
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPlausibleUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
