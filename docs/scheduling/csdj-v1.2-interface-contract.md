# CSDJ v1.2 ↔ CSDJ-2 / CSDJ-3 — Canonical interface contract

| | |
|---|---|
| Version | **3.0 — reconciled** (supersedes Boulez v2 `csdj-v1.2-interface-contract.md` @ PR #146 `0a14b21` **and** Debussy `CSDJ-V12-CSDJ3-FINAL-CONTRACT.md`) |
| Status | **PROPOSED FOR SIGNATURE.** Debussy: accepted (§15). Boulez: **countersignature pending** — this text amends his v2 at six numbered points (§2). Dirac: closes decision F (§12). |
| Baseline | `main` = `03441a5ef1d371e90e3bfe3438e1a29e211d0537` (CSDJ-1 v1.10, PR #145) |
| Engine | PR #146, head `0a14b21b7de15c93bef60a592b642be533893b8c` (Boulez) |
| Integration | Debussy: contract `3b19ea6` · CSDJ-2 `86f6d69` · CSDJ-3 `5e6c3bf` |
| Mode | development only. No merge, no PROD SQL, `NEXT_PUBLIC_CHECKOUT_SCHEDULE_ENABLED` stays OFF, no merchant schedule activated. **CSDJ-3 SQL is not started and may begin only once §15 is complete.** |

**Reading rule.** *Established* = read in the SQL/TS or executed on a disposable PG16 cluster. *To prove* = a requirement the CSDJ-3 DRAFT SQL and its multi-session tests must demonstrate; nothing marked so is claimed as already true.

---

## 0. The six CTO decisions → where applied

| | Decision | Resolution | § |
|---|---|---|---|
| A | Keep Debussy's tested `p_customer.schedule`; normalise once, server-side, into Boulez's parameters; no second accepted format | `p_customer->'schedule' {date, slot_key, starts_at, ends_at}` is the only channel. Boulez's `fulfillment{date,slotKey,time}` is **withdrawn** (it was a documentation proposal; no engine function depends on it). One normalisation table. No technical incompatibility found. | 5 |
| B | `validate_fulfillment_selection` is the sole validation authority; CSDJ-3 does not reproduce eligibility in SQL | CSDJ-3 parses the JSON structure, normalises, calls the function, maps business errors. The TS second eligibility oracle was **removed** (CSDJ-3 `5e6c3bf`); a guard test forbids eligibility vocabulary in CSDJ-3 TS. | 5, 6 |
| C | Reuse `reserve_fulfillment_capacity` incl. `p_selected_time`; replay validation under the bucket lock; no duplicate table/lock/counter/holding predicate | Called **only** when validation returned `capacity_applies = true`, with the values *retained by the server*. | 6, 8 |
| D | Snapshot populated from server-validated results; client date/time not authoritative | Snapshot columns come only from the validate row; the client's echoed times are *compared*, never stored. | 9 |
| E | One exact ordering in `create_order`; preserve pricing, order snapshots, notifications, return type, ACL; prove complete rollback | §6 (single contiguous block, single md5-pinned anchor); rollback tests T-RB-1…T-RB-6 (§13). | 6, 13 |
| F | Real PROD predecessor; compare like with like | **Resolved for `create_order` and `update_order_status`** (§12): PROD = repository head; the only difference is CRLF line endings in `update_order_status`. Remaining PROD read requested of Dirac. | 12 |

The eight earlier CTO decisions (single authority, one order = one unit, payments hold the place, always-validate, v1.2 catalogue, `derived_earliest`, single transaction, compatibility) remain in force and are applied in §5–§12.

---

## 1. Reconciliation — what differed and what is now decided

| # | Subject | Boulez v2 | Debussy final | **Canonical** |
|---|---|---|---|---|
| 1 | Customer channel | `p_customer->'fulfillment' {date, slotKey, time}` | `p_customer->'schedule' {date, slot_key, starts_at, ends_at}` (tested in CSDJ-2) | **Debussy's** (CTO A), normalised once (§5) |
| 2 | Validation authority | `validate_fulfillment_selection` | dispatcher read + TS oracle replicated in SQL | **`validate_fulfillment_selection` only** (CTO B) |
| 3 | `reserve` signature | `(…, date, slot, selected_time, now)` | `(…, date, slot, now)` | **Boulez's 8-argument form**; callers never pass `p_now` |
| 4 | When `reserve` is called | only if `capacity_applies` | always for a dated selection | **only if `capacity_applies`** |
| 5 | Reservation values | from the validate row | from the oracle | **from the validate row** |
| 6 | "Informational" snapshot | none (`not_required` ⇒ no snapshot) | "informational" kind with explanation text | **none**: the engine's `not_required` row carries no scope fact, so it cannot be built from server results (CTO D). *Product consequence stated in §9.3.* |
| 7 | Snapshot content | validate row | + offers shown, granularity, policy, explanation | **validate row only** (§9) |
| 8 | `derived_earliest` echo | mandatory, `date_not_offered` if ≠ derived | same | **same**; the CSDJ-2 client already sends the displayed date |
| 9 | Error codes | reason strings verbatim | 9 typed codes | **reasons → typed codes** by one table (§10) |
| 10 | Block position | T2 before the existing `update orders` | one block before the final `return query` | **one contiguous block just before the final `return query`** (§6); semantically identical (everything is one transaction) |
| 11 | Fingerprints | harness chain: `create_order` `ccbff371…` | true chain: `c3274457…` | **true chain** (§12); Boulez's harness chain is older than repository head |
| 12 | Public RPC doc | listed `fulfillment_rule_id` | n/a | **corrected**: 5 arguments (§4.1) |

---

## 2. Amendments to Boulez's v2 (for his countersignature)

| | Where in v2 | Change |
|---|---|---|
| **A1** | §2.5 | Replace the `fulfillment` channel by `schedule {date, slot_key, starts_at, ends_at}` and the normalisation of §5. |
| **A2** | §3 | Replace the step table by §6 (one block, one anchor). Semantics of T1–T6 unchanged: validate **always**, abort on `unavailable`, reserve only on `capacity_applies`, snapshot from the validate row. |
| **A3** | §7.2 / §10 | Keep the 8 reasons. Add the reason → typed-code table (§10); the error carrier is `P0001` + message = typed code (already implemented in CSDJ-2). |
| **A4** | §8 | Replace the fingerprints table by §12 (true predecessor chain, PROD values, canonical hash expression). Adopt the repository-head chain (…→B5) in the harness for the "`create_order` unchanged" proof. |
| **A5** | §2.1 | Public read: signature is `get_checkout_fulfillment_schedule(p_restaurant_id uuid, p_mode_code text, p_postal_code text DEFAULT NULL, p_total_count integer DEFAULT 0, p_subtotal numeric DEFAULT NULL)` (19 columns). The rule is resolved server-side from the postal code. |
| **A6** | §4.2 | `not_required` is returned with **all scope columns NULL**, hence cannot feed a snapshot; the "informational" snapshot of the earlier Debussy design is dropped (row 6 above). |

Nothing in the engine (signatures, results, reasons, SQL) changes: A1–A6 are documentation amendments.

---

## 3. Authorities and ownership

| Concern | Single authority | Owner |
|---|---|---|
| Which dates/slots/times are offered (read) | `resolve_fulfillment_schedule` (dispatcher → `_v12` / `_v1`) | Boulez |
| Whether a selection is acceptable *now* | `validate_fulfillment_selection` | Boulez |
| Counting, bucket lock, reservation row | `reserve_fulfillment_capacity`, table `order_fulfillment_capacity_reservation` | Boulez |
| "A place is held" predicate | `fulfillment_capacity_is_holding(status, payment_status)` | Boulez |
| Explicit release primitive (not wired) | `release_fulfillment_capacity` | Boulez (decision owner: CTO) |
| JSON structure, normalisation, reason → code mapping, echo equality, snapshot table, `create_order` block | — | **Debussy** |
| Selector UI, error text, i18n fr/en/ar | — | Debussy |

Debussy code never counts orders, never writes the reservation table, never takes a bucket lock, never re-implements the resolver or the validation. Boulez code never redefines `create_order`, `update_order_status`, payment or pricing functions.

---

## 4. Exact signatures

None of §4.2–§4.4 is granted to `anon`, `authenticated` or `service_role`; they are called from `SECURITY DEFINER` functions of the migration owner (`create_order` is one).

### 4.1 Public read (CSDJ-1, unchanged)
```
get_checkout_fulfillment_schedule(
  p_restaurant_id uuid, p_mode_code text,
  p_postal_code text DEFAULT NULL, p_total_count integer DEFAULT 0, p_subtotal numeric DEFAULT NULL)
→ 19 columns: delivery_applicable, delivery_eligible, delivery_block, delivery_fee, delivery_min_items,
  delivery_missing, delivery_customer_text, pricing_mode, fixed_fee, free_threshold,
  schedule_status, unfulfillable_reason, schedule_timezone, date_selection_mode, slot_selection_mode,
  time_granularity_minutes, first_eligible_date, eligible_dates, offers
ACL: anon, authenticated   — only values differ in v1.2 (new reasons, capacity filter)
```

### 4.2 `create_order` — unchanged
```
create_order(p_slug text, p_service_mode text, p_items jsonb, p_table_number integer DEFAULT NULL,
             p_customer jsonb DEFAULT '{}', p_note text DEFAULT NULL, p_language text DEFAULT NULL,
             p_cgv_accepted boolean DEFAULT false)                                   -- arity 8
→ TABLE(order_id uuid, order_number bigint, public_token uuid,
        subtotal numeric, delivery_fee numeric, total numeric)                       -- 6 columns
SECURITY DEFINER, search_path = '', ACL: postgres, anon, authenticated
```

### 4.3 Engine
```
resolve_fulfillment_schedule(p_restaurant_id uuid, p_mode_code text,
    p_fulfillment_rule_id uuid DEFAULT NULL, p_now timestamptz DEFAULT now())
  → (status, unfulfillable_reason, schedule_timezone, date_selection_mode, slot_selection_mode,
     time_granularity_minutes smallint, first_eligible_date, eligible_dates date[], offers jsonb)   -- 9 cols, STABLE

validate_fulfillment_selection(p_restaurant_id uuid, p_mode_code text, p_fulfillment_rule_id uuid,
    p_fulfillment_date date DEFAULT NULL, p_slot_key text DEFAULT NULL,
    p_selected_time text DEFAULT NULL, p_now timestamptz DEFAULT now())
  → (result text,              -- 'not_required' | 'valid' | 'unavailable'
     reason text,              -- NULL unless 'unavailable'
     selection_date date, selection_slot_key text, selection_time text,
     window_starts_at text, window_ends_at text, instant_starts_at timestamptz,
     schedule_timezone text, date_selection_mode text, slot_selection_mode text,
     capacity_applies boolean)                                                                  -- STABLE, no lock

reserve_fulfillment_capacity(p_order_id uuid, p_restaurant_id uuid, p_mode_code text,
    p_fulfillment_rule_id uuid, p_fulfillment_date date, p_slot_key text DEFAULT NULL,
    p_selected_time text DEFAULT NULL, p_now timestamptz DEFAULT now())
  → (result text, reason text)    -- 'not_required' | 'reserved' | 'unavailable'; VOLATILE

release_fulfillment_capacity(p_order_id uuid) → boolean                -- NOT called by CSDJ-3 (§8.4)
fulfillment_capacity_used(uuid, text, uuid, date, text) → integer      -- STABLE
fulfillment_capacity_is_holding(p_status text, p_payment_status text) → boolean  -- IMMUTABLE
checkout_unfulfillable_reasons_v12() → text[]      -- 9 read reasons
fulfillment_selection_reasons_v12() → text[]       -- 8 selection reasons
```
When validation returns anything but `valid`, **all columns after `reason` are NULL** (except `capacity_applies = false`). Usage errors raise `CSDJ12_*` exceptions (SQLSTATE `22023`, `42501`, `55000`, `23505`, `25000`); they are programming errors and propagate unchanged — they are **not** typed customer errors.

---

## 5. Customer payload and its single normalisation

### 5.1 Wire format (CSDJ-2, unchanged and already tested)
```json
"schedule": { "date": "2026-10-14", "slot_key": null, "starts_at": null, "ends_at": null }
```
| Scope (`slot_selection_mode`) | `slot_key` | `starts_at` | `ends_at` |
|---|---|---|---|
| `none` (date only) | null | null | null |
| `fixed_slots` | the slot | the slot's start (echo) | the slot's end (echo) |
| `time_within_window` | null | **the chosen time** | the window end (echo) |
| `derived_earliest` | null | null | null — `date` = the date the customer was shown |

Absent key or JSON `null` ⇒ nothing sent. Never emitted in `table` mode by the client.

### 5.2 Structure check (CSDJ-3 — the only validation it performs itself)
`schedule` must be an object with only the keys `date`, `slot_key`, `starts_at`, `ends_at`; `date` a strict `YYYY-MM-DD` calendar date (never a timestamp); the other three a non-empty string or null. Anything else ⇒ `SCANYM_SCHEDULE_MALFORMED`. The **shape** of a slot key and of a time is *not* judged here — the engine owns it (`selection_invalid`).

### 5.3 Normalisation (one table, applied once)
| Client | → engine parameter |
|---|---|
| `date` | `p_fulfillment_date` |
| `slot_key` | `p_slot_key` (verbatim) |
| `starts_at` | `p_selected_time` **only if `slot_key` is null**; with a `slot_key` it is an echo and is not forwarded |
| `ends_at` | never forwarded (echo) |

With nothing sent, `validate_fulfillment_selection` is still called with three NULLs (always-validate).

### 5.4 Echo equality (not an eligibility decision)
After a `valid` answer, the client's `starts_at`/`ends_at`, when present, must equal what the server retained (`window_starts_at`/`window_ends_at`, or `selection_time` for window scopes). A mismatch means the customer saw something other than what the server will book: refused (`SLOT_INVALID` for a slot or date-only scope, `TIME_INVALID` for a window scope), never corrected. Omitting the echo is allowed. Nothing the client sent is ever stored.

Reference model and tests: `lib/checkout-schedule/order-selection.ts`, `tests/csdj3-order-selection.test.ts` (CSDJ-3 `5e6c3bf`).

---

## 6. Validation flow and transaction ordering in `create_order`

Everything runs in `create_order`'s own transaction. Any `RAISE EXCEPTION` below aborts it: order row, order-number increment, items, delivery snapshot, reservation row and schedule snapshot disappear together; the deferred "order received" notification trigger (which fires at COMMIT) never runs.

| Step | Action | Owner |
|---|---|---|
| T0 | **Existing flow, untouched**: slug/mode/items/pricing/delivery engine/CGV, `insert orders`, `insert order_items`, `update orders set subtotal…` (sets `fulfillment_rule_id`), B1/B5 delivery snapshot insert | existing |
| T1 | Read `p_customer->'schedule'`; structure check (§5.2) | Debussy |
| T2 | Normalise (§5.3); `validate_fulfillment_selection(v_restaurant.id, p_service_mode, v_fulfillment_rule_id, date, slot_key, selected_time)` — **always called**, every mode, capacity on or off, selection supplied or not; `p_now` omitted | Debussy calls / **Boulez decides** |
| T3 | Interpret: `unavailable` → raise the typed error of the reason (§10) · `not_required` → skip T4–T5, no schedule snapshot · `valid` → echo equality (§5.4), raise on mismatch | Debussy |
| T4 | **If and only if** `capacity_applies`: `reserve_fulfillment_capacity(v_order_id, v_restaurant.id, p_service_mode, v_fulfillment_rule_id, selection_date, selection_slot_key, selection_time)` (values from the validate row; `p_now` omitted). `reserved` → continue · `unavailable` → raise the typed error of the reason · `not_required` → continue | Debussy calls / **Boulez decides** |
| T5 | Insert the schedule snapshot (§9) from the validate row; `resolved_at` = the transaction timestamp | Debussy |
| T6 | Existing `return query select v_order_id, v_number, v_token, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee` | existing |

**Placement (the one exact anchor).** T1–T5 form **one contiguous block** inserted immediately before the single, final `return query select v_order_id, v_number, v_token, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee;` of the repository-head definition (B5). The block uses variables that already exist there: `v_restaurant.id`, `p_service_mode`, `v_fulfillment_rule_id`, `v_order_id`. The CSDJ-3 DRAFT preflight must assert that this anchor occurs **exactly once** and that the definition's `prosrc` matches §12 before patching (`pg_get_functiondef` + unique anchors + md5 pins, the B1/B5 technique). This differs from Boulez's v2 table only by T2 coming after the existing `update orders` and snapshot insert instead of before — equivalent within one transaction (amendment A2).

**Rules.**
1. **One clock.** `p_now` is omitted in both calls; both use the transaction timestamp, so T2 and T4 evaluate the same instant. The snapshot's `resolved_at` uses that same timestamp.
2. **T2 is advisory for capacity; T4 is authoritative.** A concurrent order can take the last place between them. `reserve_fulfillment_capacity` takes the bucket lock (seed 1204) and **replays `validate_fulfillment_selection`** under it, then inserts. Two `capacity_full` outcomes are normal (stale display at T2, lost race at T4).
3. **Locks.** The only lock this contract introduces into `create_order` is the bucket lock inside `reserve`. The existing row lock on `restaurant_configs` (order-number counter) precedes it for every session, so the lock order is the same for all `create_order` calls. The tenant schedule-edit lock (seed 1104) is never taken. *To prove:* T-CC-3.
4. **Isolation.** `READ COMMITTED` must hold; `create_order` must not set another level (`reserve` raises `25000` otherwise). *To prove:* T-ISO-1.
5. **No schedule at all** (`not_required` with nothing sent): the block performs one read-only call and writes nothing; results, rows and notifications are identical to today's. *To prove:* T-ID-1.

---

## 7. Validation rules (decided by `validate_fulfillment_selection`; CSDJ-3 adds none)

Summary of Boulez's §4 for reference — the function is normative.
* No selectable schedule (absent / disabled / `informational_only`): nothing sent ⇒ `not_required`; anything sent ⇒ `unavailable / selection_not_expected`.
* Selectable: malformed `slot_key`/`time` ⇒ `selection_invalid`; resolver not `dates_available` ⇒ `schedule_not_fulfillable`; `date` missing ⇒ `selection_required`; date not offered ⇒ `date_not_offered`.
* `derived_earliest`: the server picks the date; the client recalls the date it displayed; missing ⇒ `selection_required`; ≠ the server's derived date ⇒ `date_not_offered`; slot/time supplied ⇒ `selection_not_expected`. UX consequence: if the displayed date is no longer the derived one the order aborts, CSDJ-2 refetches (it already does on every schedule error) and the customer confirms again.
* By slot mode: `none` (date only) · `fixed_slots` (slot required, unknown ⇒ `slot_not_offered`, a time ⇒ `selection_not_expected`) · `time_within_window` (time required, inside an offered window and on the grid, else `time_not_offered`; a slot key ⇒ `selection_not_expected`).
* Capacity enabled and bucket at `capacity_max_orders` ⇒ `capacity_full` (advisory in T2).

---

## 8. Capacity reservation

1. **One order = one unit**, whatever the product count. Neither `validate`, `reserve` nor the count reads `order_items`; the call carries no quantity. *Proven (TS):* `CSDJ3-R5`.
2. **Bucket** = restaurant × mode × rule × date × slot. `fixed_slots` ⇒ the slot; `none` and `time_within_window` ⇒ the date (`slot_key ''`); the time of day is never a capacity dimension. In the validate row `selection_slot_key` is NULL for date-level buckets; the engine stores `''`.
3. **Holding rule** (the only one): `status ∉ {rejected, cancelled}`; `payment_status` is ignored (matrix below).
4. **Release.** Derived, not written: the count drops when `update_order_status` moves an order to `rejected`/`cancelled`. `release_fulfillment_capacity` exists but is **not wired**. Expiry of abandoned payments is a separate release decision (§14, BP-1); the "release on failed payment" policy of the earlier Debussy memo is withdrawn.
5. **Concurrency.** Two sessions on the last place serialise on the bucket lock; the second recomputes after the first commits and gets `capacity_full`.
6. **Capacity off / no capacity**: `capacity_applies = false` ⇒ `reserve` is not called; validation still ran.

| `orders.status` ↓ / `payment_status` → | `not_required` | `pending` | `paid` | `failed` | `cancelled` |
|---|---|---|---|---|---|
| `new` · `accepted` · `preparing` · `ready` · `completed` | held | held | held | **held** | **held** |
| `rejected` · `cancelled` | released | released | released | released | released |

`rejected` and `cancelled` are terminal in `update_order_status` (v29 transitions: `new→accepted|rejected|cancelled`, `accepted→preparing|cancelled`, `preparing→ready|cancelled`, `ready→completed`), so a released place cannot be silently re-held by a status change. Why payment is ignored: `initiate_payment_attempt` lets a retry set `payment_status` back to `pending`; releasing on `failed`/`cancelled` could let a retry resurrect an order whose place was resold.

---

## 9. Immutable snapshot — `order_fulfillment_schedule_snapshot`

### 9.1 Columns (all from the validate row; none from the browser)
| Column | Type | Source | Constraint |
|---|---|---|---|
| `order_id` | uuid PK | the order | `references orders(id) on delete cascade` (as B1) |
| `restaurant_id` | uuid not null | order | tenant key for RLS |
| `mode_code` | text not null | `p_service_mode` | |
| `fulfillment_rule_id` | uuid null | `v_fulfillment_rule_id` | **no FK** (as B1: history survives rule deletion) |
| `scheduled_date` | date not null | `selection_date` | |
| `slot_key` | text null | `selection_slot_key` | NULL ⇔ date-level (the reservation stores `''`); pattern `^[a-z0-9_-]{1,40}$` |
| `selected_time` | text null | `selection_time` | `HH:MM` |
| `window_starts_at` / `window_ends_at` | text null | `window_*` | `HH:MM` |
| `instant_starts_at` | timestamptz null | `instant_starts_at` | |
| `origin` | text not null | `date_selection_mode = 'derived_earliest'` ? `server_derived` : `customer` | `in ('customer','server_derived')` |
| `timezone` | text not null | `schedule_timezone` | |
| `date_selection_mode` / `slot_selection_mode` | text not null | validate row | |
| `resolved_at` | timestamptz not null | transaction timestamp | |
| `snapshot_method_version` | text not null default `'v1'` | | non-blank, ≤ 20 |
| `created_at` | timestamptz not null default `now()` | | |

Coherence constraints to prove (defence in depth, no enumerations copied beyond the engine's own modes): `slot_key` not null ⇒ `slot_selection_mode = 'fixed_slots'`; `selected_time` not null ⇒ `slot_selection_mode = 'time_within_window'`; `origin = 'server_derived'` ⇔ `date_selection_mode = 'derived_earliest'`.

Removed from the earlier design (not produced by the engine): `kind` (always scheduled), `offers_shown`, `time_granularity_minutes`, `explanation_text`, the policy block. **No capacity datum is ever stored in the snapshot.**

### 9.2 Access (B1 posture)
RLS enabled; `SELECT` for `authenticated` restricted to members of the order's restaurant (same policy shape as `order_delivery_fulfillment_snapshot_select_staff`); `revoke all … from public, anon, authenticated, service_role` then `grant select … to authenticated`; no write grant to any application role (immutability by absence of grant); `revoke maintain` on PG ≥ 17. The table name must not appear in `lib/`, `app/` or `components/` sources (existing structural test pattern for B1).

### 9.3 Absence and the dropped "informational" row
No row ⇒ no schedule applied to the order (absent, disabled, `informational_only`, or older than this lot; never back-filled). Consequence of CTO D: a merchant-information-only scope no longer leaves a snapshot row; the information text the customer saw for delivery remains in the B1 delivery snapshot (`customer_text`). If the product owner wants an "informational" trace later, it needs an additive engine output (e.g. scope facts on `not_required`) — a Boulez version bump, not a CSDJ-3 workaround.

### 9.4 Notifications
`notificationPayloadKeys` (additive keys, empty for orders without a date) are derived from the snapshot: `schedule_kind`, `scheduled_date`, `schedule_timezone`, `scheduled_starts_at` (= `selected_time` ?? `window_starts_at`), `scheduled_ends_at` (= `window_ends_at`). Written before COMMIT so the deferred notification trigger sees them. *To prove:* T-NT-1.

---

## 10. Error mapping

Carrier: `RAISE EXCEPTION` with SQLSTATE `P0001` and **message exactly equal to the typed code** (already implemented and tested in CSDJ-2: `scheduleOrderErrorCode` requires the pair).

| Engine reason (`validate` / `reserve`) | Typed code | Class |
|---|---|---|
| `schedule_not_fulfillable` | `SCANYM_SCHEDULE_UNFULFILLABLE` | refresh |
| `selection_required` | `SCANYM_SCHEDULE_REQUIRED` | choose |
| `selection_not_expected` | `SCANYM_SCHEDULE_NOT_SELECTABLE` | refresh |
| `selection_invalid` | `SCANYM_SCHEDULE_MALFORMED` | reselect |
| `date_not_offered` | `SCANYM_SCHEDULE_DATE_NOT_ELIGIBLE` | refresh |
| `slot_not_offered` | `SCANYM_SCHEDULE_SLOT_INVALID` | refresh |
| `time_not_offered` | `SCANYM_SCHEDULE_TIME_INVALID` | refresh |
| `capacity_full` | `SCANYM_SCHEDULE_SLOT_FULL` | refresh |
| *(CSDJ-3)* structure check failed | `SCANYM_SCHEDULE_MALFORMED` | reselect |
| *(CSDJ-3)* echo ≠ retained (slot / date-only scope) | `SCANYM_SCHEDULE_SLOT_INVALID` | refresh |
| *(CSDJ-3)* echo ≠ retained (window scope) | `SCANYM_SCHEDULE_TIME_INVALID` | refresh |

* The table is one object in the code (`SELECTION_REASON_TO_CODE`) and covers the **whole** closed catalogue; a unit test fails if the catalogue and the table diverge, and a conformance test compares the catalogue to `fulfillment_selection_reasons_v12()` and to `FULFILLMENT_SELECTION_REASONS_V12` when PR #146 is present (live in the scratch merge: 309 csdj tests, 0 skipped).
* `SCANYM_SCHEDULE_NOT_OFFERED` stays in the client's closed catalogue (fail-closed parser) but is **no longer emitted** by the server: the engine folds "nothing to select" into `selection_not_expected`.
* Customer wording is generic and identical for the refresh class in fr/en/ar (no count, no reason leaked; capacity is never revealed). CSDJ-2 already refetches availability on every schedule error.
* An unknown reason or any `CSDJ12_*` usage error is a defect: it aborts the transaction and is **not** converted into a customer code.

---

## 11. Reasons catalogue (read) — 9, closed

`no_offer_configured`, `granularity_missing`, `all_dates_closed`, `horizon_exhausted`, `no_offer_in_horizon`, **`preparation_calendar_missing`**, **`no_preparation_day_in_horizon`**, **`cutoff_unresolvable`**, **`capacity_exhausted`**. SQL `checkout_unfulfillable_reasons_v12()` ≡ TS `CHECKOUT_UNFULFILLABLE_REASONS_V12`. CSDJ-2 (`86f6d69`): closed parser on exactly these 9 (any other value ⇒ "not fulfillable", never shown raw), 4 new keys × fr/en/ar, conformance tests failing on any divergence; proven against PR #146 head `0a14b21` in a scratch merge. `capacity_exhausted` shows only a generic "no availability".

---

## 12. Compatibility and the real PROD predecessor (decision F)

### 12.1 Canonical hash expression
`prosrc` fingerprints are independent of PostgreSQL version and of `pg_get_functiondef` formatting; `pg_get_functiondef` hashes can differ between majors. Therefore: **primary fingerprint = `md5(replace(prosrc, chr(13)||chr(10), chr(10)))`** (line-ending-neutral), reported next to the raw `md5(prosrc)` so a CRLF install is visible rather than hidden. `md5(pg_get_functiondef)` (LF-normalised) is secondary and only comparable on the same major.

### 12.2 Repository chain (disposable PG16, real chain: PSM/VAT → B1 → B234 → B5 → CSDJ-1 → v1.2 at `0a14b21`)
| Function | raw `md5(prosrc)` | LF-normalised `prosrc` | `md5(pg_get_functiondef)` | ACL |
|---|---|---|---|---|
| `create_order` after B1 / B234 | `a6974421d9bd50369f815439bcd9bc8b` | same | `9de8eb2349d7ee5e1b28c3681739c717` | postgres, anon, authenticated |
| **`create_order` after B5 = repository head** (unchanged by CSDJ-1 and by v1.2) | **`c327445751333e7908d60e6d7f838eb5`** | same | `dffdcb4a14555780f3b8b510b494b1e6` | postgres, anon, authenticated |
| `update_order_status` (v29, unchanged by every later lot) | `96d497842e0701cb54358cafa4cbc5bd` | same | `05e3284c72b0ba18c70230bdc5e52dd1` | postgres, authenticated |
| `initiate_payment_attempt` | `70253c342aaa3ed7cc80bfe60181773b` | same | `eea194fde2488199c2029a433d220e25` | postgres, service_role |

The v1.2 migration changes none of the three (established on the real chain; Boulez's harness reports other `create_order` values — `ccbff371…` — because its chain stops before the head).

### 12.3 PROD values read by Dirac (`md5(prosrc)`)
| Function | PROD | Repository | Verdict |
|---|---|---|---|
| `create_order` | `c327445751333e7908d60e6d7f838eb5` | `c327445751333e7908d60e6d7f838eb5` | **identical** — PROD runs the repository head (B5 body) |
| `update_order_status` | `30748835d2e489627a9bede8abb7e468` | `96d497842e0701cb54358cafa4cbc5bd` | **differs only by line endings**: the repository body with every `\n` replaced by `\r\n` hashes to exactly `30748835…` (reproduced from `migration-v29-merchant-dashboard.sql`; LF → `96d49784…`, CRLF → `30748835…`). Same text, same logic; PROD was installed from a CRLF copy. |

So the difference is explained by a reproducible, byte-level cause, not by drift of logic. It is *derived* from one PROD hash per function; confirming it needs the read-only query below, which also verifies attributes and ACL (the `prosrc` match does not cover `SECURITY DEFINER`, `search_path`, ownership or grants).

### 12.4 Read-only query requested of Dirac (PROD)
```sql
select p.oid::regprocedure::text                                          as fn,
       md5(p.prosrc)                                                      as prosrc_raw,
       md5(replace(p.prosrc, chr(13)||chr(10), chr(10)))                  as prosrc_lf,
       md5(replace(pg_get_functiondef(p.oid), chr(13)||chr(10), chr(10))) as def_lf,
       p.prosecdef, p.proconfig, p.proacl::text, pg_get_userbyid(p.proowner) as owner
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_order','update_order_status','initiate_payment_attempt')
order by 1;
```
**Expected:** `create_order` raw = lf = `c3274457…`, `secdef = true`, `proconfig = {search_path=}`, ACL `postgres, anon, authenticated`; `update_order_status` raw `30748835…`, **lf `96d49784…`**; `initiate_payment_attempt` raw = lf `70253c34…`. Any other value ⇒ stop and investigate before any migration for PROD. (`def_lf` is informational: it can differ if PROD runs another PostgreSQL major.)

Also to confirm on PROD (existence only, read-only): the B1 table `order_delivery_fulfillment_snapshot`, the B5 columns (`discount_*`), and whether CSDJ-1 objects are installed (the CSDJ-1 migration is a DRAFT in `main`).

### 12.5 Consequences for the CSDJ-3 migration
1. The preflight pins `create_order` on `md5(replace(prosrc, CRLF, LF)) = c327445751333e7908d60e6d7f838eb5`, 1 overload, arity 8, `SECURITY DEFINER`, ACL, owner; and `update_order_status` / `initiate_payment_attempt` on §12.2 values (line-ending-neutral).
2. The patch is built from the live definition (`pg_get_functiondef`), one unique anchor, one inserted block; the post-patch md5 is pinned for the rollback file. Removing the inserted block must reproduce the pre-patch definition byte for byte (*to prove:* T-B15-1).
3. CSDJ-3 never touches `update_order_status` or payment functions; their fingerprints and ACL must be equal before and after (*to prove:* T-ACL-1).
4. Nothing is applied to PROD from this work.

---

## 13. Migration dependencies and test requirements

### 13.1 Dependency order
`CSDJ-1 v1.10` (DRAFT in `main`; PROD installation state to be confirmed, §12.4) → `CSDJ v1.2` (PR #146, DRAFT, not applied) → **`CSDJ-3`** (not started). The CSDJ-3 preflight must fail closed if any of the following is missing: dispatcher with the 4-argument signature; `validate_fulfillment_selection`; `reserve_fulfillment_capacity` (8 arguments); `order_fulfillment_capacity_reservation`; `fulfillment_capacity_is_holding`; `fulfillment_selection_reasons_v12()`; `orders.fulfillment_rule_id`; B1 snapshot table. Rollback file: drops the snapshot table and restores the pinned `create_order` (never drops engine objects).

### 13.2 Test requirements for the CSDJ-3 DRAFT (real PostgreSQL, separate sessions, `pg_stat_activity`-verified barriers; the lot is not complete without them)
| ID | Proof |
|---|---|
| T-RB-1 | `unavailable` at T3 (each of the 8 reasons reachable) ⇒ **no** `orders` row, **no** order-number increment, no `order_items`, no delivery snapshot, no reservation, no schedule snapshot, no notification queued |
| T-RB-2 | `capacity_full` at T4 (lost race) ⇒ the same complete rollback, including the row of the order that reached `reserve` |
| T-RB-3 | echo mismatch ⇒ complete rollback |
| T-RB-4 | structure error ⇒ complete rollback |
| T-RB-5 | forced failure *after* T4 (e.g. snapshot insert violation injected in the test) ⇒ reservation row also gone |
| T-RB-6 | atomic success: order + items + reservation + snapshot + queued notification all present, none partial |
| T-CC-1 | N concurrent `create_order` calls on the last place ⇒ exactly one succeeds, N−1 get `SLOT_FULL`, reservations = capacity |
| T-CC-2 | different buckets / dates / slots / tenants do not wait for each other |
| T-CC-3 | mixed concurrent `create_order` over several buckets ⇒ no deadlock (lock order §6 rule 3) |
| T-CC-4 | `create_order` ∥ `update_order_status(cancelled)` on the same bucket ⇒ consistent count, no overbooking |
| T-ISO-1 | `create_order` under a non-`READ COMMITTED` level fails with `25000` and leaves nothing behind |
| T-ID-1 | no schedule configured, nothing sent ⇒ rows, result and notification payload identical to the pre-lot behaviour |
| T-ID-2 | capacity off ⇒ validation still enforced (forged/stale date refused), `reserve` not called |
| T-ID-3 | `derived_earliest`: missing echo ⇒ `REQUIRED`; forged/stale ⇒ `DATE_NOT_ELIGIBLE`; later date accepted only if all earlier eligible dates are full; stored date is the engine's |
| T-ID-4 | `time_within_window`: stored `selected_time`/`slot_key NULL`, reservation bucket `''` |
| T-ID-5 | each of the 59 cases of Boulez's shared fixture (`tests/fixtures/checkout-scheduling-v12-cases.json`): every offered (date, slot/time) is accepted by `create_order`; an unlisted one is refused |
| T-NT-1 | notification payload carries the additive schedule keys; identical to before otherwise |
| T-ACL-1 | arity, parameter names, result columns, owner, `SECURITY DEFINER`, `search_path`, ACL of `create_order`; `update_order_status` and `initiate_payment_attempt` fingerprints and ACL unchanged before/after; snapshot table has no write grant for any application role |
| T-B15-1 | B1/B5 preserved: removing the inserted block restores the pre-patch `create_order` byte for byte; the B1/B5 snapshot rows and delivery fee are unchanged for delivery orders |
| T-HASH-1 | preflight refuses a wrong predecessor (altered body, CRLF-neutrality respected) |
| T-SNAP-1 | snapshot columns equal the validate row; no client raw value; table coherence constraints enforced |

TS-side (already in CSDJ-3 `5e6c3bf`): structure parsing, normalisation, 8-reason mapping and its conformance to the engine catalogue, echo equality, reservation request, snapshot columns, notification keys, guards (no second capacity algorithm, no eligibility vocabulary, server-only modules).

---

## 14. Items still blocking production

| Ref | Item | Owner | State |
|---|---|---|---|
| BP-1 | Expiry/release of abandoned payments (a `pending` order holds its place indefinitely) | CTO (decision) / payment-engine owner | open |
| BP-2 | PROD read of §12.4 and confirmation of installed CSDJ-1 / B1 / B5 objects | Dirac | open |
| BP-3 | Boulez countersignature of A1–A6 (§15) | Boulez | open |
| BP-4 | CSDJ-3 DRAFT SQL + rollback + preflight (§13.1) | Debussy | **blocked on §15** |
| BP-5 | Multi-session PG test suite of §13.2 through the real `create_order` | Debussy | **blocked on BP-4** |
| BP-6 | `READ COMMITTED` on every call path (PostgREST default; no pool override) | Dirac / Boulez | open |
| BP-7 | Boulez harness chain to include B5 for the "`create_order` unchanged" proof | Boulez | open |
| BP-8 | PROD inventory before applying v1.2; apply order v1.2 → CSDJ-3 | Boulez / CTO | open |
| BP-9 | Holiday dataset, jurisdictions and its owner (engine ready, tables empty) | product | open |
| BP-10 | No merchant UI for v1.2 schedules/capacity; no schedule activated | product | open |
| BP-11 | Independent security review of the `SECURITY DEFINER` block | reviewer | open |
| BP-12 | `NEXT_PUBLIC_CHECKOUT_SCHEDULE_ENABLED` stays OFF until BP-1…BP-6 are closed and CSDJ-3 is applied on the target database | CTO | OFF |

---

## 15. Code adjustments register and acceptance

### 15.1 Adjustments (preserving completed work)
| Owner | Adjustment | State |
|---|---|---|
| Debussy | CSDJ-2: no change needed — wire format kept; 9-reason catalogue, translations, conformance (`86f6d69`); refetch on every schedule error already present | **done**, 337 csdj tests + `tsc` 0 on a scratch merge with PR #146 `0a14b21` |
| Debussy | CSDJ-3 TS: eligibility oracle removed; structure + normalisation + single reason table + echo equality; reservation request/mapping per §6; snapshot from the validate row (`5e6c3bf`) | **done**, 309 csdj tests, 0 skipped, `tsc` 0 on the same scratch merge |
| Debussy | Contract file for PR #146 (this document) | **done** |
| Boulez | Documentation amendments A1–A6 (no engine change) | **pending** |
| Boulez | Harness chain through B5 (BP-7) | **pending** |
| Dirac | PROD read §12.4 | **pending** |
| Debussy | CSDJ-3 DRAFT SQL, rollback, preflight, multi-session PG tests | **not started — waits for §15.2** |

### 15.1b Evidence behind the statuses above
* Boulez's PG harness replayed here at PR #146 head `0a14b21`: **344 proofs, 0 failures** (exit 0).
* Real-chain fingerprints (§12.2) regenerated against `0a14b21`: identical to the earlier run for `create_order` (`c3274457…`).
* Scratch merge of CSDJ-2 `86f6d69` + `0a14b21`: 337 csdj tests pass, 0 skipped; `tsc` 0. Scratch merge of CSDJ-3 `5e6c3bf` + `0a14b21`: 309 csdj tests pass, **0 skipped** (the engine-conformance tests are live); `tsc` 0.
* Full suite on frozen trees, compared **by failure identity** with `main` (15 pre-existing failures): CSDJ-2 `86f6d69` = same 15; CSDJ-3 `5e6c3bf` = same 15 plus `gap-01 withdrawal-requests backoffice … (sent)`, a known intermittent test (it failed 1 run in 6 when re-run alone on this tree, which does not touch it, and 1 run in 4 on `main` earlier) — no regression attributed to this lot.

### 15.2 Acceptance — nothing is presumed
**Debussy (integration owner) — ACCEPTED.** I accept this contract as the single interface contract and will write the CSDJ-3 SQL only in conformity with §4–§13. I will not reopen CIO business decisions, will treat any divergence between the TS reference and the SQL as a defect, and will not merge, apply PROD SQL or enable the checkout flag.

**Boulez (engine owner) — PENDING.** To accept, post on PR #146 exactly:
```
CONTRACT ACCEPTED csdj-v1.2-interface-contract.md v3.0 blob <git blob SHA of this file at PR head>
```
and list, if any, numbered objections against A1–A6 (§2), the placement of the block (§6), the snapshot (§9) or the error table (§10). Until that comment exists this is Debussy's position, not an agreement. Boulez is also asked to confirm that: (a) the validate row's columns are exactly those of §4.3; (b) `time_within_window` buckets at date level; (c) `reserve` raises `CSDJ12_ALREADY_RESERVED` rather than returning a reason for a second call on one order; (d) a new reason or signature change implies a version bump with notice.

**Dirac (CTO delegate) — decision F.** Run §12.4 on PROD (read-only) and report the rows; the contract is final for fingerprints when they match the expected values.

When both signatures and the PROD read are in, CSDJ-3 SQL may begin. STOP conditions remain: no merge, no PROD SQL, no checkout activation.
