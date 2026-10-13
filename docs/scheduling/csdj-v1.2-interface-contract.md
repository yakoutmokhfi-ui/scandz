# CSDJ v1.2 ↔ CSDJ-2 / CSDJ-3 — Canonical interface contract

| | |
|---|---|
| Version | **3** — reconciliation with the CTO decisions A–F of the "FINAL CONTRACT RECONCILIATION" instruction (supersedes v2) |
| Engine | Boulez v1.2 — PR #146, branch `feature/csdj-v1.2-scheduling-engine` |
| Baseline | CSDJ-1 v1.10, `03441a5ef1d371e90e3bfe3438e1a29e211d0537` |
| Boulez | **ACCEPTED** for everything it owns (§13) |
| Debussy | **ACCEPTANCE PENDING** — and §2.5 / §6 / §7 contain **two fields only Debussy can fill** (marked `[DEBUSSY]`) because his document `CSDJ-V12-CSDJ3-FINAL-CONTRACT.md` (branches `86f6d69`, `67cc8fb`) is not reachable from the Boulez session (not on `origin`) |
| Mode | development only. No merge, no PROD SQL, `NEXT_PUBLIC_CHECKOUT_SCHEDULE_ENABLED` stays off, no merchant schedule activated. |

This is the single contract between the scheduling engine (Boulez) and the checkout integration (Debussy: CSDJ-2 selector, `create_order`, CSDJ-3 snapshot). It applies the CTO decisions; it does not reopen business decisions already taken by the CIO. **CSDJ-3 SQL may start only when both acceptances in §10 exist.**

## 0. CTO decisions → where they are applied

| # | Decision | Applied in |
|---|---|---|
| 1 | One reservation authority: Boulez v1.2; no second table, counting algorithm or lock | §1, §2.3, §5 |
| 2 | One order = one capacity unit, whatever the product count | §5 |
| 3 | Keep the place after `payment_status = failed/cancelled` while `orders.status ∉ {rejected, cancelled}`; expiry is a separate release decision | §6 |
| 4 | `create_order` always re-validates date and slot by the server authority, even with capacity off | §3, §4 |
| 5 | v1.2 catalogue in the CSDJ-2 parser, translations, conformance tests | §7 |
| 6 | `derived_earliest`: exact server-side treatment, no forged date | §4.3 |
| 7 | Single transaction: validation, order, reservation, snapshot succeed or fail together | §3 |
| 8 | Keep `create_order` arity/result, ACLs, B1/B5 protections; verify fingerprints on the real predecessor | §8 |
| **A** | Retain Debussy's tested `p_customer.schedule` structure; normalised **once**, server-side, into Boulez's validation parameters; **no second accepted client format** | §2.5 |
| **B** | `validate_fulfillment_selection` is the authoritative validation; CSDJ-3 never re-implements the eligibility algorithm; it may validate JSON structure and map business errors | §2.2, §4, §9 |
| **C** | Reuse `reserve_fulfillment_capacity` incl. `p_selected_time`; replay validation under the bucket lock; no duplicate table / lock / counter / holding predicate | §2.3, §5 |
| **D** | Snapshot populated from server-validated results only; client date/time values are never authoritative | §3 T5 |
| **E** | One exact ordering in `create_order`; pricing, order snapshots, notifications, return type and ACL preserved; full rollback proven on rejected / unavailable selection | §3, §11 |
| **F** | Real PROD predecessor: same canonical hash expression on both sides; investigate remaining differences before any PROD-bound migration | §8, `csdj-v1.2-prod-predecessor-fingerprints.md` |

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

### 2.5 `create_order` — unchanged signature; payload retained from Debussy (CTO A)
`create_order(p_slug text, p_service_mode text, p_items jsonb, p_table_number integer, p_customer jsonb, p_note text, p_language text, p_cgv_accepted boolean)` returns `(order_id, order_number, public_token, subtotal, delivery_fee, total)`. **Arity, parameter names, result columns and ACL (`postgres`, `anon`, `authenticated`) do not change.**

