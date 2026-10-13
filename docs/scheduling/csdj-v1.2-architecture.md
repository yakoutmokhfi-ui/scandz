# CSDJ v1.2 — Scheduling Engine Extension: calendars, cutoff, capacity

Status: **DRAFT — development branch `feature/csdj-v1.2-scheduling-engine` — not applied, not merged, not deployed.**
Baseline: CSDJ-1 v1.10, PR #145, merge commit `03441a5ef1d371e90e3bfe3438e1a29e211d0537`
(migration `csdj1_checkout_scheduling_foundation_v1` already applied to PROD, configuration tables empty).
Owner: Boulez (schedule schema, resolver, capacity primitives, public availability filtering, SQL proofs).
Not owned here: CSDJ-2 selector, checkout integration, CSDJ-3 snapshot and `create_order` (Debussy) — see
[`csdj-v1.2-interface-contract.md`](./csdj-v1.2-interface-contract.md).

## 1. What changes, and what does not

| Area | v1.2 |
|---|---|
| Existing CSDJ-1 objects | Untouched, with **one** exception: the internal function `resolve_fulfillment_schedule(uuid,text,uuid,timestamptz)` is **renamed** `…_v1` (body and ACL unchanged) and a dispatcher takes its name, signature and 9 output columns. |
| Public read `get_checkout_fulfillment_schedule` | Not redefined. 19-column response contract unchanged. |
| `create_order`, `update_order_status`, payment functions, pricing | Not redefined (md5 + ACL compared before/after in the runtime harness). |
| Existing schedules | Keep `schedule_method_version = 'v1'` and behave exactly as before (the 46 CSDJ-1 fixture cases replay identically through the dispatcher). |
| Activation | Explicit, per merchant / mode / rule, through `mutate_merchant_fulfillment_schedule_v12` (`save_schedule_v12`). The migration activates nothing and ships **no data**. |

Dispatcher: `schedule_method_version = 'v1.2'` → `resolve_fulfillment_schedule_v12(restaurant, mode, rule, now, apply_capacity)`; anything else → `_v1`.

## 2. Two independent calendars

* **Preparation calendar** (merchant can prepare): weekly days in `restaurant_fulfillment_prep_day`, exceptional closures in `restaurant_fulfillment_prep_closure`.
* **Availability calendar** (customer can receive / collect): the CSDJ-1 windows, slots and closures (`restaurant_fulfillment_schedule_closure`), unchanged.

The two never share rows: closing a day for preparation does not close it for the customer and vice-versa (fixture cases `v12-prep-closure-not-availability`, `v12-avail-closure-not-prep`).
A v1.2 schedule with no preparation day is fail-closed: `unfulfillable / preparation_calendar_missing`.

## 3. Cutoff and J+X

All computations use the merchant's IANA timezone (`timezone` on the schedule). Rules, in order:

1. **Origin.** If *today* (merchant-local) is a preparation day **and** `now < cutoff(today)`, origin = today. Otherwise origin = the next preparation day strictly after today. The **exact cutoff instant counts as reached** (`now >= cutoff` ⇒ next day). No cutoff configured ⇒ origin = today when today is a preparation day.
2. **Target.** `target = origin + minLeadDays` in **calendar days**.
3. **Forward to eligibility.** From `target`, scan forward to the horizon for the first date that is open for availability, has at least one offer and (if enabled) has capacity. Minimum instant = `max(now + leadTimeMinutes, local midnight of target)`.
4. The cutoff is **not consulted** on a non-preparation day (Sunday 23:59 behaves like Sunday 09:00).
5. **DST — fail-closed.** If the cutoff wall time on the relevant day falls in a DST gap or is ambiguous, the result is `unfulfillable / cutoff_unresolvable`; nothing is guessed. Window and slot occurrences keep the CSDJ-1 all-or-nothing rule.
6. `cutoffOffsetDays` (CSDJ-1) is refused for v1.2 rows (must be 0): the cutoff is *same local day*.

Boundary cases proven by fixture + runtime: Saturday / Sunday / Monday, 1 s before / exact / 1 s after cutoff, availability and preparation closures, J+0 / J+1 / J+2 / J+3, no-cutoff, Paris gap and overlap, Tokyo, New York, Lord Howe (30-minute DST).

