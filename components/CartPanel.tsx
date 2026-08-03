"use client";

import type { RestaurantFull } from "@/lib/types";
import { formatPrice, type CartLine } from "@/lib/whatsapp";
import type { RestaurantSettings } from "@/lib/restaurants-config";
import type { DeliveryStatus } from "@/lib/delivery";
import type { CustomerInfo } from "@/lib/customer";
import QuantityControl from "@/components/QuantityControl";
import TableSelector from "@/components/TableSelector";
import { useI18n } from "@/lib/i18n-context";
import Ltr from "@/components/Bidi";
import { tName } from "@/lib/menu-i18n";
import FulfillmentSelector, {
  type FulfillmentType,
} from "@/components/FulfillmentSelector";

interface CartEntry extends CartLine {
  key: string;
}

export default function CartPanel({
  restaurant,
  settings,
  lines,
  totalCount,
  totalPrice,
  tableNumber,
  fulfillmentType,
  deliveryStatus,
  customer,
  customerErrors,
  showErrors,
  whatsappUrl,
  onChangeQuantity,
  onSelectTable,
  onSelectFulfillment,
  onChangeCustomer,
  onOrderSent,
  onClose,
}: {
  restaurant: RestaurantFull;
  settings: RestaurantSettings;
  lines: CartEntry[];
  totalCount: number;
  totalPrice: number;
  tableNumber: number | null;
  fulfillmentType: FulfillmentType | null;
  deliveryStatus: DeliveryStatus;
  customer: CustomerInfo;
  customerErrors: Partial<Record<keyof CustomerInfo, string>>;
  showErrors: boolean;
  whatsappUrl: string | null;
  onChangeQuantity: (key: string, delta: number) => void;
  onSelectTable: (table: number) => void;
  onSelectFulfillment: (t: FulfillmentType) => void;
  onChangeCustomer: (patch: Partial<CustomerInfo>) => void;
  onOrderSent: () => void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const { currency, max_tables } = restaurant.config;

  const missing =
    settings.serviceMode === "table"
      ? t("missingTable")
      : !fulfillmentType
        ? t("missingFulfillment")
        : t("missingCustomer");

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-espresso/50">
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col rounded-t-2xl bg-crema">
        <div className="flex items-center justify-between border-b border-espresso/10 px-4 py-3">
          <h2 className="text-lg font-bold">{t("cartTitle")}</h2>
          <button
            onClick={onClose}
            aria-label={t("ariaCloseCart")}
            className="rounded-full px-3 py-1 text-sm font-medium text-espresso/60"
          >
            {t("close")} ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {lines.length === 0 ? (
            <p className="py-8 text-center text-sm text-espresso/60">
              {t("cartEmpty")}
            </p>
          ) : (
            <ul className="space-y-3">
              {lines.map(({ key, item, quantity, note }) => (
                <li
                  key={key}
                  className="flex items-center justify-between gap-3 rounded-xl bg-white p-3"
                >
                  <div className="min-w-0">
                    <p className="font-semibold leading-snug">
                      {tName(item, lang)}
                    </p>
                    {note && <p className="text-xs text-espresso/60">{note}</p>}
                    <p className="mt-0.5 text-sm text-caramel-dark">
                      <Ltr>{formatPrice(item.price * quantity, currency)}</Ltr>
                    </p>
                  </div>
                  <QuantityControl
                    quantity={quantity}
                    onChange={(delta) => onChangeQuantity(key, delta)}
                  />
                </li>
              ))}
            </ul>
          )}

          {lines.length > 0 &&
            (settings.serviceMode === "table" ? (
              <TableSelector
                maxTables={max_tables}
                selected={tableNumber}
                onSelect={onSelectTable}
              />
            ) : (
              <FulfillmentSelector
                settings={settings}
                status={deliveryStatus}
                type={fulfillmentType}
                customer={customer}
                errors={customerErrors}
                showErrors={showErrors}
                onSelectType={onSelectFulfillment}
                onChangeCustomer={onChangeCustomer}
              />
            ))}
        </div>

        {lines.length > 0 && (
          <div className="border-t border-espresso/10 px-4 py-4">
            <div className="mb-3 flex items-center justify-between font-bold">
              <span>{t("total")}</span>
              <span>
                <Ltr>{formatPrice(totalPrice, currency)}</Ltr>
              </span>
            </div>
            {whatsappUrl ? (
              <a
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onOrderSent}
                className="block rounded-xl bg-[#25D366] py-3.5 text-center font-bold text-white"
              >
                {t("sendOrder")}
              </a>
            ) : (
              <p className="rounded-xl bg-espresso/5 py-3.5 text-center text-sm font-medium text-espresso/60">
                {missing}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
