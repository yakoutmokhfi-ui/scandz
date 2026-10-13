# CSDJ v1.2 ↔ CSDJ-2 / CSDJ-3 — Interface contract

Status: **PROPOSED by Boulez — NOT yet acknowledged by Debussy.** Nothing below is an agreement until Debussy confirms in writing; until then it is the contract Boulez will keep stable.

Scope: how checkout (CSDJ-2 selector), the order snapshot and `create_order` (CSDJ-3) use the v1.2 scheduling engine. Boulez does **not** redefine `create_order`; this lot contains no change to it.

## 1. Single capacity authority

`public.reserve_fulfillment_capacity` is the **only** place that decides whether a place exists and that records it. Debussy's code never counts orders, never inserts into the reservation table, never reimplements the resolver. The resolver (`resolve_fulfillment_schedule`) stays the only authority for *which dates/slots are offered*.

## 2. Public read (CSDJ-2) — unchanged

`get_checkout_fulfillment_schedule(restaurant, mode, fulfillment_rule_id, …)` keeps its CSDJ-1 19-column response and grants. Behaviour differences are *values only*:

* `status` / `reason` may now be `unfulfillable` with one of the 4 new reasons (closed catalogue `checkout_unfulfillable_reasons_v12()`);
* dates / slots that are full are simply absent; **no counts, no "remaining" field, ever**;
* a schedule still on method `v1` behaves exactly as before.

CSDJ-2 must treat any unknown `reason` as "not fulfillable" (fail-closed) and must not branch on `capacity_exhausted` to reveal capacity to the customer beyond a generic "no availability".

## 3. Reservation inside `create_order` (CSDJ-3) — proposed call

Inside the `create_order` transaction, **after** the order row is inserted and **before** the function returns, when the order carries a scheduled fulfillment date:

```sql
select r.result, r.reason
from public.reserve_fulfillment_capacity(
  p_order_id            => v_order_id,
  p_restaurant_id       => v_restaurant_id,
  p_mode_code           => v_mode_code,
  p_fulfillment_rule_id => v_fulfillment_rule_id,   -- null when the mode has no rule
  p_fulfillment_date    => v_fulfillment_date,      -- merchant-local date chosen by the customer
  p_slot_key            => v_slot_key               -- null when the schedule has no named slots
  -- p_now omitted: defaults to now(); only tests pass it
) r;
```

Preconditions Debussy must keep:

1. **Isolation `READ COMMITTED`** (the PostgreSQL default). The function raises `CSDJ12_ISOLATION_REQUIRED` under any other level.
2. The order row already exists, belongs to `p_restaurant_id`, and has an active status.
3. Same transaction as the order insert: an error or rollback after the call must roll the reservation back with the order (proven in the harness).
4. Called **at most once per order** (`CSDJ12_ALREADY_RESERVED` otherwise).
5. The date / slot passed are those the customer selected. When capacity is **enabled**, the function re-validates them against the resolver itself, so a stale or forged selection is refused rather than trusted. When it returns `not_required` (capacity off, schedule absent/disabled/`v1`) it performs **no** date validation at all: re-validating the chosen date for those schedules (selector / snapshot) remains Debussy's responsibility, using `resolve_fulfillment_schedule` (see question 5).

### Result mapping

| `result` | `reason` | Meaning | Required `create_order` behaviour |
|---|---|---|---|
| `not_required` | `null` | Schedule absent, disabled, method `v1`, or capacity off | Continue normally (historical flow) |
| `reserved` | `null` | One unit held for this order | Continue; order is created |
| `unavailable` | `schedule_not_fulfillable` | Resolver says nothing is fulfillable now | Abort the order with the checkout "fulfillment no longer available" error |
| `unavailable` | `date_not_offered` | Chosen date not offered (closed, past cutoff, beyond horizon…) | Same |
| `unavailable` | `slot_not_offered` | Chosen slot not offered | Same |
| `unavailable` | `capacity_full` | Last place taken by a concurrent order | Same; the customer reselects (public read now hides the full bucket) |

`unavailable` is a **normal business outcome** (no exception) so Debussy owns the error text/code returned to the client. `CSDJ12_*` exceptions (SQLSTATE `22023`, `42501`, `55000`, `23505`) are programming/usage errors: let them propagate and abort the transaction.

If `unavailable`, `create_order` must abort so that **no order row remains** (capacity is only ever held by an existing order).

## 4. Release

* Rejected or cancelled orders stop holding a place automatically (the count is derived from order status). No call is needed from `update_order_status`.
* `public.release_fulfillment_capacity(p_order_id uuid) returns boolean` deletes the reservation row explicitly (true if one existed). It is **not** called by Boulez code. It exists for the payment policy chosen in the architecture doc §6.
* Failed / cancelled **payments** do not release a place today (a retry can bring the order back to `pending`). Any change (options B / C) is a coordinated change with the payment-engine owner and needs CTO approval; no timeout value is defined by this lot.

## 5. Permissions

`reserve_fulfillment_capacity`, `release_fulfillment_capacity`, `fulfillment_capacity_used` and `resolve_fulfillment_schedule_v12` have **no grant to `anon`, `authenticated` or `service_role`**. They are callable from other `security definer` functions owned by the migration owner, which is how `create_order` calls them. Debussy must not add grants.

## 6. Snapshot (CSDJ-3)

Debussy's snapshot should store what the customer chose (date, slot key, mode, rule) as CSDJ-3 already specifies. Boulez needs nothing more from the snapshot: the reservation row carries its own bucket key. The snapshot must not store counts or capacity settings.

## 7. Questions for Debussy (blocking acknowledgement)

1. Confirm the call position (after order insert, same transaction) and the `unavailable` → abort mapping.
2. Confirm `create_order` already runs at `READ COMMITTED` in all callers (no `SET TRANSACTION ISOLATION LEVEL` upstream, including service-role paths).
3. Confirm how the date / slot key are represented in the CSDJ-3 snapshot so both sides use the same merchant-local date semantics.
4. Confirm that client-visible error text for `unavailable` stays in Debussy's i18n scope (this lot adds no text keys).
5. Confirm who re-validates the chosen date server-side when `reserve_fulfillment_capacity` returns `not_required` (CSDJ-3 snapshot validation vs. an additional call to the resolver). Boulez can expose a validation-only entry point if wanted; it is not added without agreement.

## 8. Stability promise

Signature and result vocabulary of `reserve_fulfillment_capacity` (`not_required | reserved | unavailable`; reasons above) will not change without a version bump and notice to Debussy.
