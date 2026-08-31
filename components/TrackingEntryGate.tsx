"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { translate, type Lang } from "@/lib/i18n";
import { isPlausibleUuid } from "@/lib/tracking/uuid";
import { buildCleanTrackingPath } from "@/lib/tracking/link";

/**
 * CUSTOMER TRACKING EXPERIENCE v2 — porte d'ENTRÉE côté client
 * (mandat §8).
 *
 * Rendue par app/track/[orderId]/page.tsx UNIQUEMENT quand ce Server
 * Component n'a trouvé AUCUNE session de présentation valide pour
 * cette commande (absente, expirée, ou n'appartenant pas à cette
 * commande) -- ce composant est donc le SEUL endroit de tout ce lot où
 * `location.hash` (donc potentiellement `public_token`) est lu par du
 * JavaScript navigateur.
 *
 * SÉQUENCE (mandat §8, reproduite littéralement) :
 *   1. lit `location.hash` au montage ;
 *   2. absent/mal formé -> état "invalide" GÉNÉRIQUE immédiatement,
 *      AUCUN appel réseau (mandat §13, échec fermé) -- couvre aussi le
 *      cas d'un scanner de lien SANS JavaScript (mandat §23 : ce
 *      composant ne s'exécute alors simplement jamais, et le Server
 *      Component parent n'a de toute façon rien envoyé de plus qu'une
 *      coquille vide) ;
 *   3. POST `{ orderId, publicToken }` en CORPS JSON vers
 *      `/api/track/exchange` (jamais dans l'URL) ;
 *   4. succès -> `history.replaceState` vers le chemin PROPRE (mandat
 *      §7/§22, retire le fragment de l'historique visible) PUIS
 *      `router.refresh()` (jamais l'inverse -- évite un instant où
 *      l'URL affichée porte encore le jeton pendant un nouveau rendu) ;
 *   5. échec -> état "invalide" ou "indisponible" GÉNÉRIQUE selon la
 *      catégorie renvoyée par le point de terminaison (mandat §13).
 *
 * `publicToken` n'est JAMAIS conservé dans un état React rendu à
 * l'écran, ni écrit dans `localStorage`/`sessionStorage` (mandat §10),
 * ni journalisé (`console.*` absent de ce fichier, y compris dans le
 * bloc `catch`, mandat §12) -- il ne vit que dans une variable locale
 * de fonction, le temps de construire le corps de la requête POST, et
 * n'est jamais retransmis après un succès (le point de terminaison ne
 * le renvoie pas non plus en écho -- voir route.ts).
 *
 * CUSTOMER TRACKING EXPERIENCE v2.1 (ferme CTE-V2-HISTORY-01, Work
 * re-audit de v2) : `rawHash` est désormais capturé une seule fois
 * PENDANT LE RENDU (initialiseur paresseux de `useState`, jamais relu
 * depuis `window.location.hash` à l'intérieur de l'effet) -- React
 * garantit que cette phase de rendu s'exécute AVANT tout effet, y
 * compris celui de components/TrackingFragmentScrubber.tsx, désormais
 * monté INCONDITIONNELLEMENT sur toute la page de suivi (y compris ici,
 * en frère de ce composant). Sans cette capture, l'ordre d'exécution
 * relatif des deux effets serait un détail d'implémentation React non
 * garanti : si le scrubber s'exécutait en premier et retirait déjà le
 * fragment de l'URL, ce composant relisant `window.location.hash`
 * verrait une chaîne vide et classerait à tort un premier lien
 * légitime comme invalide. La capture au rendu élimine cette course
 * par construction, quel que soit l'ordre réel des effets.
 *
 * CUSTOMER TRACKING EXPERIENCE v2.1 (ferme CTE-V2-MALFORMED-FRAGMENT-01) :
 * `decodeURIComponent` peut lever `URIError` sur un pourcentage isolé
 * ("%"), une séquence d'échappement tronquée ("%ZZ"), ou de l'UTF-8
 * tronqué/mal formé -- désormais explicitement intercepté ci-dessous,
 * jamais laissé remonter comme exception non gérée. Le résultat reste
 * IDENTIQUE à toute autre entrée mal formée (mandat §13) : état
 * "invalide" générique, AUCUN appel réseau.
 */

