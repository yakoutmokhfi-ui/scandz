"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { registerTrackingRefreshTrigger } from "@/lib/tracking/refresh-lock";

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
 * avant d'être choisi comme correctif plutôt que supposé correct. En
 * production, `router.refresh()` renvoie `void` -- `isPending`
 * reflète tout de même fidèlement la durée réelle du rafraîchissement
 * parce que React "coalesce" le travail de la transition interne du
 * routeur SOUS le flag `isPending` de NOTRE transition englobante,
 * indépendamment de ce que `refresh()` lui-même renvoie à l'appelant.
 *
 * ------------------------------------------------------------------
 * TRACKING FRESHNESS v1 — AUDIT REMEDIATION, ROUND 2 (issue #11,
 * comment `5885210667`, Chateau Margaux re-audit relayé par Ravel) :
 * BLOCKER A REOUVERT après Round 1 (commit `bee21b2`)
 * ------------------------------------------------------------------
 * Round 1 avait extrait la garde mono-vol vers un module partagé
 * (`lib/tracking/refresh-lock.ts`, `attemptGatedRefresh`) qui
 * relâchait le verrou en inspectant la valeur de retour de
 * `refresh()` pour un thenable -- INERTE en production réelle
 * (`router.refresh()` y renvoie toujours `void`, voir ci-dessus),
 * donc le verrou se relâchait pratiquement IMMÉDIATEMENT après
 * l'appel synchrone à `refresh()`, avant même que le vrai cycle
 * réseau/rendu ait commencé -- le verrou ne protégeait plus rien en
 * production. Les tests de Round 1 n'avaient exercé qu'un double de
 * test renvoyant une promesse, prouvant le contrat du MOCK, jamais le
 * contrat de PRODUCTION -- contre-preuve littérale de Margaux :
 * `{"calls":2,"contract":"refresh returns void"}`. Second écart
 * relevé : aucune protection `try`/`finally`, donc un lancer (throw)
 * synchrone pouvait laisser le verrou bloqué indéfiniment.
 *
 * ROUND 2 -- la garde mono-vol elle-même REVIENT dans CE fichier
 * (comme en v2.1, avant Round 1), mais renforcée par DEUX mécanismes
 * qui n'existaient ni en v2.1 ni en Round 1 :
 *
 * 1. `busyRef` (garde SYNCHRONE, posée à `true` l'INSTANT où un
 *    déclenchement est ACCEPTÉ, AVANT même l'appel à
 *    `startTransition`) -- protège contre une VRAIE RAFALE
 *    synchrone (ex. focus + clic manuel + tic de minuteur
 *    déclenchés à la suite dans la MÊME exécution de script, avant
 *    que React n'ait eu l'occasion de re-rendre). Un simple miroir
 *    `isPendingRef` mis à jour seulement au rendu (l'approche v2.1
 *    et pré-Round-1) NE PROTÈGE PAS contre ce cas -- confirmé de
 *    façon empirique avant ce lot : trois appels synchrones passent
 *    TOUS quand la seule garde est un ref mis à jour uniquement par
 *    le rendu.
 * 2. `busyRef` n'est JAMAIS relâché de façon synchrone ni en
 *    inspectant la valeur de retour de `refresh()` -- il ne l'est
 *    QUE par l'effet ci-dessous, qui observe le VRAI `isPending`
 *    (même `useTransition()` que celui qui enveloppe
 *    `router.refresh()`) -- exactement le "signal observable de
 *    complétion de page/rendu qui existe réellement dans cette
 *    architecture" que Margaux elle-même proposait comme direction
 *    acceptable dans son re-audit.
 * 3. `try`/`catch` À L'INTÉRIEUR du callback passé à
 *    `startTransition`, enveloppant l'appel à `router.refresh()` :
 *    un lancer (throw) synchrone qui S'ÉCHAPPE de ce callback laisse
 *    `isPending` de React bloqué à `true` POUR TOUJOURS (confirmé
 *    empiriquement avant ce lot : aucune ré-exécution d'effet
 *    ultérieure ne montre plus jamais `isPending: false` après un
 *    tel lancer non intercepté) -- ce qui bloquerait `busyRef` de la
 *    même façon, puisque son relâchement dépend lui-même
 *    d'`isPending`. Intercepter ICI, pour que rien ne s'échappe du
 *    callback, est ce qui permet au mécanisme de se rétablir après
 *    une exception synchrone (scénario obligatoire de re-audit
 *    Margaux n°6).
 *
 * PARTAGE ENTRE LES TROIS DÉCLENCHEURS : `TrackingManualRefreshLink`
 * (composant SÉPARÉ, ni parent ni enfant de celui-ci) n'a désormais
 * PLUS AUCUN état `useTransition`/verrou à lui -- son clic appelle
 * `requestTrackingRefresh()` (`lib/tracking/refresh-lock.ts`), qui
 * transmet à la fonction `triggerRefresh` ci-dessous, ENREGISTRÉE
 * dans ce module partagé au montage de CE composant (voir l'effet
 * "enabled" plus bas) et désenregistrée à son nettoyage. Le tic de
 * minuteur, le retour de focus, ET le clic manuel appellent donc
 * TOUS la MÊME instance de `triggerRefresh`, gardée par le MÊME
 * `busyRef`/`isPending` -- jamais trois gardes indépendantes qui
 * s'accordent simplement par coïncidence, et jamais une garde dont le
 * relâchement dépend de ce que `refresh()` renvoie.
 *
 * La branche `result && typeof result.then === "function"` reste
 * INERTE en production réelle (`router.refresh()` y renvoie toujours
 * `void`, jamais un thenable) ; elle existe UNIQUEMENT pour permettre
 * à un double de test de fournir une promesse dont la
 * résolution/le rejet est entièrement contrôlé par le test, afin de
 * vérifier `busyRef`/`isPending` de façon déterministe SANS que cette
 * branche ne soit jamais ce qui "referme" BLOCKER A -- c'est le
 * scénario `void` explicite (scénario obligatoire n°1, `refresh`
 * renvoyant littéralement `undefined`) qui le referme.
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
 *    "tab/window regains focus" au sens littéral du mandat. Un
 *    événement `focus` PENDANT que l'onglet est marqué "hidden" (cas
 *    marginal mais réel) est gardé par la MÊME vérification de
 *    visibilité que le tic de minuteur (AUDIT REMEDIATION Round 1,
 *    BLOCKER A complément, comment `5884325325` -- inchangé en
 *    Round 2).
 *
 * États terminaux : comportement `enabled` INCHANGÉ (déjà conforme,
 * rien à modifier). Repli manuel "Actualiser le suivi" : un composant
 * SÉPARÉ (`TrackingManualRefreshLink.tsx`) -- relié à ce fichier par
 * le registre partagé de `lib/tracking/refresh-lock.ts`.
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
  const [isPending, startTransition] = useTransition();

  // ROUND 2 : garde synchrone même-tick -- voir le commentaire de
  // tête, point 1. Posée à `true` par `triggerRefresh` avant même
  // l'appel à `startTransition`.
  const busyRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ROUND 2 : relâche `busyRef` UNIQUEMENT quand `isPending` (le VRAI
  // signal, celui de la MÊME `useTransition()` qui enveloppe
  // `router.refresh()` ci-dessous) redevient `false` -- jamais de
  // façon synchrone, jamais en fonction de ce que `refresh()` renvoie.
  // Voir le commentaire de tête, point 2.
  useEffect(() => {
    if (!isPending) {
      busyRef.current = false;
    }
  }, [isPending]);

  useEffect(() => {
    if (!enabled) return;

    // Fonction de déclenchement UNIQUE, partagée entre le tic du
    // minuteur, l'écouteur de focus ci-dessous, ET (via le registre
    // `lib/tracking/refresh-lock.ts`) le clic manuel d'un composant
    // SÉPARÉ (`TrackingManualRefreshLink`) -- garantit que les TROIS
    // déclencheurs passent par la MÊME `useTransition()`, gardée par
    // le MÊME `busyRef`/`isPending`, jamais trois gardes
    // indépendantes.
    function triggerRefresh() {
      if (!mounted.current) return;
      if (busyRef.current) return;
      busyRef.current = true;
      startTransition(() => {
        // ROUND 2, point 3 du commentaire de tête : `try`/`catch` À
        // L'INTÉRIEUR de ce callback -- rien ne doit jamais
        // s'échapper vers React (voir justification empirique
        // ci-dessus). Le prochain déclenchement (tic, focus, ou clic
        // manuel) retentera normalement une fois `isPending` retombé
        // à `false`.
        try {
          const result: unknown = router.refresh();
          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<unknown>).then(
              () => undefined,
              () => undefined
            );
          }
        } catch {
          // Avalé délibérément -- voir commentaire de tête, point 3.
        }
      });
    }

    // Enregistre le déclencheur canonique auprès du registre partagé
    // pour que `TrackingManualRefreshLink` puisse l'atteindre via
    // `requestTrackingRefresh()`. Désenregistré au nettoyage (fin de
    // vie de cet effet OU démontage) pour qu'un clic manuel ne puisse
    // jamais atteindre une fermeture figée sur un `router` déjà
    // périmé.
    const unregister = registerTrackingRefreshTrigger(triggerRefresh);

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
    function onFocus() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      triggerRefresh();
    }
    window.addEventListener("focus", onFocus);

    return () => {
      unregister();
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, intervalMs, router]);

  return null;
}
