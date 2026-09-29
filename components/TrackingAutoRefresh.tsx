"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attemptGatedRefresh } from "@/lib/tracking/refresh-lock";

/**
 * CUSTOMER TRACKING EXPERIENCE v2 — rafraîchissement automatique léger
 * de la page de suivi (mandat §19).
 *
 * DÉLIBÉRÉMENT `router.refresh()` (Next.js App Router), JAMAIS un
 * second appel Supabase direct depuis ce composant client : la seule
 * île client de cette page ne connaît NI `order_id` NI `public_token`
 * -- `router.refresh()` demande au SERVEUR Next.js de ré-exécuter le
 * Server Component (app/track/[orderId]/page.tsx), qui relit la
 * preuve de possession depuis le COOKIE DE SESSION HttpOnly (mandat
 * §9/§10, lib/server/tracking-session.ts), jamais depuis l'URL. Le
 * jeton ne transite donc JAMAIS dans l'URL de rafraîchissement (mandat
 * §19, "no public_token in refresh URL") ni dans aucune requête réseau
 * visible/journalisable côté navigateur (mandat §12, "no token
 * logging"). AUCUN script tiers, AUCUNE bibliothèque d'analytics n'est
 * chargée sur cette page pour intercepter quoi que ce soit de toute
 * façon.
 *
 * S'ARRÊTE (mandat §19, "stop for terminal: completed/rejected/
 * cancelled") dès que `enabled` devient `false` -- l'appelant (le
 * Server Component) calcule `enabled` à partir de `isTerminalStatus`
 * (lib/tracking/status.ts) à CHAQUE rendu ; ce composant ne connaît
 * lui-même aucune règle métier de statut. TOUS les mécanismes de ce
 * fichier (minuteur ET écouteur de focus ci-dessous) s'arrêtent avec
 * `enabled` -- aucun ne fonctionne indépendamment de lui.
 *
 * CUSTOMER TRACKING EXPERIENCE v2.1 (ferme CTE-V2-AUTOREFRESH-01, LOW,
 * Work re-audit de v2) : GARDE MONO-VOL ("single-flight guard") --
 * un déclenchement (tick de minuteur OU retour de focus, voir
 * TRACKING FRESHNESS v1 ci-dessous) est désormais IGNORÉ si un
 * rafraîchissement précédent est encore en cours, plutôt que
 * d'empiler un second `router.refresh()` par-dessus un premier qui
 * n'a pas encore abouti (réseau lent -> requêtes concurrentes
 * redondantes vers le serveur).
 *
 * MÉCANISME (vérifié directement dans le code source de Next.js livré
 * dans ce dépôt, node_modules/next/dist/client/components/
 * app-router-instance.js, fonction dispatchAction -- PAS une simple
 * supposition) : `router.refresh()` enveloppe DÉJÀ, en interne,
 * `setState(deferredPromise)` dans son PROPRE `startTransition` --
 * c'est-à-dire que l'état interne du routeur devient une PROMESSE
 * réellement en attente pendant toute la durée du rafraîchissement
 * réseau réel. En enveloppant l'appel `router.refresh()` dans NOTRE
 * PROPRE `startTransition` (via `useTransition` ci-dessous), React
 * garde `isPending` VRAI tant que cette promesse imbriquée n'est pas
 * résolue -- exactement le patron documenté par Next.js pour afficher
 * un état "en cours" autour de `router.refresh()`/`router.push()`,
 * vérifié ici empiriquement (voir 21-AUTOREFRESH-SINGLE-FLIGHT-REPORT.txt)
 * avant d'être choisi comme correctif plutôt que supposé correct.
 *
 * TRACKING FRESHNESS v1 — AUDIT REMEDIATION (issue #11, comment
 * `5884325325`, BLOCKER A) : la garde mono-vol elle-même a été
 * EXTRAITE de ce fichier vers un module partagé
 * (`lib/tracking/refresh-lock.ts`, `attemptGatedRefresh`), pour que
 * le clic manuel "Actualiser le suivi" (`TrackingManualRefreshLink`,
 * composant SÉPARÉ, ni parent ni enfant de celui-ci) l'acquière
 * exactement de la MÊME façon que le tic de minuteur et le retour de
 * focus ci-dessous -- les TROIS déclencheurs partagent désormais UN
 * SEUL verrou, jamais deux requêtes réseau concurrentes quelle que
 * soit la combinaison de déclencheurs. L'ancien miroir local
 * `isPendingRef` (nécessaire uniquement pour exposer `isPending` de
 * `useTransition` à des callbacks à closure figée) a disparu avec
 * lui : `attemptGatedRefresh` lit/écrit directement l'état du module
 * partagé, jamais une valeur capturée par une closure de rendu, donc
 * plus aucun besoin de miroir par ref pour CE mécanisme. `mounted`
 * (ci-dessous) reste nécessaire pour sa propre raison, inchangée :
 * éviter d'invoquer `router.refresh()` après démontage.
 *
 * La branche `result && typeof result.then === "function"` est
 * INERTE en production réelle (`router.refresh()` y retourne
 * toujours `void`, jamais un thenable -- ce test ne s'y déclenche
 * donc jamais) ; elle existe UNIQUEMENT pour permettre à un double de
 * test de fournir une promesse dont la résolution est entièrement
 * contrôlée par le test, rendant la garde mono-vol vérifiable de
 * façon déterministe sans reproduire l'intégralité du mécanisme
 * interne de Next.js dans un bouchon de test.
 *
 * ------------------------------------------------------------------
 * TRACKING FRESHNESS v1 (issue #11, comment 5883794674, Ravel)
 * ------------------------------------------------------------------
 * Trois changements, chacun isolé de PR #115 (navigation), PR #116
 * (XLSX/PSM), Lot 2 withdrawal, CGV, ACK email et test-baseline
 * cleanup :
 *
 * 1. CADENCE 5s (`intervalMs` par défaut : 15_000 -> 5_000). Le site
 *    d'appel (app/track/[orderId]/page.tsx) reste INCHANGÉ
 *    (`<TrackingAutoRefresh enabled={!terminal} />`), donc la
 *    non-régression `tests/tracking-storefront-visual-alignment.test.ts`
 *    (qui vérifie cette ligne EXACTE comme une "autorité de suivi")
 *    reste valide sans modification.
 *
 * 2. PAUSE PENDANT QUE L'ONGLET EST CACHÉ. Le tic du minuteur vérifie
 *    `document.visibilityState === "hidden"` et n'appelle PAS
 *    `router.refresh()` dans ce cas -- AUCUNE requête réseau tant que
 *    l'onglet n'est pas visible. Le minuteur JS lui-même continue de
 *    tourner (coût nul, aucun effet observable, aucune requête) plutôt
 *    que d'être détruit/recréé à chaque bascule de visibilité --
 *    volontairement simple, mandat "no WebSocket/realtime complexity
 *    unless a concrete requirement proves it necessary" appliqué ici
 *    aussi à la mécanique de pause elle-même.
 *
 * 3. RAFRAÎCHISSEMENT IMMÉDIAT AU RETOUR DU FOCUS. Un écouteur
 *    `window.addEventListener("focus", ...)` SÉPARÉ du minuteur,
 *    actif seulement tant que `enabled` est vrai, déclenche un
 *    `router.refresh()` immédiat via la MÊME fonction de
 *    déclenchement (donc la MÊME garde mono-vol) que le minuteur --
 *    jamais un appel concurrent à un rafraîchissement déjà en cours.
 *    DEUX mécanismes distincts (visibilité pour la pause, focus pour
 *    le rafraîchissement immédiat) plutôt qu'un seul : changer
 *    d'onglet déclenche les deux (le focus de fenêtre suit la
 *    bascule de visibilité dans la quasi-totalité des navigateurs),
 *    mais changer d'application (alt-tab) ne déclenche QUE
 *    blur/focus -- l'onglet reste "visible" au sens de la Page
 *    Visibility API pendant que la fenêtre du navigateur perd le
 *    focus -- d'où la nécessité des deux écouteurs pour couvrir
 *    "tab/window regains focus" au sens littéral du mandat.
 *
 * États terminaux : comportement `enabled` INCHANGÉ (déjà conforme,
 * rien à modifier). Repli manuel "Actualiser le suivi" : un composant
 * SÉPARÉ (`TrackingManualRefreshLink.tsx`) -- non touché par le lot
 * TRACKING FRESHNESS v1 original, mais désormais RELIÉ à ce fichier
 * par le verrou partagé de `lib/tracking/refresh-lock.ts` depuis
 * l'AUDIT REMEDIATION ci-dessus (BLOCKER A).
 */
