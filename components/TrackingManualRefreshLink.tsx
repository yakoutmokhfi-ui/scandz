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
 * TERMINALES au sens "lien invalide" (order_id malformé, session
 * absente, `TrackingLinkInvalidError`), qui continuent de ne rendre
 * aucun mécanisme de récupération, inchangé.
 *
 * ROUND 4 (issue #11, Ravel relayant Château Margaux -- régression
 * repli manuel en STATUT DE COMMANDE terminal) : sur le chemin de
 * succès, ce composant reste monté INCONDITIONNELLEMENT quel que soit
 * le statut de la commande -- y compris `completed`/`rejected`/
 * `cancelled` -- alors que `TrackingAutoRefresh`, lui, n'enregistre
 * AUCUN déclencheur canonique sur ces statuts (`enabled={false}`, voir
 * `app/track/[orderId]/page.tsx`). L'ancien `handleClick`
 * n'en tenait pas compte : il appelait toujours `preventDefault()`
 * avant de transmettre au registre, produisant -- sur un statut
 * terminal, avec JS actif -- un no-op TOTAL (ni rafraîchissement, ni
 * navigation), cassant au passage le repli de navigation normale que
 * ce composant promet pourtant explicitement (voir plus haut). Ce
 * composant appelle désormais `preventDefault()` UNIQUEMENT quand
 * `requestTrackingRefresh()` signale qu'un déclencheur canonique a
 * réellement pris en charge la demande ; sinon, il laisse la
 * navigation `href` réelle suivre son cours -- exactement le
 * comportement sans JavaScript, obtenu ici même AVEC JavaScript actif,
 * précisément parce qu'aucun mécanisme n'écoute. Statut actif ou
 * erreur transitoire (déclencheur enregistré) : comportement
 * inchangé, clic toujours intercepté.
 */
export default function TrackingManualRefreshLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  function handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
    // ROUND 4 : on demande D'ABORD au registre s'il y a un déclencheur
    // canonique à traiter, et on n'empêche la navigation par défaut que
    // si la réponse est oui.
    //
    // Déclencheur enregistré (statut actif, ou erreur transitoire avec
    // récupération lente) : comportement inchangé depuis Round 2 -- un
    // clic pendant un rafraîchissement déjà en cours (ailleurs) est
    // simplement ignoré par la garde mono-vol de `TrackingAutoRefresh`
    // (même sémantique que le minuteur/le focus), jamais laissé
    // retomber sur une navigation complète concurrente.
    //
    // Aucun déclencheur enregistré (statut de commande terminal --
    // `completed`/`rejected`/`cancelled` -- où `TrackingAutoRefresh` est
    // monté avec `enabled={false}` et n'enregistre donc rien) : on NE
    // PAS empêcher la navigation par défaut, pour laisser le vrai
    // `href` de ce `<Link>` suivre son cours normalement -- exactement
    // le repli sans JavaScript, préservé ici même avec JavaScript actif.
    const handled = requestTrackingRefresh();
    if (handled) {
      event.preventDefault();
    }
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
