# `orders.payment_status = 'required'` — integration lot specification

Status: **SPECIFICATION ONLY** (CTO decision Q1). Nothing below is implemented on `feature/monetico-simulator-v1`. To be delivered as a separate, versioned, independently audited lot, coordinated with Debussy and the payment owner.

## 1. Problem (verified on `main` 03441a5)

* `orders.payment_status` defaults to `'not_required'`; `create_order` never writes it.
* `initiateCheckout` returns `checkout_not_needed/not_required` for that state.
* The only writer of `'pending'` is `initiate_payment_attempt`, which the runtime refuses to call in that state ⇒ **no new order can ever reach a payment form**. Today a form is reachable only for `failed`/`cancelled` orders (retry) — which is what the simulator tests use, honestly.

## 2. Target semantics

| `payment_status` | Meaning | Written by |
|---|---|---|
| `not_required` | order needs no online payment (WhatsApp / pay on pickup / DZD merchants) — **unchanged** | default, `create_order` (when online payment not required) |
| **`required`** (new) | online payment is required and no attempt exists yet | `create_order` |
| `pending` | an attempt is active (unchanged, P3-B3 reads it) | `initiate_payment_attempt` |
| `paid` / `failed` / `cancelled` | unchanged | `confirm_payment_attempt` |

## 3. SQL changes (one lot, with rollback)

1. `alter table public.orders drop constraint <payment_status check>; add constraint … check (payment_status in ('not_required','required','pending','paid','failed','cancelled'))`. Note: the P1 lot created it inline — the constraint name must be read from `pg_constraint` at migration time (same drift-guard style as P1).
2. `create_order` delta: compute `v_payment_required boolean` server-side and set `payment_status = case when v_payment_required then 'required' else 'not_required' end`. Proposed rule (to be confirmed by the payment owner): `exists (select 1 from payment_provider_configs c where c.restaurant_id = v_restaurant_id and c.is_enabled and c.configuration_status = 'verified')` **and** `total > 0` **and** `currency = 'EUR'` (Monetico-only today). Everything else stays `not_required`.
3. `initiate_payment_attempt`: **no change strictly needed** (it only refuses `paid`), but add an explicit guard `if v_order.payment_status not in ('required','failed','cancelled','pending') then raise … 42501` so the DB, not only TS, refuses `not_required` (defense in depth).
4. `get_order_payment_status_snapshot` / return pages: map `required` to the same wording as `pending`-without-attempt ("payment not completed").
5. Indexes: `idx_orders_payment_status` already covers the new value.

## 4. TypeScript changes

* `payment-checkout-runtime.ts` §2/3: `context.paymentStatus === "required"` proceeds to the fresh path (resume path unreachable by construction — no attempt exists). No other change.
* `payment-service.ts` `OrderPaymentContext.paymentStatus` union: add `"required"`.
* Dashboard/back-office status rendering (Nougaro's scope — coordinate): add a label for `required`.
* Customer UI: a "Pay" step after `create_order` when `payment_status === 'required'` — **out of scope here (CTO Q4)**.

## 5. Tests to add in that lot

* SQL harness: constraint accepts `required`; `create_order` sets `required` iff the rule holds; `initiate_payment_attempt` refuses `not_required` (42501) and accepts `required`.
* `v125`-style runtime test: `required` → fresh initiation; `not_required` → unchanged `checkout_not_needed`.
* Structural: `v111h`/`v110c` SQL-file-count assertions (already stale on `main`, see audit handoff) must be rebased.

## 6. Simulator tests that will only become a *true* customer E2E once `required` exists

Today they start from `payment_status = 'failed'` (legitimate retry). After this lot they should be duplicated with a fresh `required` order; until then **no "real checkout E2E PASS" is claimed** (CTO Q5):

* `v163c` — all 15 scenario tests (`paid`, `refused`, `pending_partner`, `abandoned`, `delayed_confirmation` ×2, `unknown_code`, `mode_mismatch`, `bad_mac`, `amount_tamper`, `currency_tamper`, `duplicate_paid`, `refused_then_paid`, `paid_then_refused`, `provider_timeout_retry`);
* `v163a` #11 (runtime substitution on a fresh order);
* a future browser-driven smoke (storefront → create_order → Pay → simulator page → return page) — requires the customer "Pay" step (Q4) as well.

## 7. Also required before any real checkout: `configuration_status = 'verified'`

No code path sets `verified` (Phase 0 finding #6). Proposed: operator RPC `verify_payment_provider_configuration(p_restaurant_id, p_provider_code)` in the PAYMENT OPERATOR AUTHORIZATION lot family (is_scanym_operator(), SECURITY DEFINER, sets `configuration_status = 'verified'`, `last_verified_at = now()`, refuses when `configured` is not the current state, audit row). The simulator uses fixtures/mocks for `verified` (CTO Q2) and never writes provider configuration.
