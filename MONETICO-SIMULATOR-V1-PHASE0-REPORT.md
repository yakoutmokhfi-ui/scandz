# SCANYM — MONETICO PAYMENT SIMULATOR v1
## Phase 0 report: architecture investigation + design proposal

Branch: `feature/monetico-simulator-v1` (from `main` = `03441a5ef1d371e90e3bfe3438e1a29e211d0537`, verified).
Status: **INVESTIGATION + DESIGN DONE — IMPLEMENTATION NOT STARTED** (stopped for CTO/CIO decisions, §6).

---

## 1. Git baseline (verified)

| Item | Result |
|---|---|
| `origin/main` HEAD | `03441a5` — matches the brief |
| PR #146 commit `11bfa548` | **not** in `main`, not in this branch (unreachable from the shallow clone of `main`; only on `feature/csdj-v1.2-scheduling-engine`) — no scheduling code incorporated |
| `release/payment-p3a2-monetico-adapter-v1`, `release/payment-p3b-monetico-v4-6`, `release/payment-stream-b-monetico-finalization-v1-1` | all three are **ancestors of `main`** — no unmerged payment work exists on side branches; `main` is the correct baseline |
| Baseline tests (`v111*`, `v125`–`v137`, 285 tests) | 284 pass, **1 pre-existing failure** on `main`: `v111h` structural test counts SQL files under `supabase/` (expects 96, finds 181). Stale assertion unrelated to payment logic. Not touched. |

## 2. Existing payment architecture (as found on `main`)

```
Browser ──POST {orderId, publicToken, language}──▶ /api/payments/monetico/checkout  (thin HTTP adapter)
                                                     └─ initiateCheckout()  lib/server/payment-checkout-runtime.ts
                                                          1. kill-switch PAYMENT_CHECKOUT_RUNTIME_ENABLED === "true"
                                                          2. language canonical (FR/EN)                    [pure]
                                                          3. get_order_payment_context (possession proof)  → paid / not_required ⇒ checkout_not_needed
                                                          4. get_order_currency_preflight → EUR only
                                                          5. get_payment_runtime_provider_environment → is_enabled && configuration_status === "verified", mode ∈ {test, live}
                                                          6. resolveMoneticoSubmissionUrl(mode) → https://p.monetico-services.com[/test]/paiement.cgi
                                                          7. get_order_active_payment_attempt (resume vs fresh)
                                                          8. get_payment_provider_credential (Vault) → {tpe, societe, securityKey(40 hex)}
                                                          9. billing (mandatory) + shipping (if service_mode = delivery, must be delivery_reuse)
                                                         10. canonical public origin + 2 return-relay tokens (HMAC, 2h TTL) → url_retour_ok / url_retour_err
                                                         11. ONLY NOW: initiate_payment_attempt (SQL) — fresh path only
                                                         12. buildMoneticoPaymentRequest → fields + MAC (HMAC-SHA1 over sorted "k=v*k=v…")
                                                     ◀── { outcome:"ready", submissionUrl, fields, resumed }

Browser ──auto-POST fields──▶ Monetico hosted page  ──(customer pays)──▶
      Monetico ──S2S POST x-www-form-urlencoded {…, code-retour, montant, reference, numauto, MAC}──▶ /api/payments/monetico/callback
                                                     └─ processMoneticoCallback()  lib/server/payment-callback-runtime.ts
                                                          Stage A: parse → correlate (get_payment_transaction_correlation) → credential → verifyMac
                                                                   → classifyMoneticoCodeRetourForMode(code-retour, mode)
                                                                   → record_payment_provider_event (durable inbox, fingerprint-dedup) → ACK "version=2\ncdr=0\n"
                                                          Stage B: claim_payment_provider_event_by_id → processClaimedPaymentProviderEvent()
                                                                   paid + amount/currency match ⇒ confirm_payment_attempt('paid') ⇒ Stuart post-payment hook (best-effort)
                                                                   refused/pending/unknown ⇒ inbox "ignored" (never confirm)
      Monetico ──browser redirect──▶ /checkout/return/ok|err?orderId&token&lang → get_order_payment_status_snapshot (server read, relay token)
      Cron ──Bearer CRON_SECRET──▶ /api/internal/payments/monetico/recover → claim_payment_provider_events (batch) → same Stage B
```

SQL (all `SECURITY DEFINER`, `search_path = ''`, `service_role` EXECUTE only, no direct table grants — P1 "RPC-only authority"):

