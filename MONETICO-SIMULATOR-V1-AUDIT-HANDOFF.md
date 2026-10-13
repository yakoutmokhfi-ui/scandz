# MONETICO PAYMENT SIMULATOR v1 — Audit handoff (for Cat Greco)

Candidate branch: `feature/monetico-simulator-v1` · baseline: `main` = `03441a5ef1d371e90e3bfe3438e1a29e211d0537`.
Candidate SHA, tree hash, bundle and SHA-256 manifest: see `MONETICO-SIMULATOR-V1-CANDIDATE.txt` (generated after the last commit; delivered alongside this file, not committed).

Companion documents (committed on the branch):
* `MONETICO-SIMULATOR-V1-PHASE0-REPORT.md` — investigation and verified findings.
* `MONETICO-SIMULATOR-V1-ARCHITECTURE-THREAT-MODEL.md` — architecture, gate, threat → control → test matrix.
* `MONETICO-SIMULATOR-V1-REQUIRED-STATE-SPEC.md` — the separate `required`-state lot (not implemented) and the tests that depend on it.

## 1. Scope actually delivered (CTO Q4)

| Mandate item | Delivered |
|---|---|
| 1. Isolated simulator provider adapter | `lib/server/payment-providers/monetico/simulator/` (9 files) + generic facade `lib/server/payment-simulator-runtime.ts` |
| 2. Simulated hosted-payment interaction | `POST /api/internal/payments/monetico/simulator/page` (TPE-like verification, HTML page) |
| 3. Deterministic payment scenarios | 14 scenarios, `scenarios.ts`/`outcome.ts` |
| 4. Protected internal test/demo interface | the hosted page (operator secret for decisions) + `GET …/simulator/page` catalog (Bearer) + JSON mode of `…/decide` for automated drivers |
| 5. Tests exercising callback/inbox/confirmation | `v163c` runs the real callback route, Stage A/B, recovery worker against an in-memory RPC model mirroring the SQL |
| Not done, by decision | customer "Pay" button; `required` state; `verified` operator RPC; any SQL; any production/staging deployment |

Constraints honoured: no existing SQL function modified; no SQL file added; no CSDJ/scheduling file touched; no back-office file touched; no secret committed (all test secrets are synthetic, suffixed `DO-NOT-USE`); no real order can be marked paid by the simulator (gate + live-mode exclusion + operator secret); no merge into main.

Diff footprint: `git diff --stat 03441a5..<candidate>` — **1 existing payment file modified** (`lib/server/payment-checkout-runtime.ts`: +18 lines, one import + one guarded assignment), **1 existing test allowlist extended** (`tests/v110c-payment-p3a1-structural.test.ts`: two route paths added to two enumerations), everything else new.

## 2. Acceptance criteria (CTO Q5) → evidence

| Criterion | Test (file · name) | Result |
|---|---|---|
| Successful simulated payment | v163c · E2E paid | PASS |
| Refused payment | v163c · E2E refused | PASS |
| Pending and abandoned payment | v163c · pending_partner, abandoned | PASS |
| Delayed confirmation | v163c · delayed_confirmation (redirect-before-S2S), delayed via RECOVERY WORKER | PASS |
| Duplicate callback and replay | v163c · duplicate_paid | PASS |
| Invalid MAC rejection | v163c · bad_mac; v163b · OUTCOME bad_mac | PASS |
| Amount/currency mismatch | v163c · amount_tamper, currency_tamper; FORGERY amount re-signed | PASS |
| Mode mismatch | v163c · mode_mismatch | PASS |
| Callback ordering | v163c · refused_then_paid, paid_then_refused | PASS |
| Provider timeout and retry | v163c · provider_timeout_retry; v163b · NOTIFIER ×4 | PASS |
| Cross-merchant isolation | v163c · ISOLATION ×3 | PASS |
| Unauthorized scenario rejection | v163a · ROUTES #8, #9; v163c · FORGERY binding | PASS |
| Production-environment rejection | v163a · GATE #1–#3, ROUTES #6, RUNTIME #13 | PASS |
| Prevention of real external side effects | v163b · STRUCTURAL no hostname/endpoint; v163c · SIDE EFFECTS RPC allowlist | PASS |
| Preservation of existing payment regressions | full suite, see §3 | PASS (no new failure) |
| Real checkout E2E | **NOT CLAIMED** — requires the `required` state (spec §6) | — |

## 3. Commands and exact results

Environment: Node v22.22.0, `npm ci` from `package-lock.json` (no dependency change).

