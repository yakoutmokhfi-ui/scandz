import "server-only";

/**
 * PR #196 R3 (contre-audit de 9e38c88, P2 « budget temporel contourné si l'horloge recule »).
 *
 * Le budget du worker (A196-05) était exprimé par une date murale (`Date.now()` + durée) comparée à
 * `Date.now()` : si l'horloge système RECULE pendant l'exécution (pas NTP, correction de dérive, hôte
 * virtualisé), la comparaison reste fausse aussi longtemps que le recul, et des envois démarrent bien
 * après les 150 s prévues -- jusqu'à dépasser le bail de 300 s et provoquer des doublons (la complétion
 * est alors refusée alors que le message est parti, puis le reap remet la ligne en attente).
 *
 * Un budget de durée se mesure sur une horloge MONOTONE (`performance.now()`, jamais ajustée par le
 * système) : il ne dépend plus de l'heure qu'il est. Module pur, sans dépendance, horloge injectable
 * pour les tests.
 */
export interface RunBudget {
  /** Vrai dès que la durée allouée est écoulée sur l'horloge monotone (ou si l'horloge est inutilisable : échec fermé). */
  expired(): boolean;
  /** Durée restante en ms, jamais négative. */
  remainingMs(): number;
}

export const monotonicNowMs = (): number => performance.now();

export function createRunBudget(totalMs: number, nowMs: () => number = monotonicNowMs): RunBudget {
  if (!Number.isFinite(totalMs) || totalMs < 0) throw new RangeError("run budget must be a finite, non-negative duration");
  const startedAt = nowMs();
  // Même une horloge injectée défectueuse ne peut pas RALLONGER le budget : on garde le plus haut instant vu.
  let highWater = startedAt;
  const elapsedMs = (): number => {
    const now = nowMs();
    if (!Number.isFinite(now) || !Number.isFinite(startedAt)) return Number.POSITIVE_INFINITY; // échec fermé
    if (now > highWater) highWater = now;
    return highWater - startedAt;
  };
  return {
    expired: () => elapsedMs() >= totalMs,
    remainingMs: () => Math.max(0, totalMs - elapsedMs()),
  };
}
