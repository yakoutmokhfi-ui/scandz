import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCheckoutSchedule } from "@/lib/services/checkout-schedule";
import type { CheckoutScheduleView } from "@/lib/checkout-schedule/model";

/**
 * CSDJ-2 / issue #158 -- lecture des disponibilités du checkout.
 *
 * États :
 *  - `idle`    : rien à lire (mode « table », aucun mode, livraison sans
 *                code postal valide) ;
 *  - `loading` : lecture en cours -- l'envoi est fermé, on ne sait pas
 *                encore si une date est exigée ;
 *  - `ready`   : le serveur a répondu ;
 *  - `error`   : la lecture a échoué. L'écran le dit et propose de
 *                réessayer ; l'envoi n'est PAS fermé pour autant (le
 *                serveur reste l'autorité et refuse avec un code typé si
 *                une date est exigée -- relecture alors automatique).
 *
 * Une réponse en retard (autre mode, autre code postal, relecture plus
 * récente) est IGNORÉE : seule la dernière demande peut écrire l'état.
 */
export type CheckoutScheduleState =
  | { status: "idle"; view: null }
  | { status: "loading"; view: null }
  | { status: "ready"; view: CheckoutScheduleView }
  | { status: "error"; view: null };

export interface UseCheckoutScheduleParams {
  restaurantId: string | null;
  modeCode: "pickup" | "delivery" | null;
  postalCode?: string | null;
  totalCount?: number;
  subtotal?: number | null;
}

export function useCheckoutSchedule(params: UseCheckoutScheduleParams): {
  state: CheckoutScheduleState;
  refetch: () => Promise<void>;
} {
  const { restaurantId, modeCode, postalCode, totalCount, subtotal } = params;
  const enabled = restaurantId !== null && modeCode !== null;
  const [state, setState] = useState<CheckoutScheduleState>({ status: "idle", view: null });
  const seqRef = useRef(0);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const run = useCallback(async () => {
    const p = paramsRef.current;
    const seq = ++seqRef.current;
    if (p.restaurantId === null || p.modeCode === null) {
      setState({ status: "idle", view: null });
      return;
    }
    setState({ status: "loading", view: null });
    try {
      const view = await fetchCheckoutSchedule({
        restaurantId: p.restaurantId,
        modeCode: p.modeCode,
        postalCode: p.modeCode === "delivery" ? (p.postalCode ?? null) : null,
        totalCount: p.modeCode === "delivery" ? (p.totalCount ?? 0) : 0,
        subtotal: p.modeCode === "delivery" ? (p.subtotal ?? null) : null,
      });
      if (seq !== seqRef.current) return;
      setState({ status: "ready", view });
    } catch {
      if (seq !== seqRef.current) return;
      setState({ status: "error", view: null });
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      seqRef.current += 1;
      setState({ status: "idle", view: null });
      return;
    }
    void run();
    // Une nouvelle portée (restaurant, mode, code postal, panier pour la
    // livraison) = une nouvelle lecture.
  }, [
    enabled,
    restaurantId,
    modeCode,
    modeCode === "delivery" ? postalCode : null,
    modeCode === "delivery" ? totalCount : 0,
    modeCode === "delivery" ? subtotal : null,
    run,
  ]);

  return { state, refetch: run };
}