Reason catalogue (closed, ordered; SQL `checkout_unfulfillable_reasons_v12()` ≡ TS `CHECKOUT_UNFULFILLABLE_REASONS_V12`): the five CSDJ-1 reasons, then `preparation_calendar_missing`, `no_preparation_day_in_horizon`, `cutoff_unresolvable`, `capacity_exhausted`.

## 4. Optional capacity

Per schedule scope (restaurant, mode, rule): `capacity_enabled` and `capacity_max_orders` (strictly positive when enabled; both enforced by table constraints). Bucket = tenant × mode × rule × date × slot (`slot_key = ''` for a whole date when the schedule has no named slots).

* **One order = one unit**, whatever the product quantities (the capacity functions never read order items).
* **Client never sees counts.** The public response only *filters*: a full date or slot disappears; if everything is full the status is `unfulfillable / capacity_exhausted`. Reservation table is not readable by any client role.
* **Server re-validates and reserves atomically.** `reserve_fulfillment_capacity` takes a transaction-scoped advisory lock on the bucket (seed 1204, distinct from the tenant scheduling-edit seed 1104), re-runs the resolver in internal mode, counts holding orders and inserts the reservation row. It requires `READ COMMITTED` and refuses other isolation levels, because the lock relies on a fresh snapshot after acquisition.
* **Concurrency.** Real multi-session proof (separate `psql` sessions, barrier-synchronised, `pg_stat_activity` showing the blocked waiters): with capacity N and M > N simultaneous final attempts, exactly N are `reserved`, the rest `capacity_full`; a rolled-back reserver releases its place; buckets and tenants are independent.
* **Release.** The count is *derived* by joining reservations to orders (`fulfillment_capacity_used`); an order whose status is `rejected` or `cancelled` no longer holds a place. `release_fulfillment_capacity(order_id)` deletes the reservation explicitly.
* **Payments — see §6.** Payment status is deliberately ignored by the holding rule.

## 5. Public holidays — proposal

The mandate requires explicit, merchant-configurable holiday handling **without inventing a jurisdiction or a dataset**. v1.2 ships structure only:

* `public_holiday_calendar` (code, label, optional `country_code` / `region_code`) and `public_holiday_calendar_day` — **both empty**.
* Per schedule: `holiday_calendar_id`, `preparation_on_holidays` (`open|closed`), `availability_on_holidays` (`open|closed`). Default `open`: with no calendar attached, no day is ever treated as a holiday. A `closed` policy without a calendar is refused by a table constraint (it would look active while closing nothing).
* Preparation and availability are independent: a merchant may prepare on a holiday but not deliver, or the reverse (`v12-holiday-prep-closed`, `v12-holiday-avail-closed`, `v12-holiday-prep-only-not-avail`, `v12-holiday-both-closed`).
* Merchant-entered closures (the existing closure tables) remain the **primary** tool and need no dataset at all.

**Proposal for CTO decision (nothing implemented beyond structure):**

1. *Country / region selection.* The merchant picks one calendar from a catalogue by `country_code` (+ optional `region_code`) in the merchant back office; the choice is stored as `holiday_calendar_id`. Which countries / regions the catalogue offers is a **product decision**, isolated from the engine: adding a jurisdiction = inserting rows, no code change.
2. *Who maintains the dataset.* Options: (a) Scanym operators load audited yearly data via a service-role migration; (b) import from an official government source reviewed by a human before load; (c) merchant-defined calendars only (merchant enters their own dates). v1.2 is compatible with all three; none is chosen here. There is currently **no merchant write path** to the calendar tables (read-only for `authenticated`), by design, until (a)/(b)/(c) is decided.
3. *Merchant overrides.* Merchant closures always apply on top of the calendar; a merchant who *is* open on a listed holiday sets the policy to `open`.
4. *Staleness.* A calendar covering only some years will simply list no holidays beyond them; we recommend an operator alert when the latest loaded year is less than 12 months ahead (not implemented).

## 6. Pending / failed payments and capacity — proposal (no timeout invented)

Finding: `initiate_payment_attempt` allows a retry after a failed/cancelled attempt by setting `payment_status` back to `pending`. If a failed or cancelled payment *released* the place, a later retry could re-activate an order whose place has meanwhile been sold: **overbooking**. Therefore v1.2 uses a conservative rule:

