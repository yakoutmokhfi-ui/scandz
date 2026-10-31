"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Cart } from "@/lib/cart";
import { cartSessionKey, restoreSessionCart, serializeSessionCart } from "@/lib/cart-session";
import type { RestaurantFull } from "@/lib/types";

export function useSessionCart(restaurant: RestaurantFull) {
  const [cart, setCart] = useState<Cart>({});
  const [readyFor, setReadyFor] = useState<string | null>(null);
  const [cartAdjusted, setCartAdjusted] = useState(false);
  const paused = useRef(false);

  useLayoutEffect(() => {
    paused.current = false;
    let value: string | null = null;
    try { value = window.sessionStorage.getItem(cartSessionKey(restaurant.id)); } catch { /* storage unavailable */ }
    const restored = restoreSessionCart(value, restaurant);
    setCart(restored.cart);
    setCartAdjusted(restored.removed);
    setReadyFor(restaurant.id);
    // Restore once per establishment, using the catalogue received at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurant.id]);

  useEffect(() => {
    if (readyFor !== restaurant.id || paused.current) return;
    try {
      const key = cartSessionKey(restaurant.id);
      if (Object.keys(cart).length === 0) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, serializeSessionCart(cart));
    } catch { /* browsing remains usable when storage is disabled */ }
  }, [cart, readyFor, restaurant.id]);

  function suspendPersistence() {
    // Once submission starts, a reload must never recreate a potentially
    // already-created order from a stored basket.
    paused.current = true;
    try { window.sessionStorage.removeItem(cartSessionKey(restaurant.id)); } catch { /* unavailable */ }
  }

  function resetPersistence() {
    try { window.sessionStorage.removeItem(cartSessionKey(restaurant.id)); } catch { /* unavailable */ }
    paused.current = false;
  }

  return { cart, setCart, suspendPersistence, resetPersistence, cartAdjusted, dismissCartAdjusted: () => setCartAdjusted(false) };
}