```
npx tsc --noEmit -p tsconfig.json            → exit 0
node --experimental-strip-types --import ./tests/register.mjs --test tests/v163a-*.test.ts tests/v163b-*.test.ts tests/v163c-*.test.ts
                                              → # tests 51  # pass 51  # fail 0   (15 + 15 + 21)
npm test   (candidate, run 1)                 → # tests 5515 # pass 5499 # fail 16
npm test   (candidate, run 2)                 → # tests 5515 # pass 5500 # fail 15
npm test   (main 03441a5, same node_modules)  → # tests 5464 # pass 5449 # fail 15
```

Delta candidate − main = **+51 tests, +0 failures** (5515 − 5464 = 51 = the three new files).

The 15 failures are **identical on `main` and on the candidate** (same test names, run 2 diff = ∅):

| File | Tests | Nature (pre-existing on main) |
|---|---|---|
| `tests/ob1-non-modification-proof.test.ts` | 5 | "git diff since published baseline" proofs of an older lot — they fail on any branch ahead of that baseline |
| `tests/v110c-payment-p3a1-structural.test.ts` | 2 (#217 app→lib/server allowlist, #363 SQL file count) | stale enumerations (count 181 ≠ expected); the allowlist one fails on main for a Stuart file |
| `tests/v111h-payment-p3a2-structural.test.ts` | 1 (#221 SQL file count) | stale count |
| `tests/storefront-order-help-wording-*` ×2, `tests/delivery-public-text-v1.dom.test.ts`, `tests/theme-content-settings-v1.dom.test.ts`, `tests/v149-operator-dashboard-context-v1.dom.test.ts` | 5 | wording/rendering assertions of other streams |
| `tests/cfte-v1-customer-name-and-email.test.ts` | 1 | fails at load on main |
| `tests/…` (BL-1 fingerprint) | 1 | render fingerprint of main |

Run 1 had one additional failure, `tests/gap-01-withdrawal-requests-backoffice.dom.test.ts` ("écran backoffice : affiche référence…"), absent in run 2 and 3/3 green when run alone — a timing flake in an unrelated DOM test, not caused by this branch (the branch touches no back-office file).

Three structural tests that failed on the first candidate run were fixed by **respecting** the existing rules, not by weakening them: the orchestration was moved under `payment-providers/monetico/simulator/` (rule: no provider signature outside the adapter), a generic facade was added (rule: `app/` imports only `lib/server/payment-*`), and the two new routes were appended to the per-lot route enumerations in `v110c` — the same way every previous lot extended them.

## 4. How to drive it on a preview deployment (runbook)

Preconditions (preview only): `PAYMENT_MONETICO_SIMULATOR_ENABLED=true`, `PAYMENT_MONETICO_SIMULATOR_SECRET=<≥32 random chars, not shared with anything>`, `VERCEL_ENV=preview` (set by the platform), `PAYMENT_CHECKOUT_RUNTIME_ENABLED=true`, `SCANYM_PUBLIC_ORIGIN=<preview origin>`, relay keys; a **test-only** merchant whose `payment_provider_configs` row is `mode='test'`, `is_enabled`, `configuration_status='verified'` with a **synthetic** credential in Vault (no `verified` writer exists — set by hand on the preview DB only, never on production; see spec §7). An order of that merchant in `failed`/`cancelled` state (or `required` once that lot ships).

1. `POST /api/payments/monetico/checkout {orderId, publicToken, language}` → `submissionUrl` ends with `/api/internal/payments/monetico/simulator/page`.
2. Auto-post `fields` to it (as the storefront would) → simulator page shows the verified request.
3. Choose a scenario, enter the operator secret → redirected to the merchant return page; `orders.payment_status` reflects the application's own processing.
   Automated: `POST …/simulator/decide` with `Authorization: Bearer <secret>`, `accept: application/json`, body `{scenario, reference, url_retour_ok, url_retour_err, binding}` (binding is in the page HTML) → JSON report of the notifications.
4. `GET …/simulator/page` with the Bearer → scenario catalog.

Staging smoke to perform by the auditor (not possible from this session): one `paid` and one `bad_mac` round-trip over real HTTP on a preview deployment, confirming 303 redirects and the inbox rows.

## 5. Open items / explicitly not covered

* `required` state and customer "Pay" step — separate lots (spec).
* `verified` operator RPC — separate lot (spec §7).
* The `v110c`/`v111h` SQL-count assertions are stale on `main` and will need rebasing by whichever lot next touches `supabase/`.
* No PR opened, no merge, no deployment, no payment activation (mandate §2).
