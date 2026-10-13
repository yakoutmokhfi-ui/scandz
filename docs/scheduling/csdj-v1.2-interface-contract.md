# CSDJ v1.2 ↔ CSDJ-2 / CSDJ-3 — Interface contract (FINAL — pending Debussy acceptance)

| | |
|---|---|
| Version | **2** (supersedes the unacknowledged "PROPOSED" v1 of this file) |
| Engine | Boulez v1.2 — PR #146, branch `feature/csdj-v1.2-scheduling-engine` |
| Baseline | CSDJ-1 v1.10, `03441a5ef1d371e90e3bfe3438e1a29e211d0537` |
| Boulez | **ACCEPTED** (see §10) |
| Debussy | **ACCEPTANCE PENDING** — not obtainable from the Boulez session (§10 says how to give it) |
| Mode | development only. No merge, no PROD SQL, `NEXT_PUBLIC_CHECKOUT_SCHEDULE_ENABLED` stays off, no merchant schedule activated. |

This document is the single contract between the scheduling engine (Boulez) and the checkout integration (Debussy: CSDJ-2 selector, `create_order`, CSDJ-3 snapshot). It applies the eight CTO decisions; it does not reopen any business decision already taken by the CIO.

## 0. CTO decisions → where they are applied

| # | Decision | Applied in |
|---|---|---|
| 1 | One reservation authority: Boulez v1.2; no second table, counting algorithm or lock | §1, §2.3, §5 |
| 2 | One order = one capacity unit, whatever the product count | §5.4 |
| 3 | Keep the place after `payment_status = failed/cancelled` while `orders.status` ∉ {rejected, cancelled}; payment expiry is a separate release decision | §6 |
| 4 | `create_order` always re-validates date and slot by the server authority, even with capacity off | §3 (T3), §4 |
| 5 | v1.2 catalogue in the CSDJ-2 parser, translations, conformance tests (4 new reasons) | §7 |
| 6 | `derived_earliest`: exact server-side treatment, no forged date | §4.3 |
| 7 | Single transaction: validation, order, reservation, snapshot succeed or fail together | §3 |
| 8 | Keep `create_order` arity/result, ACLs, B1/B5 protections; verify fingerprints on the real SQL predecessor | §8 |

## 1. Authorities and ownership

| Concern | Single authority | Owner |
|---|---|---|
| Which dates / slots / times are offered | `resolve_fulfillment_schedule` (dispatcher → `_v12` or `_v1`) | Boulez |
| Whether a selection is valid *now* | `validate_fulfillment_selection` | Boulez |
| Counting occupied places | `fulfillment_capacity_used` (derived from `orders` ⋈ reservation table) | Boulez |
| Taking a place (lock + insert) | `reserve_fulfillment_capacity` — table `order_fulfillment_capacity_reservation` | Boulez |
| Releasing a place explicitly | `release_fulfillment_capacity` (not wired; see §6) | Boulez |
| `create_order` body, order snapshot (CSDJ-3), selector UI, error text, i18n | — | Debussy |

Debussy code **never** counts orders, never writes the reservation table, never takes a bucket lock, never re-implements the resolver. Boulez code never redefines `create_order`, `update_order_status`, payment or pricing functions (verified by md5 + ACL in the PG16 harness).

## 2. RPC signatures (exact, from `pg_get_function_identity_arguments` on the migrated PG16 cluster)

None of the functions below is granted to `anon`, `authenticated` or `service_role`. They are called from `SECURITY DEFINER` functions of the migration owner (`create_order` is one: `prosecdef = t`, `search_path = ''`).

### 2.1 Read (public, unchanged from CSDJ-1)
`get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)` — 19-column response and grants unchanged. Only *values* differ (§7).

### 2.2 `validate_fulfillment_selection`
```sql
public.validate_fulfillment_selection(
  p_restaurant_id       uuid,
  p_mode_code           text,
  p_fulfillment_rule_id uuid,                       -- null when the mode has no rule
  p_fulfillment_date    date        default null,
  p_slot_key            text        default null,
  p_selected_time       text        default null,   -- 'HH:MM' (time_within_window only)
  p_now                 timestamptz default now()
) returns table (
  result              text,         -- 'not_required' | 'valid' | 'unavailable'
  reason              text,         -- null unless 'unavailable'; closed catalogue §7.2
  selection_date      date,         -- the selection RETAINED by the server (valid only)
  selection_slot_key  text,         -- fixed_slots only
  selection_time      text,         -- time_within_window only
  window_starts_at    text,         -- 'HH:MM' of the retained slot / window (null in date-only mode)
  window_ends_at      text,
  instant_starts_at   timestamptz,  -- server-computed instant of the slot start / chosen time
  schedule_timezone   text,
  date_selection_mode text,
  slot_selection_mode text,
  capacity_applies    boolean       -- true ⇒ reserve_fulfillment_capacity will consume one unit
)  -- STABLE, SECURITY DEFINER, read-only, takes no lock
```