export default function TrackingAutoRefresh({
  enabled,
  intervalMs = 5_000,
}: {
  enabled: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();
  // Évite un intervalle/écouteur fantôme après démontage (changement
  // de page) -- même précaution que les autres effets à minuteur de
  // ce dépôt.
  const mounted = useRef(true);
  const [, startTransition] = useTransition();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    // Fonction de déclenchement UNIQUE, partagée entre le tic du
    // minuteur et l'écouteur de focus (TRACKING FRESHNESS v1) -- et,
    // depuis l'AUDIT REMEDIATION BLOCKER A, avec le clic manuel
    // "Actualiser le suivi" d'un composant SÉPARÉ, via le MÊME verrou
    // partagé (`attemptGatedRefresh`, `lib/tracking/refresh-lock.ts`).
    // Un déclenchement (tic, focus, OU clic manuel ailleurs sur la
    // page) ne peut donc JAMAIS empiler un `router.refresh()`
    // par-dessus un autre encore en attente, quelle que soit la
    // combinaison des trois.
    function triggerRefresh() {
      attemptGatedRefresh(mounted, startTransition, () => router.refresh());
    }

    const id = setInterval(() => {
      // TRACKING FRESHNESS v1, point 2 : onglet caché -> aucune
      // requête réseau. Le minuteur continue de tourner (voir
      // commentaire de tête) mais ce tic n'appelle jamais
      // `triggerRefresh`.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      triggerRefresh();
    }, intervalMs);

    // TRACKING FRESHNESS v1, point 3 : retour de focus fenêtre/onglet
    // -> rafraîchissement immédiat, sans attendre le prochain tic.
    //
    // AUDIT REMEDIATION (issue #11, comment `5884325325`) : l'audit a
    // relevé que ce gestionnaire ne vérifiait PAS lui-même la
    // visibilité, en demandant de vérifier si cela pouvait déclencher
    // une requête inutile pendant que l'onglet est caché. Un
    // événement `focus` fenêtre PENDANT que `document.visibilityState`
    // vaut `"hidden"` est un cas marginal mais réel (ex. focus
    // programmatique, ou bascule OS où le focus fenêtre et la
    // visibilité d'onglet ne changent pas de façon parfaitement
    // synchrone) -- désormais gardé par la MÊME vérification que le
    // tic de minuteur, pour ne jamais émettre de requête réseau tant
    // que la page n'est pas visible, quel que soit le déclencheur.
    function onFocus() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      triggerRefresh();
    }
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, intervalMs, router]);

  return null;
}
