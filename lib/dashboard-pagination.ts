/** A batch is 50 visible orders plus one lookahead, never a total-order cap. */
export const ORDER_PAGE_SIZE = 50;

export interface OrderCursor {
  created_at: string;
  id: string;
}

export interface OrderPage<T> {
  orders: T[];
  nextCursor: OrderCursor | null;
}

/** Keep the database timestamp verbatim: Date.toISOString() loses microseconds.
 * Validation is required because PostgREST's .or() takes raw filter syntax. */
export function validateOrderCursor(cursor: OrderCursor): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.created_at) ||
      !Number.isFinite(Date.parse(cursor.created_at))) {
    throw new Error("Invalid order cursor");
  }
}

export function orderPage<T extends OrderCursor>(batch: T[]): OrderPage<T> {
  const orders = batch.slice(0, ORDER_PAGE_SIZE);
  const last = orders[orders.length - 1];
  return {
    orders,
    nextCursor: batch.length > ORDER_PAGE_SIZE && last
      ? { created_at: last.created_at, id: last.id }
      : null,
  };
}

function micros(timestamp: string): bigint {
  const fraction = (timestamp.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0");
  return BigInt(Date.parse(timestamp)) * BigInt(1000) + BigInt(fraction.slice(3));
}

/** Compare PostgreSQL timestamptz/UUID keys, including offsets and microseconds. */
export function compareOrderKeys(a: OrderCursor, b: OrderCursor): number {
  const at = micros(a.created_at), bt = micros(b.created_at);
  if (at !== bt) return at < bt ? -1 : 1;
  const ai = a.id.toLowerCase(), bi = b.id.toLowerCase();
  return ai === bi ? 0 : ai < bi ? -1 : 1;
}

/** Refresh the previously explored prefix, even if its last order was resolved
 * or deleted. New arrivals must not push already reached orders out of view.
 * Each request is a live read, not a cross-request database snapshot. */
export async function readOrderWindow<T extends OrderCursor>(
  fetchBatch: (cursor: OrderCursor | null) => Promise<T[]>,
  through: OrderCursor | null,
  isCurrent: () => boolean = () => true,
): Promise<OrderPage<T>> {
  const orders: T[] = [];
  let cursor: OrderCursor | null = null;
  while (true) {
    const page: OrderPage<T> = orderPage(await fetchBatch(cursor));
    if (!isCurrent()) return { orders: [], nextCursor: null };
    orders.push(...page.orders);
    if (!page.nextCursor || !through || compareOrderKeys(page.nextCursor, through) <= 0) {
      return { orders, nextCursor: page.nextCursor };
    }
    if (cursor && compareOrderKeys(page.nextCursor, cursor) >= 0) {
      throw new Error("Order pagination did not advance");
    }
    cursor = page.nextCursor;
  }
}