### 2.3 `reserve_fulfillment_capacity`
```sql
public.reserve_fulfillment_capacity(
  p_order_id            uuid,
  p_restaurant_id       uuid,
  p_mode_code           text,
  p_fulfillment_rule_id uuid,
  p_fulfillment_date    date,                       -- required
  p_slot_key            text        default null,
  p_selected_time       text        default null,
  p_now                 timestamptz default now()
) returns table (result text, reason text)          -- VOLATILE, SECURITY DEFINER
```
`result` ∈ `not_required` (nothing reserved) · `reserved` (one unit held) · `unavailable` (reason from §7.2). It takes the bucket advisory lock (seed 1204), **replays `validate_fulfillment_selection` under the lock** (same function, no second algorithm), then inserts the reservation row. It requires `READ COMMITTED` and raises `CSDJ12_ISOLATION_REQUIRED` otherwise.

Usage errors raise `CSDJ12_*` exceptions (SQLSTATE `22023` invalid arguments / reserved rule id / unknown order, `42501` foreign-tenant order, `55000` order not active, `23505` already reserved, `25000` wrong isolation). They indicate a programming error; let them propagate.

Change from contract v1: `p_selected_time` was inserted **before** `p_now` in `reserve_fulfillment_capacity` (the draft had no consumer yet). Callers must not pass `p_now` positionally; production code omits it.

### 2.4 `release_fulfillment_capacity(p_order_id uuid) returns boolean`
Idempotent explicit release. **Not called by anyone** under CTO decision 3 (§6).

### 2.5 `create_order` — unchanged
`create_order(p_slug text, p_service_mode text, p_items jsonb, p_table_number integer, p_customer jsonb, p_note text, p_language text, p_cgv_accepted boolean)` returns `(order_id, order_number, public_token, subtotal, delivery_fee, total)`. **Arity, parameter names, result columns and ACL (`postgres`, `anon`, `authenticated`) do not change.**

Because the arity is frozen, the customer's selection travels **inside the existing `p_customer jsonb`**, under one key (camelCase, like the existing `postalCode`):

```json
"fulfillment": { "date": "2026-10-14", "slotKey": "s1", "time": "12:30" }
```
All three members are optional strings; which ones are expected depends on the schedule (§4). `create_order` must: reject a non-object value, reject unknown members, reject non-string members, parse `date` as a strict `YYYY-MM-DD` calendar date (never a timestamp); then pass the values **verbatim** to `validate_fulfillment_selection` (which owns shape validation of `slotKey` and `time` and answers `selection_invalid`). The key is *Debussy's choice to rename* only through §10 — whatever it is called, it is the only channel.

## 3. Transactional order inside `create_order` (CTO 4, 7)

Everything below runs in `create_order`'s own transaction. Any `raise exception` aborts the whole transaction: order row, items, order-number increment, reservation row and snapshot disappear together.

| Step | Action | Owner |
|---|---|---|
| T0 | Existing flow unchanged up to the order insert, item inserts and delivery pricing resolution (`v_fulfillment_rule_id` becomes known here) | existing |
| T1 | Parse `p_customer->'fulfillment'` (§2.5) | Debussy |
| T2 | `select * from validate_fulfillment_selection(v_restaurant.id, p_service_mode, v_fulfillment_rule_id, date, slotKey, time)` — **always called**, whether capacity is on or off, whether a selection was supplied or not, for every mode | Debussy calls / Boulez decides |
| T3 | Map the result: `not_required` → continue with no fulfillment snapshot · `valid` → continue · `unavailable` → **abort** the transaction carrying `reason` verbatim | Debussy |
| T4 | Existing `update public.orders set subtotal…` (unchanged) | existing |
| T5 | **If and only if** T2 returned `capacity_applies = true`: `select * from reserve_fulfillment_capacity(v_order_id, v_restaurant.id, p_service_mode, v_fulfillment_rule_id, selection_date, selection_slot_key, selection_time)` (values **from the validate row**, not from the client). `reserved` → continue · `unavailable` → **abort** with `reason` verbatim | Debussy calls / Boulez decides |
| T6 | CSDJ-3 snapshot insert, built **only** from the T2 row (`selection_*`, `window_*`, `instant_starts_at`, `schedule_timezone`, the two mode columns). The client's raw values are never stored | Debussy |
| T7 | `return query` the unchanged six columns | existing |