The customer's choice travels in the existing `p_customer jsonb` under the key **`schedule`** — Debussy's tested structure, retained as the **only** accepted client format. Boulez's earlier proposal (`fulfillment` / `slotKey`) is **withdrawn**; nothing in the engine depends on the client member names.

`[DEBUSSY]` Exact members of `p_customer.schedule`, their types and which are required per `date_selection_mode` / `slot_selection_mode`: **to be pasted verbatim from `CSDJ-V12-CSDJ3-FINAL-CONTRACT.md` into this section** (Boulez cannot read that file and will not paraphrase it).

**Normalisation — once, server-side, owned by CSDJ-3.** `create_order` (or one helper it calls) maps `p_customer.schedule` to exactly three values, and *only* these three ever reach Boulez:

| Boulez parameter | Type | Rule the mapping must satisfy |
|---|---|---|
| `p_fulfillment_date` | `date` | strict calendar date (`YYYY-MM-DD`); never derived from a timestamp or a timezone conversion on the client side |
| `p_slot_key` | `text` | a configured slot key (`^[a-z0-9_-]{1,40}$`) or `null`; if `schedule` carries no slot concept, `null` |
| `p_selected_time` | `text` | `HH:MM` 24 h, merchant-local wall time, or `null` |

Technical-compatibility check (the only ground for amending the payload): the three Boulez parameters can represent every combination `date_selection_mode × slot_selection_mode` the schema allows (date-only; named slot; free time inside a window; informational-only; `derived_earliest`). If Debussy's structure cannot express one of them — for example no way to carry a free time for `time_within_window`, or a window *start* instead of a time — that is a demonstrated incompatibility and must be raised as a numbered amendment in §10, not worked around by a second format.

CSDJ-3 may validate the JSON **structure** (object, member types, unknown members, strict date syntax) and refuse malformed payloads with its own error. It must **not** decide whether a date/slot/time is offered, whether a date is the derived one, or whether capacity remains: that is `validate_fulfillment_selection` (CTO B).

## 3. Transactional order inside `create_order` (CTO 4, 7, D, E)

Everything below runs in `create_order`'s own transaction. Any `raise exception` aborts it entirely: order row, items, order-number increment, pricing / B1 snapshots, notification enqueues, reservation row and fulfillment snapshot disappear together.

**Anchor (the one exact ordering).** All new steps run **after the last existing statement of `create_order` and immediately before its `return query`** — i.e. after the order, its items, delivery pricing, the B1/B5 persistence, the CGV acceptance row and every notification enqueue have been written, with `orders.fulfillment_rule_id` already persisted. They never run earlier and never interleave with existing statements. This anchor is the same whether CSDJ-3 is implemented as an in-body edit or as a wrapper (§8): the observable order is identical.

| Step | Action | Owner |
|---|---|---|
| T0 | Existing flow, **byte-for-byte unchanged** (restaurant / CGV / mode / items / pricing / B1 / notifications / `update public.orders …`) | existing |
| T1 | Read `p_customer.schedule`, validate its JSON structure, normalise **once** to `(date, slotKey, time)` (§2.5). Structure errors abort with CSDJ-3's own error | Debussy |
| T2 | `select * from validate_fulfillment_selection(<restaurant>, p_service_mode, <orders.fulfillment_rule_id>, date, slotKey, time)` — **always called**, every mode, capacity on or off, selection supplied or not. `p_now` omitted | Debussy calls / **Boulez decides** |
| T3 | Map: `not_required` → no fulfillment snapshot, continue · `valid` → continue · `unavailable` → **abort**, carrying `reason` verbatim | Debussy |
| T4 | **If and only if** T2 returned `capacity_applies = true`: `select * from reserve_fulfillment_capacity(<order_id>, <restaurant>, p_service_mode, <rule id>, selection_date, selection_slot_key, selection_time)` with the values **of the T2 row**. `reserved` → continue · `unavailable` → **abort** with `reason` verbatim | Debussy calls / **Boulez decides** |
| T5 | Immutable fulfillment snapshot insert, built **only** from the T2 row (`selection_date`, `selection_slot_key`, `selection_time`, `window_starts_at`, `window_ends_at`, `instant_starts_at`, `schedule_timezone`, `date_selection_mode`, `slot_selection_mode`). The client's raw values are never stored. Column names / table: `[DEBUSSY]` | Debussy |
| T6 | `return query` the unchanged six columns | existing |