* A place is held while the **order status** is not `rejected` / `cancelled`. Payment status is ignored: `pending` holds, `failed` and `cancelled` also hold.
* Consequence: abandoned unpaid orders keep their place until the order is rejected/cancelled. **No expiry is invented.**

Options for CTO approval (pick one, with an explicit value where one is needed):

| Option | Mechanism | Needs |
|---|---|---|
| A. Keep-hold (current) | Place held until order rejected/cancelled | Nothing; risk: stale pending orders block capacity |
| B. Release on failed/cancelled payment + re-validation | Payment code calls `release_fulfillment_capacity`; `initiate_payment_attempt` must call `reserve_fulfillment_capacity` again and refuse the retry when full | Change to payment code (outside Boulez scope; coordinate with owner of the payment engine) |
| C. Expiry of pending payments | A scheduled job rejects orders whose payment stayed pending beyond a TTL, which releases the place | **An approved TTL value** (none is proposed here) and a job owner |

The primitives (`release_fulfillment_capacity`, derived holding count) support A, B and C without schema change.

## 7. Security and tenant ownership

* Every v1.2 function: `security definer`, `set search_path = ''`, `revoke … from public, anon, authenticated, service_role` **before** any grant.
* Only `mutate_merchant_fulfillment_schedule_v12` and `get_merchant_fulfillment_schedules_v12` are granted to `authenticated`; the first requires `has_role_in(owner|manager)` and takes the tenant advisory lock; the second requires membership or operator.
* `reserve_` / `release_fulfillment_capacity`, `fulfillment_capacity_used`, `resolve_fulfillment_schedule_v12` and all helpers are executable by **no client role**. `anon` gains nothing (the public read keeps its CSDJ-1 grant).
* No table grants write privileges; RLS enabled on all five new tables; composite foreign keys keep every child row inside its tenant.
* A foreign order (different restaurant) passed to `reserve_fulfillment_capacity` is refused (`CSDJ12_FOREIGN_ORDER`).

## 8. Reference implementations and proofs

| Artifact | Role |
|---|---|
| `supabase/DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2.sql` | Migration (single transaction, preflight + postflight inside) |
| `…-v1-2-rollback.sql` | Rollback; refuses to run if v1.2 data exists |
| `lib/scheduling/eligibility-v12.ts` | TypeScript reference mirror (server-side/tests only; must never be imported by `app/` or `components/`) |
| `tests/fixtures/build-checkout-scheduling-v12-cases.py` → `…-cases.json` | Independent Python oracle, 59 cases, hand-derived answers for boundary cases |
| `supabase/tests/checkout-scheduling-v12-check.sh` | Disposable PG16 cluster harness: real predecessor chain, fixture replay, regression of CSDJ-1, concurrency, rollback fidelity, mutation controls |
| `tests/csdj12-*.test.ts` | TS fixture replay and structural guards |

## 9. Remaining decisions and risks

1. **Holiday dataset and jurisdictions** (§5) — product decision; engine is ready.
2. **Pending / failed payment policy** (§6) — CTO choice A/B/C; B and C touch code outside this lot.
3. **`create_order` integration** — Debussy; contract is a *proposal* until acknowledged (interface-contract doc).
4. **v1 `save_schedule` on a v1.2 row** with default cutoff offset fails by check constraint (`rfs_v12_no_cutoff_offset`): fail-closed, but the CSDJ-1 merchant UI would show an error on such rows. Merchant UI for v1.2 is out of scope.
5. **PROD cannot be verified from this environment**; the migration was proven on a disposable PG16 whose predecessor chain mirrors the repository, not on the hosted database. A pre-application PROD inventory check is required before any application.
6. **Lock ordering.** Reservation takes the bucket lock after the order insert; the tenant edit lock (1104) is separate. No code path takes both; Debussy must not add one that takes them in the opposite order.
7. **Date validation outside capacity.** `reserve_fulfillment_capacity` revalidates the chosen date only when capacity is enabled; for other schedules the server-side check of the chosen date belongs to the checkout integration (Debussy) — open question in the interface contract.
8. **Holding count vs. status vocabulary.** The holding rule treats any order status other than `rejected` / `cancelled` as holding. A new terminal status added later must be added to `fulfillment_capacity_is_holding` (single point of change).
