"use client";

import Link from "next/link";
import { requestTrackingRefresh } from "@/lib/tracking/refresh-lock";

/**
 * TRACKING FRESHNESS v1 — AUDIT REMEDIATION (issue #11, comment
 * `5884325325`, BLOCKER A : "the manual refresh action currently
 * sits outside the single-flight guard shared by the timer and focus
 * paths -- the timer, the focus listener, AND the manual refresh
 * action must share ONE concurrency gate").
 *
 * Remplace le `<Link href={cleanPath}>` NU qui vivait directement
 * dans `app/track/[orderId]/page.tsx` (repli manuel "Actualiser le
 * suivi", mandat §19). Repli SANS JavaScript INTACT : ce composant
 * rend TOUJOURS le MÊME `<Link href>`, avec le MÊME `aria-label` et
 * le MÊME contenu visible -- une navigation classique fonctionne
 * identiquement, avec ou sans JavaScript, et re-déclenche le Server
 * Component exactement comme avant ce lot (relit la session déjà
 * posée en cookie).
 *
 * La SEULE différence est un gestionnaire `onClick`, actif
 * UNIQUEMENT quand JavaScript s'exécute : il empêche la navigation
 * complète par défaut et appelle `requestTrackingRefresh()` à la
 * place.
 *
 * ROUND 2 (issue #11, comment `5885210667`, Margaux re-audit) : ce
 * composant n'a PLUS AUCUN état `useTransition`/verrou à lui --
 * Round 1 lui donnait sa propre `useTransition()` locale, ce qui
 * n'avait rien d'incorrect en soi mais dupliquait un mécanisme dont
 * l'UNIQUE source de vérité doit être `TrackingAutoRefresh` (voir le
 * commentaire de tête de ce fichier). `requestTrackingRefresh()`
 * (`lib/tracking/refresh-lock.ts`) transmet directement au
 * déclencheur canonique enregistré par `TrackingAutoRefresh`, gardé
 * par SA PROPRE `useTransition()`/`isPending` réel -- donc un clic
 * manuel pendant un rafraîchissement déjà en cours (minuteur, focus,
 * OU un clic manuel précédent) est ignoré exactement comme un tic de
 * minuteur l'aurait été, jamais empilé, jamais deux requêtes réseau
 * concurrentes, quelle que soit la combinaison des trois
 * déclencheurs. Aucun `router`/`mounted` local n'est plus nécessaire
 * ici : ce composant ne possède plus rien à protéger d'un appel
 * après démontage -- c'est `TrackingAutoRefresh` qui se
 * désenregistre lui-même du registre à son propre démontage (voir ce
 * fichier), auquel cas `requestTrackingRefresh()` dégrade en no-op
 * silencieux (voir `lib/tracking/refresh-lock.ts`).
 *
 * BLOCKER B (comment `5884325325`) : ce composant est monté aussi
 * bien sur le chemin de succès que sur les branches d'ERREUR
 * TRANSITOIRE de `page.tsx` (`TrackingServerUnavailableError` et
 * l'exception générique non classifiée) -- jamais sur les branches
 * TERMINALES (order_id malformé, session absente,
 * `TrackingLinkInvalidError`), qui continuent de ne rendre aucun
 * mécanisme de récupération, inchangé.
 */
export default function TrackingManualRefreshLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  function handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
    // Toujours intercepté quand JS s'exécute -- un clic pendant un
    // rafraîchissement déjà en cours (ailleurs) est simplement ignoré
    // par la garde mono-vol de `TrackingAutoRefresh` (même sémantique
    // que le minuteur/le focus), jamais laissé retomber sur une
    // navigation complète concurrente.
    event.preventDefault();
    requestTrackingRefresh();
  }

  return (
    <Link
      href={href}
      onClick={handleClick}
      aria-label={label}
      className="mt-8 inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-xl border border-caramel px-4 py-2 text-sm font-bold text-accent-dark-on-bg"
    >
      <span aria-hidden="true">⟳</span>
      <span>{label}</span>
    </Link>
  );
}