Rules:
* `p_now` is omitted in both Boulez calls: they use the transaction timestamp, so T2 and T4 evaluate the same instant.
* T2 before the bucket lock is *advisory* for capacity (a concurrent order can take the last place between T2 and T4); T4 replays the same function under the bucket lock and is authoritative. Hence two `capacity_full` failures are normal: stale display (T2) and lost race (T4).
* `READ COMMITTED` must hold at T4 (the PostgreSQL default; PostgREST calls use it). `create_order` must not change the isolation level.
* The only lock taken through this contract is the bucket lock inside `reserve_fulfillment_capacity`. No other advisory lock is added; the tenant schedule-edit lock (seed 1104) is never taken by `create_order`.
* A rejected or unavailable selection must leave **zero** rows in `orders`, `order_items`, `order_fulfillment_capacity_reservation` and the snapshot table, and must not consume an order number — proven by the test in §11.

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
7. capacity enabled and the bucket (restaurant, mode, rule, date, slot-or-whole-date) already holds `capacity_max_orders` orders → `capacity_full` (advisory here; authoritative at T4).

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
| `v1.2`, capacity on | `valid` / `unavailable`, `capacity_applies = true` | called at T4; replays validate under the bucket lock; inserts the row |

## 5. Reservation rules

1. **One order = one unit** regardless of product count: neither `validate` nor `reserve` nor the count reads `order_items` (guarded by a structural test).
2. Strictly positive maximum, enforced by table constraints (`rfs_capacity_positive`, `rfs_capacity_complete`); capacity is refused on an `informational_only` schedule (`rfs_capacity_needs_date`).
3. Bucket = restaurant × mode × rule × date × slot (`''` for date-level). Counting is derived: reservation rows ⋈ `orders`, holding statuses per §6.
4. Concurrency: two sessions on the same last place serialise on the bucket lock; the second recalculates after the first commits and gets `capacity_full`. Different buckets, dates, slots and tenants do not wait for each other. Proven with real separate PostgreSQL sessions behind a `pg_stat_activity`-verified barrier (not simulated).
5. One reservation per order (`23505` otherwise). The client never sees a count; the public read only filters.
6. A refused order never reaches the reservation: it is aborted at T3 or T4 and rolled back with the order.

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

## 8. Compatibility and PROD predecessor (CTO 8, F)

**Canonical expression** on both sides: `md5(replace(prosrc, E'\r\n', E'\n'))`, shown next to the raw `md5(prosrc)`. Full evidence, the read-only PROD queries and the comparison tool are in [`csdj-v1.2-prod-predecessor-fingerprints.md`](./csdj-v1.2-prod-predecessor-fingerprints.md).

| Object | PROD `md5(prosrc)` (Dirac) | Boulez chain (LF) | Status |
|---|---|---|---|
| `update_order_status(uuid,text)` | `30748835d2e489627a9bede8abb7e468` | `96d497842e0701cb54358cafa4cbc5bd` | **Explained**: PROD stores the v29 body with CRLF line endings; LF-normalised it is identical to the chain. No functional difference. |
| `create_order(text,text,jsonb,integer,jsonb,text,text,boolean)` | `c327445751333e7908d60e6d7f838eb5` | `ccbff371d8a30fed36928a624b2a0878` | **Unexplained**: matches no definition in the repository or in any of the 180 remote refs, under any line-ending / whitespace normalisation. |

