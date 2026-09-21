import type { DeliveryStatus } from "@/lib/delivery";
import type { ServiceMode } from "@/lib/restaurants-config";
import type { SaleMode } from "@/lib/sale-modes-types";

export interface DeliveryCustomerNotice {
  modeCode: "pickup" | "delivery";
  modeLabel: string;
  message: string;
}

function optionalText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/**
 * Resolves the notice from the already-public tenant configuration.
 * Pickup uses the sale-mode customer text. Delivery prefers the
 * matched fulfillment rule's CUSTOMER NOTICE TEXT, then uses the
 * generic delivery-mode text as a safe fallback. Provider names and
 * routing codes are deliberately absent from this customer model.
 *
 * v1.1 — source clarity: the rule text is read ONLY from the dedicated
 * `DeliveryStatus.customerNotice` field, which is populated exclusively
 * by the fulfillment adapter from `customer_text`. The generic
 * `DeliveryStatus.zone` (whose `label` is a GEOGRAPHIC area label on
 * the legacy path, e.g. "Paris", "Zone 1") is intentionally never read
 * here, so a geographic/zone label can never become a timing notice.
 */
export function resolveDeliveryCustomerNotice(
  serviceMode: ServiceMode | null,
  saleModes: ReadonlyArray<SaleMode>,
  deliveryStatus: DeliveryStatus,
  usesFulfillmentRules: boolean = false
): DeliveryCustomerNotice | null {
  if (serviceMode !== "pickup" && serviceMode !== "delivery") return null;

  const selectedMode = saleModes.find((mode) => mode.code === serviceMode);
  if (!selectedMode) return null;

  const message =
    serviceMode === "delivery"
      ? (usesFulfillmentRules ? optionalText(deliveryStatus.customerNotice) : null) ??
        optionalText(selectedMode.customerText)
      : optionalText(selectedMode.customerText);

  if (!message) return null;

  return {
    modeCode: serviceMode,
    modeLabel: selectedMode.label,
    message,
  };
}
