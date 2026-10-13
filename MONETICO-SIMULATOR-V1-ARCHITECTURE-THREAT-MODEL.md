# MONETICO PAYMENT SIMULATOR v1 — Architecture & threat model

Branch `feature/monetico-simulator-v1` · baseline `main` = `03441a5e` · **non-production facility, no production authorization.**

## 1. What the simulator is — and is not

It replaces **only the external party**: Monetico's hosted payment page and Monetico's server-to-server notifier. Every SCANYM component runs **unmodified**: `initiateCheckout` (same credential, same MAC, same `initiate_payment_attempt`), the SQL state machine, `/api/payments/monetico/callback`, Stage A/B, the inbox, the recovery worker, the return pages.

It is not a mock of the application, not a "mark as paid" button, and never contacts a bank endpoint (structural test: no provider hostname, no import of `endpoint.ts` anywhere in the simulator).

```
browser ──POST form──▶ initiateCheckout (unchanged) ─▶ submissionUrl = SIMULATOR PAGE   (only when the gate is open)
browser ──auto-POST signed form──▶ /api/internal/payments/monetico/simulator/page
        page: correlate reference → merchant (existing RPC) → mode must be `test` → credential (existing Vault RPC)
              → verify form like the TPE (TPE/societe/version/montant/date/reference/MAC)
              → amount must equal the authoritative attempt amount → return URLs must be same-origin
              → HMAC binding(reference, url_ok, url_err) → HTML (no secret material)
operator ──POST scenario + operator secret──▶ /api/internal/payments/monetico/simulator/decide
        decide: gate → operator secret → scenario id ∈ catalog → binding → same-origin → re-resolve merchant/amount server-side
              → for each step: build signed callback (merchant key) → POST to <canonical origin>/api/payments/monetico/callback (bounded retry)
              → 303 to url_retour_ok|err  (or JSON report for automated drivers)
/api/payments/monetico/callback (unchanged) ─▶ Stage A/B ─▶ confirm_payment_attempt (unchanged)
```

## 2. Files

| File | Role |
|---|---|
| `lib/server/payment-providers/monetico/simulator/policy.ts` | activation gate (§3), simulator URL from canonical origin |
| `…/simulator/auth.ts` | operator secret, constant-time; Bearer or body field only |
| `…/simulator/session.ts` | HMAC-SHA256 binding of (reference, return URLs); same-origin check |
| `…/simulator/inbound.ts` | TPE-like verification of the merchant form |
| `…/simulator/scenarios.ts` | 14-scenario catalog, strict id resolution |
| `…/simulator/outcome.ts` | deterministic signed notification builder |
| `…/simulator/notifier.ts` | S2S delivery to the app's own callback, bounded retry |
| `…/simulator/page.ts` | HTML rendering, escaped, no secrets |
| `…/simulator/runtime.ts` | orchestration of the two interactions |
| `lib/server/payment-simulator-runtime.ts` | generic facade (layering rules v110c/v111h) |
| `app/api/internal/payments/monetico/simulator/{page,decide}/route.ts` | thin HTTP adapters |
| `lib/server/payment-checkout-runtime.ts` | **the only modified payment file**: one guarded `submissionUrl` substitution after §17 (canonical origin), before any mutation |
| `tests/v163{a,b,c}-*.test.ts`, `tests/helpers/monetico-simulator-db.ts` | 51 tests |
| `tests/v110c-payment-p3a1-structural.test.ts` | lot allowlists extended with the two routes (enumeration tests, extended per lot as before) |

## 3. Activation gate (fail-closed, four independent conditions)

1. `PAYMENT_MONETICO_SIMULATOR_ENABLED === "true"` (exact string).
2. Non-production **positively identified**: `VERCEL_ENV ∈ {preview, development}`; `VERCEL_ENV = production` closes the gate unconditionally; any other value closes it. Only when `VERCEL_ENV` is absent (local/CI) does `NODE_ENV !== "production"` decide — `NODE_ENV` is never used while a platform value exists (Vercel preview builds run `NODE_ENV=production`, CTO Q3).
3. `PAYMENT_MONETICO_SIMULATOR_SECRET` present, ≥ 32 chars. No secret → the whole facility is off, never "on but unauthenticated".
4. Merchant persisted `payment_provider_configs.mode === "test"` (per request, re-read server-side). A `live` merchant is never routed to, served by, or decided for by the simulator.

Gate closed ⇒ `initiateCheckout` returns the real Monetico URL byte-for-byte as before, both routes answer **404 empty**, and **no RPC is called** (asserted).

## 4. Threat model

| Threat | Control | Test |
|---|---|---|
| Simulator reachable in production | cond. 2; routes 404; runtime keeps real URL | v163a #3, #6, #13 |
| Env var set by mistake in prod | cond. 2 wins over cond. 1 | v163a #1, #3 |
| Preview build misidentified as prod / prod as preview | VERCEL_ENV authoritative, NODE_ENV only as fallback | v163a #2 |
| Forge a payment for a **live** merchant | cond. 4 at runtime, page and decide; checkout of a live merchant never points at the simulator | v163a #12, v163c #16 |
| Forge a payment for a **test** merchant's order without being the operator | operator secret required (401 before any RPC); secret never read from query string | v163a #8 |
| Scenario override via query parameters | query string never read; body-only; strict catalog resolution | v163a #9, v163b #5 |
| Swap return URLs (open redirect) / re-target a decision to another reference | HMAC binding over (reference, url_ok, url_err) + same-origin requirement at both stages | v163a #5, v163c #19 |
| Tampered amount in the merchant form (even re-signed by a compromised front-end) | page compares posted amount with the **authoritative attempt amount**; decide re-reads amount/currency server-side and never uses browser values | v163c #20, outcome.ts contract |
| Cross-merchant signing (key of C for reference of A) | merchant key resolved from the reference's own restaurant; real `verifyMac` rejects | v163c #17, #18 |
| Replay / duplicate / ordering / late events | handled by the **unmodified** inbox (fingerprint dedup) and SQL terminal lock-in; simulator only exercises them | v163c #12–#14 |
| Secret leakage | key read only via existing Vault RPC, never rendered/logged; MAC never rendered; page escapes all values; structural test forbids `console.*` and provider hostnames in the simulator | v163b #11, #12 |
| Real bank call | no hostname, no endpoint import, notifier target = canonical origin + `/api/payments/monetico/callback` only | v163b #6, #12 |
| Real side effects (delivery, email, WhatsApp, settlement) | only the existing Stuart post-payment hook runs (non-live transport by construction, D1 v1.1); pinned RPC allowlist | v163c #21 |
| Bypass of the `not_required` guard | untouched; asserted with the simulator enabled | v163a #15 |
| DoS of the operator (retry storms) | bounded retry (3), cdr=1 never retried | v163b #7–#10 |

Residual risks (documented, not mitigated here): the operator secret is a shared secret (no per-operator identity/audit trail) — acceptable for a preview-only facility; a preview deployment that is publicly reachable exposes the 404-gated routes to probing (they leak nothing); the notifier's in-process transport in tests is not a network test (a staging smoke run is listed in the audit handoff).

## 5. Existing guarantees relied upon (unchanged)

P1 one-active-attempt + terminal lock-in; P3-B3 resume; P3-B4 persisted mode; P3-B5 fingerprint dedup, claim/lease, bounded retries; v4 ACK independent of Stage B; v4.3 SQLSTATE classification; canonical public origin (never a request header); return-relay tokens.
