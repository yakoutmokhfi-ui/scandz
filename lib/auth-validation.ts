/**
 * Règles de validation liées à l'authentification, indépendantes de
 * Supabase.
 *
 * Volontairement séparé de lib/services/auth.ts : ce dernier importe
 * @/lib/supabase, dont le chargement échoue immédiatement si les
 * variables d'environnement Supabase ne sont pas définies (comportement
 * voulu en production — voir lib/supabase.ts). Si ces fonctions pures
 * restaient dans auth.ts, le simple fait de les importer dans un test
 * suffirait à déclencher cette erreur, obligeant à injecter des
 * variables Supabase factices pour exécuter `npm test`. En les isolant
 * ici, elles restent testables sans aucune configuration Supabase,
 * comme le reste des fonctions pures du projet (lib/cart.ts,
 * lib/whatsapp.ts...).
 */

/** Longueur minimale imposée pour un nouveau mot de passe. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Analyse l'URL de redirection d'un lien Supabase Auth à la recherche
 * d'une erreur explicite (lien expiré, déjà utilisé, invalide).
 * Supabase encode l'erreur soit dans le fragment, soit dans les
 * paramètres de requête, selon les versions du flux de récupération.
 *
 * Fonction pure (prend l'URL en paramètre plutôt que de lire
 * window.location) pour rester testable sans environnement navigateur
 * ni configuration Supabase.
 */
export function extractAuthLinkError(url: string): string | null {
  const parsed = new URL(url);
  const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const searchParams = parsed.searchParams;

  const code =
    hashParams.get("error_code") ??
    searchParams.get("error_code") ??
    hashParams.get("error") ??
    searchParams.get("error");

  if (!code) return null;

  const description =
    hashParams.get("error_description") ?? searchParams.get("error_description");

  // URLSearchParams décode déjà le pourcent-encodage et les '+' : pas
  // de traitement supplémentaire à faire ici.
  return description ?? code;
}
