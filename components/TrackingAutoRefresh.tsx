"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * CUSTOMER TRACKING EXPERIENCE v2 — rafraîchissement automatique léger
 * de la page de suivi (mandat §19, ~15s acceptable pour le MVP si les
 * tests confirment un comportement sûr).
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
 * lui-même aucune règle métier de statut.
 *
 * CUSTOMER TRACKING EXPERIENCE v2.1 (ferme CTE-V2-AUTOREFRESH-01, LOW,
 * Work re-audit de v2) : GARDE MONO-VOL ("single-flight guard") --
 * chaque tick de `setInterval` est désormais IGNORÉ si un rafraîchissement
 * précédent est encore en cours, plutôt que d'empiler un second
 * `router.refresh()` par-dessus un premier qui n'a pas encore abouti
 * (réseau lent -> requêtes concurrentes redondantes vers le serveur).
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
 * `isPendingRef` : `setInterval` capture la closure de son premier
 * rendu -- sans ce miroir par ref, `isPending` y resterait figé à sa
 * valeur initiale (même piège, et même remède, que `mounted`
 * ci-dessous, déjà établi dans ce fichier avant v2.1).
 *
 * La branche `result && typeof result.then === "function"` est
 * INERTE en production réelle (`router.refresh()` y retourne
 * toujours `void`, jamais un thenable -- ce test ne s'y déclenche
 * donc jamais) ; elle existe UNIQUEMENT pour permettre à un double de
 * test de fournir une promesse dont la résolution est entièrement
 * contrôlée par le test, rendant la garde mono-vol vérifiable de
 * façon déterministe sans reproduire l'intégralité du mécanisme
 * interne de Next.js dans un bouchon de test.
 */
export default function TrackingAutoRefresh({
  enabled,
  intervalMs = 15_000,
}: {
  enabled: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();
  // Évite un intervalle fantôme après démontage (changement de page) --
  // même précaution que les autres effets à minuteur de ce dépôt.
  const mounted = useRef(true);
  const [isPending, startTransition] = useTransition();
  const isPendingRef = useRef(isPending);
  isPendingRef.current = isPending;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      if (!mounted.current) return;
      // Mandat CTE-V2-AUTOREFRESH-01 : garde mono-vol -- ce tick est
      // simplement IGNORÉ (jamais mis en file, jamais reporté) si un
      // rafraîchissement précédent est encore en attente ; le tick
      // SUIVANT (toujours à la cadence ~15s inchangée) retentera
      // normalement.
      if (isPendingRef.current) return;
      startTransition(() => {
        const result: unknown = router.refresh();
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(() => undefined);
        }
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, router]);

  return null;
}