* `initiate_payment_attempt(order, provider, reference)` — locks order; refuses if `payment_status = 'paid'`, `total <= 0`, an active `pending` or a `paid` attempt exists. Sets `orders.payment_status = 'pending'`, `current_payment_transaction_id`. **Does not check `not_required`** (that gate is in TS only).
* `confirm_payment_attempt(provider, reference, status, numauto)` — terminal lock-in (`paid/failed/cancelled` final; identical replay = idempotent no-op; any other transition ⇒ SQLSTATE 42501). Updates `orders.payment_status` **only if** the attempt is the current one (old-callback protection).
* Inbox (P3-B5): `record_payment_provider_event` (dedup by fingerprint), `claim_*` (lease + token), `update_payment_provider_event_processing_status` (bounded retries, P0004 stale claim, 42501 rejected transition).
* `payment_provider_configs.mode` is DB-constrained to `('test','live')`; `configuration_status ∈ ('not_configured','configured','verified')`.

Idempotency properties already in place and reusable by the simulator: one active attempt per order (partial unique index + RPC), resume path reuses the stored reference, callback dedup by fingerprint, terminal lock-in on confirm, ACK independent of Stage B.

## 3. Verification of Boulez's findings

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| 1 | Customer UI never calls the checkout route | **CONFIRMED** | `grep "payments/monetico"` in `app/`, `components/`: zero callers. `components/MenuView.tsx` → `createOrder()` → `create_order` RPC → WhatsApp / tracking flow. No payment step exists in the customer journey. |
| 2 | New orders default to `payment_status = 'not_required'` | **CONFIRMED** | `orders.payment_status text not null default 'not_required'` (P1). `create_order` never writes it. The only writer of `'pending'` is `initiate_payment_attempt` itself. |
| 3 | Initiation expects an appropriate state | **CONFIRMED and worse: a dead-lock** | `initiateCheckout` returns `checkout_not_needed/not_required` when status is `not_required`; the only thing that would move it to `pending` is the initiation it refuses. **Today no order can ever reach a Monetico form**, regardless of the simulator. A "payment required" decision (who/when) is missing from the model. |
| 4 | Callback + inbox provide processing infra | **CONFIRMED** | Stage A/B + recovery worker + 13 test files (v125–v137) cover it. The simulator can drive this path as-is by producing MAC-valid callbacks. |
| 5 | Retry / terminal / late confirmation need care | **CONFIRMED, already handled** | Terminal lock-in + old-callback protection (SQL), bounded retry `MAX_RETRY_ATTEMPTS = 5` + SQL cap, `stale_claim` vs `finalize_rejected_transition` distinction (v4.3). Simulator scenarios must *exercise*, not re-implement, these. |
| **6 (new)** | No code path ever sets `configuration_status = 'verified'` | **GAP** | `set_payment_provider_credentials` sets `'configured'`; nothing in SQL or TS writes `'verified'`; the runtime requires `'verified'`. Even with real CIC credentials the checkout would return `provider_unavailable`. Needs an operator/verification step (or the simulator's own verification scenario). |
| **7 (new)** | `mode` is DB-constrained to `test|live` and `resolveMoneticoSubmissionUrl` maps `test` → the real `p.monetico-services.com/test/paiement.cgi` | **Design constraint** | A simulator cannot be a third `mode` without a SQL migration and a mode-classification rewrite. It must be an *endpoint substitution under `mode = 'test'`*, fail-closed. |
| **8 (new)** | `payetest` is the only `paid` code accepted in `test` mode; `paiement` is degraded to `unknown`/mode-mismatch | **Useful** | The simulator must emit `payetest` for an accepted sandbox payment, and can emit `paiement` deliberately to exercise the mode-mismatch path. |

## 4. Design proposal — "Monetico Simulator v1"

Principle: **the simulator replaces only the external party (Monetico's hosted page + its S2S notifier). Every SCANYM component — checkout runtime, SQL state machine, callback route, inbox, recovery worker, return pages — runs unmodified and is exercised for real.**

### 4.1 Activation boundary (fail-closed, three independent conditions)

The simulator endpoint is substituted for the Monetico submission URL **only if all three hold**:

1. `PAYMENT_MONETICO_SIMULATOR_ENABLED === "true"` (exact string, same discipline as the existing kill-switch);
2. `VERCEL_ENV !== "production"` **and** `NODE_ENV !== "production"` — hard refusal in production even if the variable is set (logged as a configuration fault);
3. the merchant's persisted `mode === "test"` — a `live` merchant is **never** routed to the simulator, whatever the env says.

Everything else in `initiateCheckout` is untouched: the real credential (or a synthetic test credential), the real MAC, the real `initiate_payment_attempt`. The only diff in the runtime is one line: `submissionUrl = resolveSubmissionUrl(mode)` → `resolveSubmissionUrl(mode, simulatorPolicy)`.

The simulator routes themselves are also gated by condition 1+2 and return 404 otherwise (no information leak, no attack surface in prod).

### 4.2 Components to add (all new files, isolated under `simulator/`)

| Path | Role |
|---|---|
| `lib/server/payment-providers/monetico/simulator/policy.ts` | `isMoneticoSimulatorActive()` — the three-condition gate; pure, tested. |
| `lib/server/payment-providers/monetico/simulator/inbound.ts` | Verifies an inbound payment-form POST exactly as Monetico would: field presence, `version=3.0`, `TPE`, `montant` format, `date` format, `reference` ≤ 12 chars, **MAC recomputed with the merchant's credential** (read via `get_payment_provider_credential` — so a wrong key is rejected like the real TPE would). Decodes `contexte_commande` to show billing/shipping. |
| `lib/server/payment-providers/monetico/simulator/outcome.ts` | Builds the outgoing S2S callback for a chosen scenario: `{version:"3.0", TPE, date, montant, reference, "code-retour", numauto?, texte-retour, cvx, vld, brand, motifrefus?, …}` + **MAC computed with the same key** (so the real `verifyMac` must pass). Deterministic given `(reference, scenario, seed)`. |
| `app/api/payments/monetico/simulator/page/route.ts` (POST) | The "hosted page": accepts the auto-posted form, runs `inbound.ts`, renders a minimal HTML page listing the verified request + a scenario selector. Only reachable when the gate is open. |
| `app/api/payments/monetico/simulator/decide/route.ts` (POST) | Takes `(reference, scenario)`, builds the callback via `outcome.ts`, **POSTs it server-to-server to the app's own `/api/payments/monetico/callback`** (through `resolveCanonicalPublicOrigin()`, never a request header), records the ACK, then 303-redirects the browser to `url_retour_ok` or `url_retour_err` as Monetico does. |
| `tests/v1xx-monetico-simulator-*.test.ts` | See §5. |
| `MONETICO-SIMULATOR-V1-*.md` | Runbook + audit evidence. |

No SQL migration is required for the core simulator (§4.4 lists the one optional helper).

### 4.3 Scenarios (deterministic, each maps to a real `code-retour`)

| Scenario id | Emitted `code-retour` | Expected SCANYM outcome (asserted by tests) |
|---|---|---|
| `paid` | `payetest` + `numauto` | Stage A `paid` → `applied_paid`, `orders.payment_status = 'paid'`, inbox `applied`, Stuart hook fired (non-live transport) |
| `refused` | `Annulation` + `motifrefus` | inbox `ignored`, attempt stays `pending`, no `confirm_payment_attempt`; browser → `url_retour_err` |
| `pending_partner` | `attente_partenaire` | inbox `ignored`, attempt stays `pending` |
| `unknown_code` | `xyz_unexpected` | `recorded_unknown`, never applied |
| `mode_mismatch` | `paiement` (prod code under `test` mode) | `recorded_mode_mismatch` → `unknown`, never applied |
| `bad_mac` | `payetest` with corrupted MAC | ACK `cdr=1`, **nothing recorded** |
| `amount_tamper` | `payetest`, `montant` ≠ attempt amount, MAC valid | recorded `paid`, Stage B `ignored / AMOUNT_CURRENCY_MISMATCH`, never applied |
| `duplicate_paid` | `payetest` sent twice | second = fingerprint replay, `isNewEvent=false`, idempotent |
| `late_after_paid` | `Annulation` after `paid` applied | inbox `ignored`; terminal lock-in untouched |
| `delayed_callback` | no S2S call; only browser redirect to `url_retour_ok` | return page shows "pending" (not "paid"); then a later `paid` S2S converges via callback **or** the recovery worker |
| `s2s_down` | S2S POST deliberately not acknowledged (simulated 500) | simulator retries like Monetico (bounded, documented) — exercises `record_failed`/replay |

Scenarios are selectable on the page **and** forceable via a `scenario` query param on the first POST (for automated E2E), plus a deterministic default derived from the amount's cents (e.g. `.01` → refused) for unattended runs — documented in the runbook.

### 4.4 The `not_required` deadlock (finding #3) — must be decided, not assumed

Three options; the simulator can be built against any of them but **one must be chosen** because it changes product semantics:

* **A. Per-merchant online-payment switch at order creation** — `create_order` sets `payment_status = 'pending'`… ✗ *not acceptable*: `'pending'` already means "an attempt is active" (P3-B3 resume logic reads it). Rejected.
* **B. New state `'required'`** in the `orders.payment_status` check constraint, set by `create_order` when the merchant has an enabled+verified Monetico config and the service mode requires prepayment. `initiateCheckout` treats `required` like it treats fresh initiation; `not_required` keeps its current meaning (WhatsApp/pay-on-delivery). *Minimal, explicit, auditable.* Needs one SQL lot (constraint + `create_order` delta) and a one-line TS change. **Recommended.**
* **C. Keep `not_required`** and let `initiateCheckout` initiate whenever the merchant has a verified Monetico config. ✗ *loses the "this order does not need payment" signal for existing merchants (Algeria/DZD, WhatsApp flows)*; rejected.

Finding #6 (`verified` unreachable) similarly needs a decision: an operator RPC `verify_payment_provider_configuration` (operator-authorization lot pattern) or the simulator's own "verification handshake" that flips `configured → verified` after one successful `paid` round-trip in test mode. Recommended: **operator RPC** (explicit human act, auditable), independent of the simulator.

### 4.5 Security posture (what the auditor will check)

* No real Monetico URL is ever contacted by the simulator; no real payment can be initiated (gate §4.1, structural test asserts the simulator module never imports `endpoint.ts` constants and that `live` mode is unreachable).
* Secrets: the simulator reads the merchant key through the **same** `get_payment_provider_credential` RPC (Vault), never logs it, never renders it in HTML; MAC values are never displayed.
* The callback it produces is indistinguishable from a real one to the callback route — which is the point: the route's MAC verification, correlation, mode-aware classification and inbox are all exercised unmodified.
* Simulator routes are `runtime = "nodejs"`, respond 404 when gated off, carry no auth of their own (they are reachable only in non-production deployments by construction) — to be confirmed by CTO (§6, Q3).

## 5. Test plan (to be implemented with the code)

1. `policy` — truth table of the three conditions (8 combos; only 1 opens the gate).
2. `inbound` — accepts the output of the real `buildMoneticoPaymentRequest`; rejects wrong MAC, wrong TPE, malformed `montant`, missing `url_retour_*`.
3. `outcome` — every scenario's callback passes the real `verifyMoneticoCallback` with the same credential; `bad_mac` fails it; determinism (same inputs ⇒ byte-identical fields).
4. Integrated matrix (same style as `v133`/`v137`, `rpc` mocked per name): each scenario in §4.3 asserted end-to-end through `processMoneticoCallback` + `processClaimedPaymentProviderEvent`, including the ACK bytes.
5. Structural: simulator never referenced from `live` branch; no new third-party dependency; no SQL file added unless option B is chosen (then the `v111h` count assertion must be updated — it is already broken on `main`).

## 6. Decisions requested before implementation (STOP point)

| # | Question | My recommendation |
|---|---|---|
| Q1 | `not_required` deadlock: option **B** (new `'required'` state + `create_order` delta, one SQL lot) vs A/C? | **B** |
| Q2 | `verified` unreachable: operator RPC lot, or simulator handshake, or out of scope for v1 (tests mock it; staging DB patched by hand)? | Operator RPC lot — but **out of this branch**; v1 simulator tests mock `verified`, runbook documents the manual staging step |
| Q3 | Simulator routes: env-gated only (404 in prod), or also behind a shared secret/basic auth on staging? | Env-gated + `VERCEL_ENV` guard is sufficient; add a secret if staging is publicly reachable |
| Q4 | Scope of v1: simulator **only** (customer UI "Pay" button and `create_order` delta left to a separate lot), or include the minimal UI call to the checkout route so Au Lait Cru can be demoed end-to-end? | Simulator only + an internal demo page under the same gate (no customer-facing UI change) |
| Q5 | The brief was truncated after §4 "Idempot…": please resend §4 (rest) → end (acceptance criteria, deliverables, audit format). | — |

No code beyond this report has been written on the branch.