Rules:
* `p_now` is omitted in both calls: they use the transaction timestamp, so T2 and T5 evaluate the same instant.
* T2 is placed after the delivery rule is resolved because the schedule scope is `(restaurant, mode, rule)`; it cannot move earlier for delivery.
* T2 before the lock is *advisory* for capacity (a concurrent order can take the last place between T2 and T5); T5 replays the check under the bucket lock and is authoritative. Hence two failures are normal: `capacity_full` at T2 (stale display) and at T5 (lost race).
* `READ COMMITTED` must hold at T5. `create_order` must not set another isolation level and callers must not either (PostgREST / `service_role` calls use the default).
* The only lock `create_order` may take through this contract is the bucket lock inside `reserve_fulfillment_capacity`. No other advisory lock is added; the tenant schedule-edit lock (seed 1104) is never taken by `create_order`.

## 4. Validation rules (what `validate_fulfillment_selection` decides)

The same function serves `v1` and `v1.2` schedules; `capacity_applies` is only ever true for an enabled `v1.2` schedule with `capacity_enabled`.

### 4.1 Scope without a selectable schedule
Schedule absent, disabled, or `date_selection_mode = informational_only`:
no selection supplied → `not_required`; **any** `date` / `slotKey` / `time` supplied → `unavailable / selection_not_expected` (a supplied value is never silently ignored).

### 4.2 Selectable schedule — evaluated in this order
1. malformed `slotKey` (not `^[a-z0-9_-]{1,40}$`) or `time` (not `HH:MM`, 00:00–23:59) → `selection_invalid`
2. resolver status ≠ `dates_available` (unfulfillable: any CSDJ-1 or v1.2 reason) → `schedule_not_fulfillable`
3. `date` missing → `selection_required`
4. `date` not among the dates the resolver offers *now* (past, before the J+X target, closed day, holiday closed by policy, beyond horizon, no offer) → `date_not_offered`
5. `derived_earliest` rules (§4.3)
6. by `slot_selection_mode`:
   * `none` — date only. `slotKey` or `time` supplied → `selection_not_expected`.
   * `fixed_slots` — `time` supplied → `selection_not_expected`; `slotKey` missing → `selection_required`; unknown for that date → `slot_not_offered`. Retained: slot, its `window_*`, `instant_starts_at` = slot start.
   * `time_within_window` — `slotKey` supplied → `selection_not_expected`; `time` missing → `selection_required`; the time must lie **inside** an offered window `[start, end)` and **on the grid** (offset from the exposed start a multiple of the configured granularity), else `time_not_offered`. `instant_starts_at` = the chosen time (computed by the server; a non-unique wall time at a DST transition is refused).
7. capacity enabled and the bucket (restaurant, mode, rule, date, slot-or-whole-date) already holds `capacity_max_orders` orders → `capacity_full` (advisory here; authoritative in T5).

