import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchCheckoutSchedule } from "@/lib/services/checkout-schedule";
import { checkoutScheduleScope, type CheckoutScheduleView } from "@/lib/checkout-schedule/model";

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
 *
 * Issue #170 (P2) -- chaque état porte la PORTÉE (`scope`, voir
 * `checkoutScheduleScope`) de la demande qui l'a produit, et l'état RENDU à
 * l'écran n'est jamais celui d'une autre portée que la portée courante : dès
 * que le code postal, le mode ou le panier de livraison change, l'état est
 * `loading` DANS LE MÊME rendu (pas de rendu intermédiaire qui montrerait le
 * calendrier -- ou laisserait partir une commande -- de l'ancienne règle).
 */
export type CheckoutScheduleState =
  | { status: "idle"; view: null }
  | { status: "loading"; view: null; scope: string }
  | { status: "ready"; view: CheckoutScheduleView; scope: string }
  | { status: "error"; view: null; scope: string };

const IDLE_STATE: CheckoutScheduleState = { status: "idle", view: null };

export interface UseCheckoutScheduleParams {
  restaurantId: string | null;
  modeCode: "pickup" | "delivery" | null;
  postalCode?: string | null;
  totalCount?: number;
  subtotal?: number | null;
}

export function useCheckoutSchedule(params: UseCheckoutScheduleParams): {
  state: CheckoutScheduleState;
  /** Portée COURANTE (calculée à ce rendu), `null` si rien à lire. */
  scope: string | null;
  refetch: () => Promise<void>;
} {
  const { restaurantId, modeCode, postalCode, totalCount, subtotal } = params;
  const enabled = restaurantId !== null && modeCode !== null;
  const [state, setState] = useState<CheckoutScheduleState>(IDLE_STATE);
  const scope = checkoutScheduleScope(params);
  const seqRef = useRef(0);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const run = useCallback(async () => {
    const p = paramsRef.current;
    const seq = ++seqRef.current;
    const reqScope = checkoutScheduleScope(p);
    if (reqScope === null || p.restaurantId === null || p.modeCode === null) {
      setState(IDLE_STATE);
      return;
    }
    setState({ status: "loading", view: null, scope: reqScope });
    try {
      const view = await fetchCheckoutSchedule({
        restaurantId: p.restaurantId,
        modeCode: p.modeCode,
        postalCode: p.modeCode === "delivery" ? (p.postalCode ?? null) : null,
        totalCount: p.modeCode === "delivery" ? (p.totalCount ?? 0) : 0,
        subtotal: p.modeCode === "delivery" ? (p.subtotal ?? null) : null,
      });
      if (seq !== seqRef.current) return;
      setState({ status: "ready", view, scope: reqScope });
    } catch {
      if (seq !== seqRef.current) return;
      setState({ status: "error", view: null, scope: reqScope });
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      seqRef.current += 1;
      setState(IDLE_STATE);
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

  // L'état RENDU : jamais celui d'une autre portée (ni un `idle` initial alors
  // qu'une lecture est due). Identité stable tant que (état, portée) ne changent pas.
  const visible = useMemo<CheckoutScheduleState>(() => {
    if (scope === null) return IDLE_STATE;
    if (state.status === "idle" || state.scope !== scope) return { status: "loading", view: null, scope };
    return state;
  }, [state, scope]);

  return { state: visible, scope, refetch: run };
}
