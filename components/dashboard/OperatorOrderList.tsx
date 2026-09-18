"use client";

import type { OperatorOrderSummary } from "@/lib/dashboard-types";
import { STATUS_KEY } from "@/components/dashboard/OrderCard";
import { translate, type Lang } from "@/lib/i18n";
import { formatPrice } from "@/lib/whatsapp";

/**
 * ORDERS OPERATOR READ v1 -- vue opérateur Scanym en LECTURE SEULE.
 *
 * N'affiche que les champs approuvés (get_operator_restaurant_orders) :
 * aucune donnée client, aucune action de statut, aucune impression.
 * Les commandes marchandes continuent d'être rendues par OrderCard.
 */
export default function OperatorOrderList({
  orders,
  loaded,
  staffLanguage,
}: {
  orders: OperatorOrderSummary[];
  /** `false` tant qu'aucune lecture n'a abouti (chargement ou échec). */
  loaded: boolean;
  staffLanguage: string;
}) {
  const t = (k: string, p?: Record<string, string | number>) =>
    translate(staffLanguage as Lang, k, p);

  const mode = (order: OperatorOrderSummary) => {
    if (order.service_mode === "table") return t("dsTable", { n: "-" });
    if (order.service_mode === "pickup") return t("dsPickup");
    return t("dsDelivery");
  };

  return (
    <div data-operator-orders="read-only">
      <p className="mb-4 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-800">
        Vue opérateur Scanym — lecture seule, données client masquées.
      </p>
      {!loaded ? null : orders.length === 0 ? (
        <div className="rounded-2xl bg-white p-10 text-center text-stone-500 shadow-sm">Aucune commande à afficher.</div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {orders.map((order) => (
            <li
              key={order.id}
              data-operator-order-id={order.id}
              className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-lg font-black text-stone-900">#{order.order_number}</span>
                <span className="rounded-full bg-stone-100 px-2 py-1 text-xs font-bold">
                  {STATUS_KEY[order.status] ? t(STATUS_KEY[order.status]) : order.status}
                </span>
              </div>
              <p className="mt-1 text-sm text-stone-600">
                {mode(order)} · {new Date(order.created_at).toLocaleString("fr-FR")}
              </p>
              <p className="mt-2 text-sm">
                {order.item_count} article(s) ·{" "}
                <span className="font-bold">{formatPrice(order.total, order.currency)}</span>
              </p>
              {order.has_invoice_request && (
                <p className="mt-1 text-xs font-semibold text-stone-500">Facture demandée</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
