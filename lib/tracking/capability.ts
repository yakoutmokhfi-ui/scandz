/**
 * Scanym — CUSTOMER TRACKING v3.1 — validation de FORME du secret de
 * capacité de suivi (pure, aucun accès réseau).
 *
 * Le secret est émis UNE SEULE FOIS par
 * `upgrade_legacy_tracking_capability` (supabase/DRAFT-lot-customer-
 * tracking-capability-v3-1.sql) : 64 caractères hexadécimaux minuscules.
 * Toute autre forme est écartée AVANT la RPC de lecture, avec la même
 * issue générique qu'un secret bien formé mais faux.
 */
const CAPABILITY_SECRET_PATTERN = /^[0-9a-f]{64}$/;

export function isPlausibleCapabilitySecret(value: unknown): value is string {
  return typeof value === "string" && CAPABILITY_SECRET_PATTERN.test(value);
}
