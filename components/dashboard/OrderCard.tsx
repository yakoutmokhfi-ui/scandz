"use client";

import type { DashboardOrder, OrderStatus, ReceiptSettings } from "@/lib/dashboard-types";
import { printReceipt } from "@/lib/receipt";
import { translate, type Lang } from "@/lib/i18n";
import { formatPrice } from "@/lib/whatsapp";

/** Libellés dans la langue réglée par le gérant, comme le ticket. */
const STATUS_KEY: Record<OrderStatus, string> = {
  new: "dsNew",
  accepted: "dsAccepted",
  preparing: "dsPreparing",
  ready: "dsReady",
  completed: "dsCompleted",
  rejected: "dsRejected",
  cancelled: "dsCancelled",
};

const nextActions: Partial<Record<OrderStatus, { status: OrderStatus; key: string }[]>> = {
  new: [
    { status: "accepted", key: "dsAccept" },
    { status: "rejected", key: "dsRefuse" },
    { status: "cancelled", key: "dsCancel" },
  ],
  accepted: [
    { status: "preparing", key: "dsPrepare" },
    { status: "cancelled", key: "dsCancel" },
  ],
  preparing: [
    { status: "ready", key: "dsMarkReady" },
    { status: "cancelled", key: "dsCancel" },
  ],
  ready: [{ status: "completed", key: "dsComplete" }],
};

/**
 * Nom du produit dans la langue du gérant.
 *
 * order_items conserve un instantané du nom au moment de la
 * commande — en français. Quand le produit existe toujours et
 * possède une traduction, on l'affiche ; sinon on retombe sur
 * l'instantané, qui reste la vérité de ce qui a été commandé.
 */
function itemName(item: DashboardOrder["order_items"][number], lang: Lang) {
  if (lang === "fr") return item.item_name;
  return item.menu_items?.translations?.[lang]?.name ?? item.item_name;
}

function optionName(item: DashboardOrder["order_items"][number], lang: Lang) {
  if (lang === "fr") return item.option_name;
  return item.option?.translations?.[lang]?.name ?? item.option_name;
}

function service(order: DashboardOrder, lang: Lang) {
  const t = (k: string, p?: Record<string, string | number>) => translate(lang, k, p);
  if (order.service_mode === "table")
    return t("dsTable", { n: order.table_number ?? "-" });
  if (order.service_mode === "pickup") return t("dsPickup");
  return t("dsDelivery");
}

export default function OrderCard({
  order,
  restaurantName,
  receiptSettings,
  onStatus,
  busy,
  staffLanguage,}: {
  order: DashboardOrder;
  restaurantName: string;
  receiptSettings: ReceiptSettings | null;
  onStatus: (orderId: string, status: OrderStatus) => Promise<void>;
  busy: boolean;
  staffLanguage?: string;}) {
  const lang = (staffLanguage ?? "fr") as Lang;
  const t = (k: string, p?: Record<string, string | number>) =>
    translate(lang, k, p);
  const ageMinutes = Math.max(0, Math.floor((Date.now() - new Date(order.created_at).getTime()) / 60000));

  function handlePrint() {
    try {
      printReceipt(
        { order, restaurantName, settings: receiptSettings },
        // Langue choisie par le gérant dans ses réglages
        lang
      );
    } catch (error) {
      alert(error instanceof Error ? error.message : t("dsPrintFailed"));
    }
  }

  return (
    <article
      dir={lang === "ar" ? "rtl" : "ltr"}
      className={`rounded-2xl border bg-white p-4 shadow-sm ${order.status === "new" ? "border-amber-500 ring-2 ring-amber-100" : "border-stone-200"}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-black text-stone-900">
            {t("dsOrderTitle", { n: order.order_number })}
          </p>
          <p className="text-sm font-semibold text-amber-700">
            {service(order, lang)} · {t("dsMinutes", { n: ageMinutes })}
          </p>
        </div>
        <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-bold text-stone-700">
          {t(STATUS_KEY[order.status])}
        </span>
      </header>

      <div className="mt-4 space-y-3 border-y border-dashed border-stone-200 py-4">
        {order.order_items.map((item) => (
          <div key={item.id} className="flex justify-between gap-3 text-sm">
            <div>
              <span className="font-bold">
                {item.quantity} × {itemName(item, lang)}
              </span>
              {item.option_name && (
                <p className="text-stone-500">+ {optionName(item, lang)}</p>
              )}
            </div>
            <span className="whitespace-nowrap font-semibold">{formatPrice(Number(item.line_total), order.currency)}</span>
          </div>
        ))}
      </div>

      {(order.customer_name || order.customer_phone || order.delivery_address || order.customer_note) && (
        <div className="mt-3 rounded-xl bg-stone-50 p-3 text-sm text-stone-700">
          {order.customer_name && <p>{order.customer_name}</p>}
          {order.customer_phone && <p>{order.customer_phone}</p>}
          {order.delivery_address && <p>{order.delivery_address}</p>}
          {order.customer_note && <p className="mt-1 italic">Note : {order.customer_note}</p>}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <span className="text-lg font-black">{formatPrice(Number(order.total), order.currency)}</span>
        <button onClick={handlePrint} className="rounded-xl border border-stone-300 px-3 py-2 text-sm font-bold text-stone-800">
          {t("dsPrint")}
        </button>
      </div>

      {(nextActions[order.status]?.length ?? 0) > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {nextActions[order.status]?.map((action) => (
            <button
              key={action.status}
              disabled={busy}
              onClick={() => onStatus(order.id, action.status)}
              className={`rounded-xl px-3 py-2.5 text-sm font-bold disabled:opacity-50 ${
                action.status === "accepted" || action.status === "preparing" || action.status === "ready" || action.status === "completed"
                  ? "bg-stone-900 text-white"
                  : "bg-red-50 text-red-700"
              }`}
            >
              {t(action.key)}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
