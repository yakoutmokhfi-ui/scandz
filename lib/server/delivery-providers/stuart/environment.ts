import "server-only";

/**
 * DELIVERY STREAM C — STUART FOUNDATION / SANDBOX v1.2.1
 * (ferme STUART-V1-ENVIRONMENT-GATE-01).
 *
 * DÉFAUT CORRIGÉ (v1) : `STUART_API_BASE_URL` était une chaîne libre,
 * jamais validée contre `STUART_ENV` -- un déploiement mal configuré
 * aurait pu envoyer `STUART_ENV=sandbox` avec une URL de base
 * Production (ou l'inverse), ou une URL totalement arbitraire, sans
 * jamais être détecté avant l'appel réseau lui-même.
 *
 * CORRECTIF v1.1 : `STUART_ENV` devient une énumération FERMÉE
 * (`sandbox` | `production`), dont l'URL de base est DÉRIVÉE, jamais
 * lue depuis une variable libre. `STUART_API_BASE_URL` est
 * ENTIÈREMENT SUPPRIMÉE de la configuration -- mandat §9, littéral :
 * "avoid configurable protocol paths unless necessary" -- aucune
 * raison technique réelle ne justifie qu'un déploiement Scanym
 * pointe vers une URL Stuart différente de celle officiellement
 * associée à l'environnement choisi.
 *
 * URLS DE BASE -- contrat actuel confirmé (documentation Stuart/
 * Postman officielle) : Sandbox = "https://api.sandbox.stuart.com" ;
 * Production = "https://api.stuart.com". Une divergence historique
 * avec un SDK Ruby officiel archivé (base_url
 * "https://sandbox-api.stuart.com", ordre de sous-domaines inversé,
 * antérieur à la documentation actuelle) est mentionnée ici à titre
 * de CONTEXTE HISTORIQUE UNIQUEMENT -- elle ne remet pas en cause le
 * contrat actuel ci-dessus, désormais la seule source de vérité
 * utilisée par ce module.
 */

export type StuartEnvironment = "sandbox" | "production";

export class StuartEnvironmentError extends Error {
  constructor(message: string = "STUART_ENVIRONMENT_ERROR") {
    super(message);
    this.name = "StuartEnvironmentError";
  }
}

const OFFICIAL_BASE_URLS: Record<StuartEnvironment, string> = {
  sandbox: "https://api.sandbox.stuart.com",
  production: "https://api.stuart.com",
};

/**
 * Lit `STUART_ENV`, le valide STRICTEMENT contre l'énumération
 * fermée, et retourne l'URL de base OFFICIELLE correspondante --
 * JAMAIS une valeur lue depuis une autre variable d'environnement.
 * Échec fermé explicite pour :
 * - `STUART_ENV` absente ;
 * - toute valeur autre que EXACTEMENT "sandbox" ou "production"
 *   (aucune normalisation de casse, aucun alias toléré -- une
 *   configuration ambiguë doit échouer, jamais être devinée).
 */
export function resolveStuartEnvironment(): { environment: StuartEnvironment; baseUrl: string } {
  const raw = process.env.STUART_ENV;
  if (raw !== "sandbox" && raw !== "production") {
    throw new StuartEnvironmentError(
      `STUART_ENV invalide ou absente (attendu exactement "sandbox" ou "production", reçu ${JSON.stringify(raw)})`
    );
  }
  return { environment: raw, baseUrl: OFFICIAL_BASE_URLS[raw] };
}

/**
 * STUART LOT A — QUOTE / VALIDATE / ETA / SCHEDULING FOUNDATION v1.
 *
 * Fonction PURE additive (aucune lecture de `process.env` -- à la
 * différence de `resolveStuartEnvironment()` ci-dessus) -- dérive
 * l'URL de base OFFICIELLE à partir d'un `StuartEnvironment` DÉJÀ
 * résolu par ailleurs (pour LOT A : `delivery_provider_configs.mode`,
 * jamais `STUART_ENV`). Réutilise `OFFICIAL_BASE_URLS`, SEULE source
 * de vérité pour les deux URLs -- jamais dupliquées ailleurs dans le
 * dépôt. N'altère AUCUN comportement existant de
 * `resolveStuartEnvironment()` -- ajout pur, aucun export existant
 * modifié.
 */
export function resolveStuartBaseUrlForEnvironment(environment: StuartEnvironment): string {
  return OFFICIAL_BASE_URLS[environment];
}
