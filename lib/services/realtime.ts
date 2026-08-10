import { supabase } from "@/lib/supabase";

/**
 * Abonnement aux commandes d'un établissement.
 *
 * Seul point du projet à connaître Supabase Realtime. L'interface
 * ne manipule ni canal ni protocole : elle reçoit une fonction de
 * désabonnement et l'appelle au démontage.
 *
 * Remplacer Realtime par un autre mécanisme (interrogation
 * périodique, WebSocket propre) ne toucherait que ce fichier.
 */
export function subscribeToOrders(
  restaurantId: string,
  onChange: () => void
): () => void {
  const channel = supabase
    .channel(`dashboard-orders-${restaurantId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "orders",
        filter: `restaurant_id=eq.${restaurantId}`,
      },
      () => onChange()
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