Consequences:
1. The Boulez harness chain is **not** a faithful PROD predecessor for `create_order`. The v1.2 migration does not touch `create_order`, so the engine is unaffected; any CSDJ-3 claim about `create_order` internals ("B1/B5 byte-preserved", "pricing unchanged") must be proven against **PROD's real body**, not the chain's.
2. **No CSDJ-3 migration intended for PROD may be produced** until PROD's exact `prosrc` is diffed (procedure in the fingerprints document) and the nearest lineage identified. A migration that carries any `create_order` body must also start with a **fingerprint guard**: abort unless `md5(replace(prosrc, E'\r\n', E'\n'))` of the live function equals the expected predecessor value, and re-check the same value in the post-flight.
3. **Implementation form — decision for Debussy / CTO, recommended: wrapper.** Instead of rebasing a body that cannot yet be reproduced, CSDJ-3 can *rename* the live function to an internal name (body and everything it does untouched, whatever PROD's body is), revoke every grant on the renamed function, and create a new `create_order` with the **same name, arity, result and ACL** that calls it and then runs T1–T6 on the returned `order_id` (reading `orders.fulfillment_rule_id`, `restaurant_id`, `service_mode` from the new row). This is the pattern already used for the resolver dispatcher (§1 of the architecture document): pricing, B1/B5, notifications and the return type are preserved *by construction* and need no fingerprint of the body — only a guard that the live function is the one that was renamed. Requirements if chosen: the renamed function must have **no** grant to `anon`, `authenticated`, `service_role` (else validation can be bypassed by calling it directly); the wrapper is `SECURITY DEFINER`, `search_path = ''`, and its ACL equals the original (`postgres`, `anon`, `authenticated`); `p_customer` keeps passing through unchanged (the inner function ignores members it does not read — to be confirmed against PROD's body).
   The in-body alternative is acceptable only after item 2 is closed.
4. Whatever the form: arity, parameter names, result columns and ACL are frozen (§2.5), and the md5 + ACL of `update_order_status`, `initiate_payment_attempt`, pricing functions must be unchanged by the CSDJ-3 migration (same inventory check the v1.2 harness performs, check [15]).

## 9. Migration dependencies and order

1. CSDJ-1 v1.10 (applied on PROD, migration `csdj1_checkout_scheduling_foundation_v1`).
2. **CSDJ v1.2 migration** (`DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2.sql`, this PR): needs CSDJ-1 present, `orders`, `restaurants`, `has_role_in`, `is_member_of`, `is_scanym_operator`. Introduces everything in §2.2–§2.4. Preflight refuses a second application or a drifted schema.
3. **CSDJ-3 migration** (Debussy): needs (2) — it calls `validate_fulfillment_selection` and `reserve_fulfillment_capacity`; its preflight must refuse to run if either is missing. Needs the PROD `create_order` fingerprint guard of §8.
4. CSDJ-2 front-end: needs the 9-reason parser (§7.1) and the `schedule` payload; ships behind `NEXT_PUBLIC_CHECKOUT_SCHEDULE_ENABLED` (off).
5. Rollback order is the reverse; the v1.2 rollback refuses to run while reservation rows exist, and CSDJ-3's rollback must come first.

## 10. Items still blocking production

1. **Debussy acceptance** of this contract, including the two `[DEBUSSY]` fields — blocks CSDJ-3 SQL.
2. **PROD `create_order` body** (§8): unexplained fingerprint; blocks any PROD-bound CSDJ-3 migration.
3. **Pending / failed-payment expiry** (CTO 3: separate release decision). Until then abandoned orders hold places.
4. **End-to-end proof through the real `create_order`** (§11) — Debussy's PG tests.
5. **CSDJ-2 conformance** (9-reason parser, translations, tests, `schedule` payload).
6. **PROD inventory check** before applying the v1.2 migration (Boulez / CTO).
7. **Holiday dataset / jurisdictions** and the owner of its upkeep — product decision; engine ready and empty.
8. **No merchant UI** to configure v1.2 schedules or capacity; no schedule is activated.
9. `NEXT_PUBLIC_CHECKOUT_SCHEDULE_ENABLED` stays off until 1–5 are closed.

