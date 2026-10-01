/** Exact two-decimal input, shared by the editor and public estimate. */
export function deliveryDecimalUnits(value: unknown, maximum: number): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const units = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(units) && units <= maximum * 100 ? units : null;
}

export interface DeliveryDiscountPolicy {
  discountEnabled?: boolean;
  discountThreshold?: number | null;
  discountPercentage?: number | null;
}

/** Display-only. SQL numeric remains checkout authority; never sent as a fee. */
export function discountedDeliveryCents(baseCents: number, subtotal: number, policy: DeliveryDiscountPolicy): number | undefined {
  if (policy.discountEnabled == null || policy.discountEnabled === false) return baseCents;
  if (policy.discountEnabled !== true) return undefined;
  const threshold = deliveryDecimalUnits(policy.discountThreshold, 99999999.99);
  const percentage = deliveryDecimalUnits(policy.discountPercentage, 100);
  if (threshold === null || percentage === null) return undefined;
  // Cart line sums can carry IEEE tails; checkout stores subtotal at cent precision.
  const subtotalCents = Math.round((Number.isFinite(subtotal) && subtotal > 0 ? subtotal : 0) * 100);
  if (subtotalCents < threshold) return baseCents;
  // At the DB bounds the numerator is < 10^14, below Number.MAX_SAFE_INTEGER.
  // Integer arithmetic + half-up division matches PostgreSQL numeric round(...,2).
  return Math.floor((baseCents * (10000 - percentage) + 5000) / 10000);
}
