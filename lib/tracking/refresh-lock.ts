/**
 * TRACKING FRESHNESS v1 — AUDIT REMEDIATION (issue #11, comment
 * `5884325325`, BLOCKER A : "the manual refresh action currently sits
 * outside the single-flight guard shared by the timer and focus
 * paths -- the timer, the focus listener, AND the manual refresh
 * action must share ONE concurrency gate").
 *
 * Pourquoi un module singleton (état de fermeture, PAS un state
 * React) plutôt qu'un Context ou un state levé plus haut dans
 * l'arbre : les trois déclencheurs vivent dans DEUX composants
 * distincts, ni imbriqués ni parents l'un de l'autre --
 * `TrackingAutoRefresh` (minuteur + focus) et
 * `TrackingManualRefreshLink` (clic manuel) sont tous deux montés
 * comme enfants DIRECTS de la même page (`app/track/[orderId]/page.tsx`),
 * jamais l'un dans l'autre -- donc un state React local à l'un des
 * deux ne peut, par construction, jamais être visible de l'autre.
 * Restructurer l'arbre pour introduire un Context Provider aurait
 * déplacé la position de rendu du lien "Actualiser le suivi" ou
 * ajouté un wrapper autour de tout le contenu de la page pour un gain
 * nul (rien ici ne dépend d'un RE-RENDU quand le verrou change d'état
 * -- c'est une garde de CONCURRENCE, jamais un indicateur visuel).
 *
 * Sûreté SSR : ce module n'est importé QUE par des Client Components
 * ("use client", voir TrackingAutoRefresh.tsx et
 * TrackingManualRefreshLink.tsx) et n'appelle jamais aucune API
 * React/Next.js lui-même -- il ne s'exécute donc JAMAIS pendant un
 * rendu serveur. Son état de fermeture obtient une instance PAR
 * ONGLET NAVIGATEUR (un module JS chargé côté client), jamais
 * partagée entre requêtes serveur ni entre utilisateurs -- contraire-
 * ment à un état module-level qui serait lu/écrit pendant un rendu
 * SERVEUR, ce qui serait unsafe (fuite entre requêtes concurrentes).
 */

let locked = false;

/**
 * Tente d'acquérir le verrou. Renvoie `true` et verrouille SI aucun
 * rafraîchissement n'est déjà en cours ; renvoie `false` SANS AUCUN
 * EFFET sinon -- le déclenchement est simplement IGNORÉ (jamais mis
 * en file, jamais reporté), même sémantique que la garde mono-vol
 * d'origine (CTE-V2-AUTOREFRESH-01) désormais étendue aux trois
 * déclencheurs.
 */
export function acquireTrackingRefreshLock(): boolean {
  if (locked) return false;
  locked = true;
  return true;
}

/**
 * Déverrouille INCONDITIONNELLEMENT. Appelé aussi bien après un
 * SUCCÈS qu'après un ÉCHEC réseau (BLOCKER A, point 4 : "lock release
 * after network error") -- voir `attemptGatedRefresh` ci-dessous, qui
 * l'appelle systématiquement depuis les DEUX branches d'un
 * settlement de promesse (résolution ET rejet), jamais seulement le
 * chemin heureux.
 */
export function releaseTrackingRefreshLock(): void {
  locked = false;
}

/** Échappatoire réservée aux tests : réinitialise le verrou entre cas
 *  isolés, pour qu'aucun test ne laisse fuiter son propre état de
 *  verrou vers le test suivant (le module est un singleton pour toute
 *  la durée de vie du process Node du fichier de test, exactement
 *  comme il l'est pour la durée de vie d'un onglet navigateur réel). */
export function __resetTrackingRefreshLockForTests(): void {
  locked = false;
}

/**
 * Point d'entrée PARTAGÉ des trois déclencheurs (tic de minuteur,
 * retour de focus, clic manuel) : acquiert le verrou, exécute le
 * rafraîchissement à l'intérieur du `startTransition` fourni par
 * l'appelant (React exige que l'appel déclenchant réellement l'état
 * -- ici `refresh()` -- ait lieu de façon SYNCHRONE à l'intérieur du
 * callback passé à `startTransition`, ce qui interdit de posséder
 * `startTransition` lui-même dans ce module non-composant), puis
 * relâche le verrou -- sur succès ET sur échec, jamais seulement l'un
 * des deux.
 *
 * `refresh` renvoie `unknown` plutôt que `void` UNIQUEMENT pour
 * permettre à un double de test de fournir une promesse dont la
 * résolution/le rejet est entièrement contrôlé par le test (en
 * production réelle, `router.refresh()` renvoie toujours `void` --
 * cette branche `thenable` n'y est jamais empruntée, voir le
 * commentaire de tête de TrackingAutoRefresh.tsx pour la preuve
 * empirique déjà établie avant ce lot) ; le verrou est alors relâché
 * immédiatement après l'appel synchrone, faute de promesse à
 * observer.
 */
export function attemptGatedRefresh(
  mounted: { readonly current: boolean },
  startTransition: (callback: () => void | Promise<void>) => void,
  refresh: () => unknown
): void {
  if (!mounted.current) return;
  if (!acquireTrackingRefreshLock()) return;
  startTransition(() => {
    const result: unknown = refresh();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      return (result as Promise<unknown>).then(
        () => releaseTrackingRefreshLock(),
        () => releaseTrackingRefreshLock()
      );
    }
    releaseTrackingRefreshLock();
  });
}
