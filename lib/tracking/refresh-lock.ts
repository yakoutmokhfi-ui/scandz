/**
 * TRACKING FRESHNESS v1 — AUDIT REMEDIATION, ROUND 2 (issue #11,
 * comment `5885210667`, Chateau Margaux re-audit relayed by Ravel) :
 * BLOCKER A REOPENED after Round 1 (commit `bee21b2`) -- Round 1's
 * shared lock (`attemptGatedRefresh`, boolean `locked`) released
 * based on inspecting `router.refresh()`'s return value for a
 * thenable. That branch is INERTE in real production --
 * `router.refresh()` always returns `void` there (verified directly
 * against Next.js's own source, see the mechanism comment in
 * `TrackingAutoRefresh.tsx`) -- so in production the Round 1 lock
 * released essentially IMMEDIATELY after the synchronous call to
 * `refresh()`, before the real network/render lifecycle had even
 * begun, defeating the single-flight guard entirely. Round 1's own
 * tests only ever exercised a promise-returning test double, proving
 * the MOCK's contract, never the PRODUCTION contract -- Margaux's
 * literal counter-proof: `{"calls":2,"contract":"refresh returns
 * void"}`. A second, independent gap Margaux flagged: no
 * `try`/`finally` protection, so a synchronous throw could leave the
 * lock stuck forever.
 *
 * ROUND 2 DESIGN -- this module is no longer the LOCK itself. It is a
 * tiny REGISTRY. The actual single-flight guard now lives entirely
 * inside `TrackingAutoRefresh` (see that file's head comment for the
 * full mechanism), gated by the REAL `isPending` returned from the
 * SAME `useTransition()` call that wraps `router.refresh()` --
 * exactly the "observable page/render completion signal that
 * actually exists in this architecture" Margaux's own re-audit
 * comment offered as an acceptable direction -- NEVER derived from
 * `refresh()`'s return value.
 *
 * Pourquoi un module singleton (état de fermeture, PAS un state
 * React) plutôt qu'un Context ou un state levé plus haut dans
 * l'arbre : inchangé depuis Round 1 -- les trois déclencheurs vivent
 * dans DEUX composants distincts, ni imbriqués ni parents l'un de
 * l'autre -- `TrackingAutoRefresh` (minuteur + focus, propriétaire de
 * l'UNIQUE `useTransition()`) et `TrackingManualRefreshLink` (clic
 * manuel) sont tous deux montés comme enfants DIRECTS de la même page
 * (`app/track/[orderId]/page.tsx`), jamais l'un dans l'autre. Un
 * Context Provider aurait déplacé la position de rendu du lien
 * "Actualiser le suivi" ou ajouté un wrapper autour de tout le
 * contenu de la page pour un gain nul (rien ici ne dépend d'un
 * RE-RENDU quand le verrou change d'état -- c'est une garde de
 * CONCURRENCE, jamais un indicateur visuel). Le registre ci-dessous
 * résout le même problème de partage sans restructurer l'arbre : il
 * laisse `TrackingAutoRefresh` posséder la SEULE source de vérité
 * (`useTransition()`), et donne à `TrackingManualRefreshLink` un
 * moyen de l'ATTEINDRE plutôt que d'en posséder une copie.
 *
 * INVARIANT (vrai par construction dans `app/track/[orderId]/page.tsx`,
 * NON imposé par ce module) : `TrackingManualRefreshLink` n'est
 * JAMAIS rendu sur une branche où `TrackingAutoRefresh` ne l'est pas
 * AUSSI -- les deux se montent ensemble sur toute branche qui affiche
 * l'un ou l'autre (chemin de succès, `TrackingServerUnavailableError`,
 * exception générique), et aucun des deux ne se monte sur une branche
 * TERMINALE. Si cet invariant était un jour violé,
 * `requestTrackingRefresh()` dégrade SANS DANGER vers un no-op
 * silencieux (voir ci-dessous) plutôt que de lever une exception : un
 * clic manuel sans déclencheur enregistré ne fait simplement rien,
 * jamais un crash.
 *
 * Sûreté SSR : inchangée depuis Round 1 -- ce module n'est importé
 * QUE par des Client Components ("use client", voir
 * TrackingAutoRefresh.tsx et TrackingManualRefreshLink.tsx) et
 * n'appelle jamais aucune API React/Next.js lui-même -- il ne
 * s'exécute donc JAMAIS pendant un rendu serveur. Son état de
 * fermeture obtient une instance PAR ONGLET NAVIGATEUR (un module JS
 * chargé côté client), jamais partagée entre requêtes serveur ni
 * entre utilisateurs.
 */

type TrackingRefreshTrigger = () => void;

let registeredTrigger: TrackingRefreshTrigger | null = null;

/**
 * Enregistre le déclencheur CANONIQUE unique (possédé par
 * `TrackingAutoRefresh`, qui applique lui-même sa propre garde
 * mono-vol synchrone avant d'appeler `router.refresh()` -- voir ce
 * fichier). Renvoie une fonction de désenregistrement, appelée par le
 * nettoyage du propre effet de ce composant (démontage OU ré-exécution
 * de l'effet) -- pour qu'un clic manuel après démontage de
 * `TrackingAutoRefresh` (changement de page) ne puisse jamais
 * atteindre une fermeture figée sur un `router`/`startTransition`
 * d'un composant déjà démonté.
 *
 * Un second enregistrement concurrent (ne devrait jamais arriver,
 * étant donné l'invariant ci-dessus -- une seule `TrackingAutoRefresh`
 * par page) REMPLACE le précédent plutôt que de s'empiler : ce module
 * n'a donc jamais besoin de raisonner sur plus d'un enregistrement à
 * la fois.
 */
export function registerTrackingRefreshTrigger(trigger: TrackingRefreshTrigger): () => void {
  registeredTrigger = trigger;
  return () => {
    if (registeredTrigger === trigger) {
      registeredTrigger = null;
    }
  };
}

/**
 * Appelé par le gestionnaire `onClick` de `TrackingManualRefreshLink`.
 * Transmet au déclencheur actuellement enregistré -- qui applique SA
 * PROPRE garde mono-vol en interne (voir `TrackingAutoRefresh.tsx`) --
 * donc un clic manuel pendant un rafraîchissement déjà en cours
 * (minuteur, focus, OU un clic manuel précédent) est ignoré exactement
 * comme un tic de minuteur l'aurait été, jamais empilé, jamais deux
 * requêtes réseau concurrentes.
 *
 * No-op silencieux quand rien n'est enregistré (voir invariant
 * ci-dessus) -- jamais une exception.
 */
export function requestTrackingRefresh(): void {
  registeredTrigger?.();
}

/** Échappatoire réservée aux tests : réinitialise le registre entre
 *  cas isolés, pour qu'aucun test ne laisse fuiter son propre
 *  déclencheur enregistré vers le test suivant (le module est un
 *  singleton pour toute la durée de vie du process Node du fichier de
 *  test, exactement comme il l'est pour la durée de vie d'un onglet
 *  navigateur réel). */
export function __resetTrackingRefreshRegistryForTests(): void {
  registeredTrigger = null;
}
