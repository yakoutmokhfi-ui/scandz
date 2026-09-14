import "server-only";

/**
 * N1-A — REAL EMAIL ACTIVATION GATE.
 *
 * Calquée EXACTEMENT sur
 * `lib/server/delivery-providers/stuart/live-activation-gate.ts` (même
 * discipline, mandat §"REAL EMAIL ACTIVATION GATE") : un seul booléen
 * plateforme, PAR DÉFAUT DÉSACTIVÉ, jamais une variable NEXT_PUBLIC_*,
 * jamais dérivée de NODE_ENV/VERCEL_ENV, jamais contrôlable par le
 * navigateur ni par une colonne merchant_notification_profile (cette
 * porte est PLATEFORME, pas par tenant -- distincte de
 * `merchant_notification_profile.email_enabled`, qui reste un opt-in
 * MARCHAND, voir README-AUDIT.md §"MERCHANT EMAIL PROFILE").
 *
 * Ce lot n'implémente AUCUN provider réel (voir email-provider.ts) --
 * cette porte existe en tant que garde-fou structurel pour un FUTUR
 * lot qui câblerait un provider réel derrière `EmailProvider`. Tant
 * qu'aucun provider réel n'existe, cette porte ne protège rien de
 * concret, mais son absence dans ce lot serait elle-même une dette
 * risquée à combler plus tard sous pression -- elle est donc posée
 * maintenant, avec sa propre couverture de test dédiée (voir
 * tests/v1-n1a-real-email-activation-gate.test.ts), exactement comme
 * Stuart l'a fait pour son propre lot fondation.
 */

const LIVE_ACTIVATION_ENV_VAR = "NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED";
const ENABLING_VALUE = "true"; // strict, sensible à la casse, aucun alias

export function isRealEmailSendActivated(): boolean {
  return process.env[LIVE_ACTIVATION_ENV_VAR] === ENABLING_VALUE;
}

export interface RealEmailActivationGateObservability {
  envVarName: string;
  enabled: boolean;
  wasUnset: boolean;
}

/** Résumé sans secret, destiné à l'observabilité/au logging -- jamais
 *  la valeur brute de la variable, uniquement le booléen résolu +
 *  "était-elle absente". */
export function describeRealEmailActivationGateForObservability(): RealEmailActivationGateObservability {
  const raw = process.env[LIVE_ACTIVATION_ENV_VAR];
  return {
    envVarName: LIVE_ACTIVATION_ENV_VAR,
    enabled: raw === ENABLING_VALUE,
    wasUnset: typeof raw === "undefined",
  };
}