type GateState = "loading" | "invalid" | "unavailable";

export default function TrackingEntryGate({
  orderId,
  lang,
}: {
  orderId: string;
  lang: Lang;
}) {
  const router = useRouter();
  const [state, setState] = useState<GateState>("loading");
  // Capturé UNE SEULE FOIS pendant le rendu -- voir le commentaire de
  // tête v2.1 ci-dessus. `typeof window === "undefined"` couvre le
  // passage de rendu serveur de ce composant "use client" (Next.js
  // sert le HTML initial avant hydratation) ; `window` n'y existe pas.
  const [rawHash] = useState<string>(() =>
    typeof window === "undefined" ? "" : window.location.hash
  );

  useEffect(() => {
    let cancelled = false;

    // Mandat §13 : entrée absente/mal formée -> "invalide" générique,
    // AUCUN appel réseau (même posture que lib/server/tracking-
    // service.ts pour un order_id/public_token mal formé en amont de
    // la RPC).
    if (!rawHash || rawHash.length < 2) {
      setState("invalid");
      return;
    }
    let publicToken: string;
    try {
      // Mandat CTE-V2-MALFORMED-FRAGMENT-01 : décodage protégé -- voir
      // le commentaire de tête v2.1.
      publicToken = decodeURIComponent(rawHash.slice(1));
    } catch {
      setState("invalid");
      return;
    }
    if (!isPlausibleUuid(publicToken)) {
      setState("invalid");
      return;
    }

    (async () => {
      try {
        const res = await fetch("/api/track/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // `publicToken` ne quitte cette fonction QUE dans le corps
          // de CETTE requête -- jamais dans une URL, jamais dans un
          // en-tête, jamais journalisé ci-dessous.
          body: JSON.stringify({ orderId, publicToken }),
          credentials: "same-origin",
        });

        if (cancelled) return;

        if (res.ok) {
          // Mandat §7/§22 : retire le fragment de l'historique
          // visible AVANT de redemander le rendu serveur -- jamais de
          // fenêtre où l'URL affichée porte encore le jeton pendant
          // qu'un nouveau contenu se charge.
          window.history.replaceState(null, "", buildCleanTrackingPath(orderId));
          router.refresh();
          return;
        }

        const payload: { reason?: string } | null = await res.json().catch(() => null);
        setState(payload?.reason === "unavailable" ? "unavailable" : "invalid");
      } catch {
        // Panne réseau/fetch (jamais un détail de commande) -- même
        // catégorie GÉNÉRIQUE "indisponible" que les pannes
        // d'infrastructure de route.ts, jamais journalisée.
        if (!cancelled) setState("unavailable");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orderId, router, rawHash]);

  const t = (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars);

  if (state === "loading") {
    return (
      <div role="status" aria-live="polite">
        <p className="text-sm text-ink-on-bg-muted">{t("trackingLoadingMessage")}</p>
      </div>
    );
  }

  if (state === "unavailable") {
    return (
      <div role="status">
        <h1 className="text-xl font-bold text-ink-on-bg">{t("trackingUnavailableTitle")}</h1>
        <p className="mt-3 text-sm text-ink-on-bg-muted">{t("trackingUnavailableMessage")}</p>
      </div>
    );
  }

  return (
    <div role="status">
      <h1 className="text-xl font-bold text-ink-on-bg">{t("trackingInvalidTitle")}</h1>
      <p className="mt-3 text-sm text-ink-on-bg-muted">{t("trackingInvalidMessage")}</p>
    </div>
  );
}
