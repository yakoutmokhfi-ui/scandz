import { useEffect, useState } from "react";
import { getPublicDeliveryInfo } from "@/lib/sale-modes-public";
import type { PublicDeliveryInfo } from "@/lib/sale-modes-types";

/**
 * LOT 2B.3 — bascule runtime vers la nouvelle source publique de
 * livraison (get_restaurant_public_delivery_info, LOT 2B.1) via
 * getPublicDeliveryInfo() (lib/sale-modes-public.ts), jamais un appel
 * Supabase direct dans le composant appelant ni dans lib/delivery.ts.
 *
 * NEW PUBLIC DELIVERY RESOLVER ACTIVE IN RUNTIME.
 *
 * Extrait en hook isolé (plutôt que directement dans MenuView.tsx)
 * pour rester directement testable sans dépendre de tout l'arbre de
 * MenuView (panier, i18n, catalogue) -- pas un refactoring de
 * MenuView au-delà de ce besoin précis.
 *
 * États explicites, jamais un simple booléen :
 *   - "loading" tant que la RPC n'a pas répondu ;
 *   - "loaded" avec la donnée réelle (ou null si aucune configuration
 *     livraison pour cet établissement) ;
 *   - "error" si la récupération échoue.
 *
 * AUCUN état ne présente jamais à tort une livraison éligible :
 * getDeliveryStatusFromPublicInfo(null, ...) retourne déjà
 * {eligible: false, block: "out-of-zone"} par construction --
 * "loading" et "error" exposent donc naturellement `data: null` via
 * usePublicDeliveryInfo(), sans logique dupliquée. Aucun fallback
 * vers restaurants-config.ts/getDeliveryStatus() (legacy) : ce chemin
 * n'appelle jamais l'ancienne source.
 */
export type PublicDeliveryInfoState =
  | { status: "loading" }
  | { status: "loaded"; data: PublicDeliveryInfo | null }
  | { status: "error" };

export function usePublicDeliveryInfo(restaurantId: string): {
  state: PublicDeliveryInfoState;
  data: PublicDeliveryInfo | null;
} {
  const [state, setState] = useState<PublicDeliveryInfoState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    getPublicDeliveryInfo(restaurantId)
      .then((data) => {
        if (!cancelled) setState({ status: "loaded", data });
      })
      .catch(() => {
        // Aucun détail technique exposé au client, aucun crash --
        // comportement sûr : traité comme "aucune information de
        // livraison disponible", jamais un fallback vers l'ancienne
        // source ni une livraison faussement éligible.
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [restaurantId]);

  const data = state.status === "loaded" ? state.data : null;
  return { state, data };
}
