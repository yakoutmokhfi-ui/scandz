"use client";

import type { RestaurantFull } from "@/lib/types";
import type { OrderContext } from "@/lib/whatsapp";
import { formatAddress } from "@/lib/customer";
import { useI18n } from "@/lib/i18n-context";
import type { Translator } from "@/lib/i18n";

function contextSummary(ctx: OrderContext | null, t: Translator): string[] {
  if (!ctx) return [];
  switch (ctx.mode) {
    case "table":
      return [
        t("confirmTable", { n: ctx.tableNumber }),
        t("confirmPrepTime"),
      ];
    case "pickup":
      return [
        t("confirmPickup"),
        `📞 ${ctx.customer.phone}`,
        t("confirmPickupTime"),
      ];
    case "delivery":
      return [
        t("confirmDelivery", { zone: ctx.zoneLabel }),
        `📍 ${formatAddress(ctx.customer)}`,
        `📞 ${ctx.customer.phone}`,
        t("confirmDeliveryTime"),
      ];
  }
}

export default function OrderConfirmation({
  restaurant,
  context,
  orderNumber,
  onBackToMenu,
  onNewOrder,
}: {
  restaurant: RestaurantFull;
  context: OrderContext | null;
  orderNumber: number | null;
  onBackToMenu: () => void;
  onNewOrder: () => void;
}) {
  const { t } = useI18n();
  const isTable = context?.mode === "table";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-crema px-6 py-10">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
          <span className="text-4xl text-green-600">✓</span>
        </div>

        <h1 className="mt-6 text-2xl font-bold">
          {t("confirmTitle")}
        </h1>
        <p className="mt-2 text-sm text-ink-on-bg-muted">
          {t("confirmSubtitle", { name: restaurant.name })}
        </p>

        {orderNumber !== null && (
          <p className="mt-4 inline-block rounded-full bg-caramel px-4 py-1.5 text-sm font-bold text-caramel-ink">
            {t("orderNumber", { n: orderNumber })}
          </p>
        )}

        <div className="mt-6 space-y-2 rounded-2xl bg-white p-4 text-left text-sm shadow-sm">
          {contextSummary(context, t).map((line) => (
            <p key={line} className="text-ink-on-bg">
              {line}
            </p>
          ))}
          <p className="text-ink-on-bg-muted">
            {t("confirmStaff")}
          </p>
          {isTable && (
            <p className="text-ink-on-bg-muted">
              {t("confirmServed")}
            </p>
          )}
        </div>

        <p className="mt-6 text-sm italic text-accent-dark-on-bg">
          {t("confirmThanks", { name: restaurant.name })}
          <br />
          {t("confirmEnjoy")}
        </p>

        <div className="mt-8 space-y-3">
          <button
            onClick={onBackToMenu}
            className="w-full rounded-xl bg-caramel py-3.5 font-bold text-caramel-ink"
          >
            {t("backToMenu")}
          </button>
          <button
            onClick={onNewOrder}
            className="w-full rounded-xl border border-caramel py-3.5 font-bold text-accent-dark-on-bg"
          >
            {t("newOrder")}
          </button>
        </div>
      </div>
    </div>
  );
}
