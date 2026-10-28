/**
 * ISSUE #171 — ORDER PAYMENT OPERABILITY (single source of truth, pure).
 *
 * An order is OPERATIONAL (shown in the back-office working list, counted,
 * acceptable/refusable) only when its payment does not stand in the way:
 *   - `not_required` : no online payment involved (historical behaviour,
 *                      every merchant without Monetico) -> operational;
 *   - `paid`         : payment confirmed by the authenticated provider
 *                      notification -> operational;
 *   - `required`, `pending` : payment expected / attempt in flight (an
 *                      `Annulation` leaves the attempt `pending` so the
 *                      customer may retry) -> NOT operational;
 *   - `failed`, `cancelled` : attempt explicitly terminal-negative ->
 *                      NOT operational, kept for audit.
 *
 * This is deliberately a DENY list for the write guard and an ALLOW list
 * for the read filter: both agree, and neither is "paid only" (which would
 * lock out every merchant whose orders are legitimately `not_required`).
 *
 * The SAME rule is enforced server-side by `update_order_status`
 * (DRAFT-lot-issue-171-unpaid-orders-not-operational-v1.sql) and in
 * `get_operator_restaurant_orders_page`; this module is the client/UI
 * mirror, never the authority.
 */

export const ORDER_PAYMENT_STATUSES = ["not_required", "required", "pending", "paid", "failed", "cancelled"] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

/** Payment states under which an order is operational. */
export const OPERATIONAL_PAYMENT_STATUSES: readonly OrderPaymentStatus[] = ["not_required", "paid"];

/** Payment states that are terminal-negative and kept for audit only. */
export const AUDIT_ONLY_PAYMENT_STATUSES: readonly OrderPaymentStatus[] = ["failed", "cancelled"];

/** Payment states still awaiting an outcome (never shown as operational). */
export const AWAITING_PAYMENT_STATUSES: readonly OrderPaymentStatus[] = ["required", "pending"];

/**
 * `true` when the order may be worked on. An unknown/missing value is
 * NOT operational (fail-closed): a row whose `payment_status` could not be
 * read is never presented as actionable.
 */
export function isOrderPaymentOperational(paymentStatus: unknown): boolean {
  return typeof paymentStatus === "string" && (OPERATIONAL_PAYMENT_STATUSES as readonly string[]).includes(paymentStatus);
}

export type OrderPaymentBadge = "awaiting_payment" | "payment_failed" | null;

/** Badge to display on a non-operational order (null when operational). */
export function orderPaymentBadge(paymentStatus: unknown): OrderPaymentBadge {
  if (isOrderPaymentOperational(paymentStatus)) return null;
  if (typeof paymentStatus === "string" && (AUDIT_ONLY_PAYMENT_STATUSES as readonly string[]).includes(paymentStatus)) return "payment_failed";
  return "awaiting_payment";
}
