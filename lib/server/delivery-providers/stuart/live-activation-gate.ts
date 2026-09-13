import "server-only";

/**
 * STUART LOT D2 — LIVE ACTIVATION GATE.
 *
 * "IMPORTANT — PRODUCTION MODE IS NOT ACTIVATION" (mandat D2, littéral) :
 * `delivery_provider_configs.mode = 'production'` (LOT A-0, autorité
 * d'ENVIRONNEMENT marchand, INCHANGÉE) ne signifie JAMAIS, à lui seul,
 * qu'un appel réseau Stuart réel est autorisé. Ce module introduit une
 * SECONDE autorité, ENTIÈREMENT DISTINCTE et ORTHOGONALE : l'AUTORISATION
 * D'ACTIVATION SCANYM (`live_network_activation`), une porte
 * plateforme-globale (jamais par marchand) qui doit être franchie EN
 * PLUS de toute résolution crédential/environnement marchand réussie
 * avant qu'un SEUL octet ne puisse être envoyé à une API Stuart réelle
 * (Sandbox ou Production).
 *
 * Séquence complète attendue (mandat, "Preferred semantics") :
 *   merchant configured AND eligible AND valid credentials AND
 *   Stuart environment resolved AND Scanym live activation explicitly
 *   enabled
 * Cette porte est LA DERNIÈRE condition de cette conjonction — voir
 * `merchant-runtime-adapter.ts` : la résolution credential/environnement
 * (RPC Supabase, jamais un appel réseau Stuart) est TOUJOURS effectuée
 * en premier (permet de prouver items 1-8 du mandat indépendamment de
 * cette porte) ; CETTE porte est vérifiée EN DERNIER, ENCORE AVANT toute
 * tentative réseau Stuart, y compris l'acquisition OAuth elle-même
 * (mandat : "NO OAuth request is authorized" pendant ce lot — la porte
 * doit donc bloquer avant `/oauth/token`, pas seulement avant
 * `/v2/jobs`).
 *
 * GARANTIES STRUCTURELLES (mandat, section "LIVE ACTIVATION GATE") :
 *   - défaut = OFF (variable absente -> false, jamais une valeur par
 *     défaut différente) ;
 *   - échec fermé si absente/invalide (AUCUNE valeur autre que
 *     EXACTEMENT la chaîne "true" n'active la porte — pas de casse
 *     alternative, pas d'alias "1"/"yes"/"on", même discipline stricte
 *     que `STUART_ENV` dans `environment.ts`) ;
 *   - JAMAIS contrôlable par le navigateur — AUCUNE variable
 *     `NEXT_PUBLIC_*`, AUCUN header/paramètre de requête HTTP n'est lu
 *     ici ; ce module ne lit QUE `process.env` côté serveur
 *     (`import "server-only"`) ;
 *   - JAMAIS contrôlée SEULEMENT par un champ de base de données
 *     marchand — délibérément PAS une colonne `delivery_provider_configs`
 *     (qui resterait, par construction, contrôlable indirectement par
 *     tout futur point d'entrée Admin/Operator marchand) : c'est une
 *     variable d'environnement PLATEFORME, positionnée UNIQUEMENT au
 *     niveau du déploiement Scanym lui-même, jamais par un marchand ;
 *   - JAMAIS activée implicitement par un déploiement/environnement
 *     Production — ce module NE LIT JAMAIS `NODE_ENV`, `VERCEL_ENV`, ni
 *     aucune autre variable de plateforme de déploiement ; la SEULE
 *     variable lue est `STUART_LIVE_ACTIVATION_ENABLED`, dédiée,
 *     jamais réutilisée à d'autres fins ;
 *   - AUDITABLE — nom de variable unique, dédié, documenté ici ;
 *     `describeStuartLiveActivationGateForObservability()` expose un
 *     résumé SANS SECRET, destiné à la journalisation structurée
 *     (`merchant-runtime-adapter.ts`), jamais une simple valeur
 *     booléenne opaque perdue dans un log générique.
 *
 * PENDANT CE MANDAT (D2) : cette porte DOIT rester OFF partout — AUCUN
 * fichier de ce lot ne positionne jamais `STUART_LIVE_ACTIVATION_ENABLED`
 * à `"true"`, ni dans le code, ni dans un test, ni dans un fixture, ni
 * dans un exemple de configuration. Un test dédié
 * (`tests/v166-stuart-lot-d2-live-activation-gate.test.ts`) le vérifie
 * structurellement (grep) en plus de vérifier le comportement fail-closed
 * lui-même.
 */

const LIVE_ACTIVATION_ENV_VAR = "STUART_LIVE_ACTIVATION_ENABLED";

/**
 * Unique valeur qui active la porte — comparaison STRICTE, sensible à
 * la casse, aucun alias. Toute autre valeur (y compris `undefined`,
 * `""`, `"1"`, `"TRUE"`, `"yes"`) est traitée comme OFF.
 */
const ENABLING_VALUE = "true";

export function isStuartLiveActivationEnabled(): boolean {
  return process.env[LIVE_ACTIVATION_ENV_VAR] === ENABLING_VALUE;
}

export interface StuartLiveActivationGateObservability {
  envVarName: string;
  enabled: boolean;
  /** `true` si la variable est absente (distinct de "présente mais
   *  invalide") -- utile pour distinguer en observabilité "jamais
   *  configurée" de "configurée mais mal orthographiée". JAMAIS la
   *  valeur brute elle-même (pas de risque de fuite, cette variable ne
   *  contient de toute façon aucun secret -- seulement une valeur de
   *  contrôle booléenne -- mais la discipline reste la même que pour
   *  tout champ d'observabilité de ce lot : ne jamais journaliser plus
   *  que nécessaire). */
  wasUnset: boolean;
}

/**
 * Résumé SANS SECRET destiné à la journalisation structurée -- mandat
 * "OBSERVABILITY" (jamais un booléen opaque perdu dans un log
 * générique). N'expose JAMAIS la valeur brute de la variable
 * elle-même (uniquement son état résolu + si elle était absente).
 */
export function describeStuartLiveActivationGateForObservability(): StuartLiveActivationGateObservability {
  const raw = process.env[LIVE_ACTIVATION_ENV_VAR];
  return {
    envVarName: LIVE_ACTIVATION_ENV_VAR,
    enabled: raw === ENABLING_VALUE,
    wasUnset: typeof raw === "undefined",
  };
}