### 4.3 `derived_earliest` (CTO 6)
The **server** chooses the date; the client only *recalls the date it displayed* (taken from the public read's `firstEligibleDate`).
* `date` missing → `selection_required` (the customer must confirm what they saw).
* `date` ≠ the date the server would derive now → `date_not_offered`. "Derived" = the earliest eligible date, skipping dates already full when capacity is on. A later date is accepted **only** if every earlier eligible date is full — otherwise the client holds a date the server would not have given it (a forged or stale value).
* `slotKey` or `time` supplied → `selection_not_expected` (`derived_earliest` forces slot mode `none`, enforced by table constraint `rfs_policy_coherent`).
* Consequence to expect and handle in UX: if the displayed date is no longer the derived one (cutoff passed, midnight rolled, last place taken), `create_order` aborts and the customer sees a refreshed date and confirms again. The snapshot stores `selection_date` from the T2 row.

### 4.4 Cases by schedule state
| Schedule | `validate` | `reserve` |
|---|---|---|
| none / disabled / `informational_only` | `not_required` (or `selection_not_expected`) | not called |
| `v1`, selectable | `valid`, `capacity_applies = false` | not called |
| `v1.2`, capacity off | `valid`, `capacity_applies = false` | not called (would return `not_required`) |
| `v1.2`, capacity on | `valid` / `unavailable`, `capacity_applies = true` | called at T5; replays validate under the bucket lock; inserts the row |

## 5. Reservation rules

1. **One order = one unit** regardless of product count: neither `validate` nor `reserve` nor the count reads `order_items` (guarded by a structural test).
2. Strictly positive maximum, enforced by table constraints (`rfs_capacity_positive`, `rfs_capacity_complete`); capacity is refused on an `informational_only` schedule (`rfs_capacity_needs_date`).
3. Bucket = restaurant × mode × rule × date × slot (`''` for date-level). Counting is derived: reservation rows ⋈ `orders`, holding statuses per §6.
4. Concurrency: two sessions on the same last place serialise on the bucket lock; the second recalculates after the first commits and gets `capacity_full`. Different buckets, dates, slots and tenants do not wait for each other. Proven with real separate PostgreSQL sessions behind a `pg_stat_activity`-verified barrier (not simulated).
5. One reservation per order (`23505` otherwise). The client never sees a count; the public read only filters.
6. A refused order never reaches the reservation: it is aborted at T3 or T5 and rolled back with the order.

## 6. Order × payment status matrix (CTO 3)

A place is **held** iff `orders.status ∉ {rejected, cancelled}`. `payment_status` is deliberately **ignored**.

| `orders.status` ↓ / `payment_status` → | `not_required` | `pending` | `paid` | `failed` | `cancelled` |
|---|---|---|---|---|---|
| `new` | held | held | held | **held** | **held** |
| `accepted` | held | held | held | **held** | **held** |
| `preparing` | held | held | held | **held** | **held** |
| `ready` | held | held | held | **held** | **held** |
| `completed` | held | held | held | **held** | **held** |
| `rejected` | released | released | released | released | released |
| `cancelled` | released | released | released | released | released |

Release happens by *derivation*: when `update_order_status` moves an order to `rejected` or `cancelled`, the count drops; no call is made. Why payment is ignored: `initiate_payment_attempt` lets a retry set `payment_status` back to `pending`; releasing on `failed`/`cancelled` could let a retry resurrect an order whose place was resold (overbooking).

Consequences stated, not hidden:
* Abandoned unpaid orders keep their place until their `orders.status` becomes `rejected` / `cancelled`. **No timeout is defined by this contract.**
* **Expiry of abandoned payments is a separate release decision** (owner: CTO; payment-engine owner for the mechanism). `release_fulfillment_capacity` exists as a primitive but must **not** be wired by CSDJ-3. The "release on failed payment" policy of the earlier Debussy memo must not be reused.

## 7. Reasons catalogue

### 7.1 Unavailability reasons of the **read** (`unfulfillable_reason`) — 9, closed
Order and spelling identical in SQL `checkout_unfulfillable_reasons_v12()` and TS `CHECKOUT_UNFULFILLABLE_REASONS_V12` (`lib/scheduling/schedule-model-v12.ts`, a pure-constants module a client may import).

| # | Reason | Origin | Meaning |
|---|---|---|---|
| 1 | `no_offer_configured` | CSDJ-1 | the policy requires an offer (window or slot) and none exists |
| 2 | `granularity_missing` | CSDJ-1 | `time_within_window` without a grid |
| 3 | `all_dates_closed` | CSDJ-1 | offers exist but every date of the horizon is exceptionally closed |
| 4 | `horizon_exhausted` | CSDJ-1 | lead time, minimum days or cutoff push the first date beyond the booking horizon |
| 5 | `no_offer_in_horizon` | CSDJ-1 | offers and open dates exist but none is still realisable (past, before the minimum instant, or non-existent / ambiguous wall time) |
| 6 | **`preparation_calendar_missing`** | v1.2 | `v1.2` schedule with no preparation day configured (fail-closed) |
| 7 | **`no_preparation_day_in_horizon`** | v1.2 | no preparation day (after closures / holidays) inside the horizon |
| 8 | **`cutoff_unresolvable`** | v1.2 | the cutoff wall time is in a DST gap or ambiguous: nothing is guessed |
| 9 | **`capacity_exhausted`** | v1.2 | every otherwise-eligible date / slot is full |

CSDJ-2 requirements (CTO 5): the parser accepts exactly these 9; **any other value is treated as "not fulfillable"** (fail-closed, never an exception and never shown raw); the selector must not branch on `capacity_exhausted` to reveal anything beyond a generic "no availability"; the four bold reasons need translations in the four mandate languages (text keys are Debussy's namespace — this lot adds none); conformance tests must fail if the parser's list and `CHECKOUT_UNFULFILLABLE_REASONS_V12` differ.

### 7.2 Selection refusal reasons (`validate` / `reserve` → `unavailable`) — 8, closed
SQL `fulfillment_selection_reasons_v12()` ≡ TS `FULFILLMENT_SELECTION_REASONS_V12`.

| Reason | Typical cause | Expected UX class |
|---|---|---|
| `schedule_not_fulfillable` | became unfulfillable since the display | refresh and reselect |
| `date_not_offered` | stale / past / closed / forged date, or not the derived date | refresh and reselect |
| `slot_not_offered` | unknown slot for that date | refresh and reselect |
| `time_not_offered` | time off-grid or outside the window | refresh and reselect |
| `capacity_full` | last place taken (stale display or lost race) | refresh and reselect |
| `selection_required` | selection missing where one is exigible | client defect → generic error |
| `selection_not_expected` | selection supplied where none exists | client defect → generic error |
| `selection_invalid` | malformed slot key / time | client defect → generic error |

`create_order` carries the reason string **verbatim** in its abort so that CSDJ-2 can map it; the error carrier (SQLSTATE/message prefix) and user-facing text are Debussy's.

## 8. Compatibility and fingerprints (CTO 8)

Observed on the Boulez PG16 harness chain (the repository's real predecessor chain + CSDJ-1 v1.10), **not on PROD**:

| Object | Fingerprint |
|---|---|
| `create_order(text,text,jsonb,integer,jsonb,text,text,boolean)` | `md5(prosrc) = ccbff371d8a30fed36928a624b2a0878`, `SECURITY DEFINER`, `search_path=''`, ACL `postgres, anon, authenticated` |
| `update_order_status(uuid,text)` | `96d497842e0701cb54358cafa4cbc5bd`, ACL `postgres, authenticated` |
| `initiate_payment_attempt(uuid,text,text)` | `70253c342aaa3ed7cc80bfe60181773b`, ACL `postgres, service_role` |

The v1.2 migration changes none of them (harness check [15]: md5 + ACL equal before and after).

Debussy must, before writing the CSDJ-3 SQL: (a) produce the same fingerprints from the **true PROD-equivalent predecessor** (the repository contains DRAFT lots that also redefine `create_order` — B1 order snapshot, B5 — whose application state on PROD is not established in this session); (b) rebase the CSDJ-3 body on that predecessor *verbatim* with only the §3 insertions (T1, T2/T3, T5, T6); (c) show that B1/B5 protections are byte-preserved; (d) keep arity, parameter names, result columns and ACL.

## 9. Items still blocking production

1. **Debussy acceptance** of this contract (§10) — blocks CSDJ-3 SQL.
2. **Real predecessor fingerprint of `create_order` on PROD** and B1/B5 sequencing (§8) — Debussy; not verifiable by Boulez.
3. **Pending/failed-payment expiry** (CTO: separate release decision) — until then abandoned orders hold places.
4. **End-to-end multi-session proof through the real `create_order`** (N concurrent calls on the last place, rollback after T5, abort at T3) — Debussy's PG tests; Boulez has proven the primitives, not the integrated function.
5. **CSDJ-2 conformance**: 9-reason parser, translations, tests (§7.1).
6. **PROD inventory check** before applying the v1.2 migration (Boulez/CTO); apply order: v1.2 migration → CSDJ-3.
7. **Holiday dataset / jurisdictions** and the owner of its upkeep — product decision; engine ready and empty.
8. **No merchant UI** to configure v1.2 schedules or capacity; schedules are not activated.
9. `NEXT_PUBLIC_CHECKOUT_SCHEDULE_ENABLED` must remain off until 1–5 are closed.

## 10. Acceptance

**Boulez (engine owner)** — accepted. The signatures in §2 are those of the migrated PG16 cluster; the behaviours in §4–§6 are covered by the PG16 harness (real concurrent sessions included) and the structural guards; the migration, rollback and tests are on PR #146. Boulez will not change a signature, a result value or a reason in §2/§7 without a version bump and notice to Debussy.

**Debussy (integration owner)** — *pending*. To accept, post on PR #146 exactly:

```
CONTRACT ACCEPTED csdj-v1.2-interface-contract.md blob <git blob SHA of this file at PR head>
```
and list any amendment as a numbered point against §2.5 (transport key), §3 (step positions) or §7 (error carrier). Until that comment exists, this contract is Boulez's final position, not an agreement.

Points Debussy is asked to confirm or amend, nothing else being open:
1. `p_customer->'fulfillment'` as the selection channel with members `date`, `slotKey`, `time` (§2.5);
2. T2 position after delivery-rule resolution (§3);
3. `create_order` already runs at `READ COMMITTED` on every call path (§3);
4. error carrier and text for `unavailable` (§7.2);
5. snapshot columns fed from the T2 row (§3 T6).