## 11. Test requirements

**Boulez (already in PR #146; PG16 harness, 344 proofs):** `validate_fulfillment_selection` over every `date × slot` mode incl. `derived_earliest`, free time, v1 rows, informational, malformed input; reserve replays validate under lock; real multi-session concurrency (barrier verified through `pg_stat_activity`); rollback fidelity; md5 + ACL of `create_order`, `update_order_status`, payment and pricing functions unchanged; mutation controls.

**Debussy (CSDJ-3 — required before acceptance of the SQL):**
1. Fingerprint guard test: migration refuses on a mismatching `create_order` (both the pre-flight and the post-flight).
2. Rollback on refusal, for each of: payload structure error, `validate → unavailable` (each of the 8 reasons reachable), `reserve → unavailable`, forced exception after T4 — after each, `count(*)` is unchanged in `orders`, `order_items`, `order_fulfillment_capacity_reservation`, the snapshot table, the notification outbox, and `restaurant_configs.next_order_number` is unchanged.
3. Real concurrency **through `create_order`**: N sessions on the last place → exactly one order created; the others refused with `capacity_full` and zero residue.
4. `derived_earliest`: forged later date refused; stale date refused; date rolled forward when the first date fills.
5. Snapshot values equal the T2 row, never the client's raw values (submit `2026-10-14T23:30:00+14:00`-style or differently cased input and show the stored value is the server's).
6. `create_order` and all ACLs: arity, result columns, grants identical before / after; the six-column result unchanged on a no-schedule order (historical flow byte-identical).
7. Isolation: a call under `REPEATABLE READ` aborts with `CSDJ12_ISOLATION_REQUIRED` when capacity applies.
8. Parser / i18n conformance (CSDJ-2): the 9 read reasons and 8 selection reasons are the closed lists from `lib/scheduling/schedule-model-v12.ts`; an unknown value is treated as unfulfillable.

## 12. Ownership of adjustments

| Adjustment | Owner | Status |
|---|---|---|
| `validate_fulfillment_selection`, `reserve_fulfillment_capacity(+p_selected_time)`, catalogues, harness | Boulez | **done** (PR #146) |
| Withdraw Boulez's `fulfillment`/`slotKey` payload proposal | Boulez | **done** (§2.5) |
| Paste Debussy's exact `schedule` members and snapshot columns into §2.5 / §3 T5 | Debussy | open |
| `schedule` → `(date, slotKey, time)` normaliser, structure validation, error carrier | Debussy | open |
| PROD `create_order` body read + diff | Dirac / Debussy | open (§8) |
| Implementation form: wrapper vs in-body | Debussy, CTO decides | open (§8.3) |
| CSDJ-2 parser, translations, conformance tests | Debussy | open |
| If Debussy's structure cannot express a mode combination: Boulez adds the missing *validation parameter* only after a numbered amendment | Boulez | on demand |

## 13. Acceptance

**Boulez (engine owner)** — accepted for §1, §2.1–§2.4, §4–§7, §9, §11 (first block). The signatures in §2 are those of the migrated PG16 cluster. Boulez will not change a signature, a result value or a reason in §2 / §7 without a version bump and notice to Debussy.

**Debussy (integration owner)** — *pending*. To accept, post on PR #146 exactly:

```
CONTRACT ACCEPTED csdj-v1.2-interface-contract.md blob <git blob SHA of this file at PR head>
```
after (a) pasting the two `[DEBUSSY]` fields, (b) answering §8.3 (wrapper or in-body), and (c) listing any amendment as a numbered point. Until that comment exists, this document is Boulez's final position, not an agreement.
