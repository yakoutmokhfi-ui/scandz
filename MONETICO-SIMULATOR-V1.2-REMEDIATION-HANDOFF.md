# MONETICO PAYMENT SIMULATOR v1.2 — Remediation handoff for Cat Turing (targeted re-audit)

Audited baseline (untouched): **v1.1 `b16787fc5257873c1173ce760b5c6198faefc04e`**, tree `952418e54499fe8b01cd504a4abe7079d0e13173`. (v1 `8425e015…` also untouched.)
Remediation branch: `feature/monetico-simulator-v1.2-security-remediation` (from b16787fc). Candidate SHA/tree, bundle, manifest and exact run logs: `MONETICO-SIMULATOR-V1.2-CANDIDATE.txt` (delivered alongside).
Architecture, trust model, downstream trace, residual risks, escalations: `MONETICO-SIMULATOR-V1.2-SECURITY-ARCHITECTURE.md`.

Report provenance: your v1.1 re-audit was received truncated after §1 (no scripts). I worked from the documented mechanisms (SEC-01 "exclusion contournable par configuration concordante"; AUTH-03 "même jeton accepté entre processus et après redémarrage"; SIDE-04 "écritures de livraison encore accessibles"; régressions "INCONCLUSIVE, 89/89 sous Windows"). **The reproductions below are mine, not your scripts**; §2 says exactly what each one shows.

## 1. Findings → remediation (minimal diff)

| Finding | v1.1 defect | v1.2 mechanism | Files |
|---|---|---|---|
| **SEC-01** FAIL | three *configurable* references; consistent misconfiguration opens the gate | trusted authority = `get_simulator_authority()` **in the test database only** (SQL lot, test-project-only, refuses to apply with a live merchant / without explicit ref, self-revokes at read when a live merchant exists); env refs removed; TPE allowlist from DB; URL ref + JWT ref/role must match the DB ref; optional production-ref deny kept | `supabase/DRAFT-lot-monetico-simulator-test-authority-v1.sql` (+rollback), `simulator/authority.ts` (new), `simulator/gate.ts` (new), `simulator/policy.ts`, `simulator/runtime.ts`, routes, `payment-checkout-runtime.ts` (import + 1 awaited call, same guard) |
| **AUTH-03** FAIL | process-local nonce `Map` | `simulator_decision_tokens` table; `issue_…` writes binding from the attempt row (restaurant/order/transaction/reference/URLs, attempt must be pending); `consume_…` = `for update` + conditional UPDATE → exactly one success across processes and restarts; DB-clock expiry; TTL clamped ≤ 15 min; P3-B5 idempotency untouched | same SQL lot, `simulator/session.ts` (rewritten, 90 lines), `simulator/runtime.ts` |
| **SIDE-04** FAIL | allocation row written by the (unchanged) hook | lot §4 revokes EXECUTE on `allocate_stuart_delivery_job` + 4 send/confirm RPCs for `service_role` **on the test project**; the unchanged hook gets 42501, absorbs it (best-effort), payment applied, **zero delivery rows**; precondition 6 (Stuart live flag) kept | SQL lot only — **no production TS touched** |
| **ENV-02** PASS | — | **unchanged** (allowlist mandatory, production refused, metadata required, `NODE_ENV` never read — structural assertion added) | — |

Production pipeline untouched: `payment-callback-runtime.ts`, `payment-provider-event-processor.ts`, `payment-service.ts`, all payment SQL, Stuart hook/orchestration, CSDJ, back-office. Two hardenings that *would* touch the pipeline are escalated in the architecture doc §6, not implemented.

## 2. Red-before / green-after (my reproductions)

`tests/v165-monetico-simulator-v1-2-remediation.test.ts` + helpers, copied unmodified into a worktree at **b16787fc** (0 production files modified there; the SQL draft copied so Part B can run):

| Test | on v1.1 b16787fc | on v1.2 | What it reproduces |
|---|---|---|---|
| A/SEC-01 (a) consistent variables → production project | **FAIL** (simulator URL returned) | pass | your SEC-01 |
| A/SEC-01 (b) live merchant in DB, env says test | **FAIL** | pass | SEC-01 (env trusted over data) |
| A/SEC-01 (c) TPE allowlist from env vs DB | **FAIL** | pass | SEC-01 (synthetic restriction defeatable by env) |
| A/AUTH-03 replay from a client with no memory | **FAIL** | pass | your AUTH-03 (restart) |
| C/AUTH-03 multi-process race (4 procs × 3 in-flight, +1 after) | **FAIL** (v1.1 has no DB token path) | pass: **1 success / 11 `token_already_used` / late process refused** | your AUTH-03 (multi-instance) |
| A/SIDE-04 delivery order → zero job rows | passes on v1.1 *only because* the copied v1.2 model already encodes the revoked RPC — **not a fair red**. The honest red is v1.1's own `v163c` "SIDE-04 delivery order" test, which **asserts `jobs.length === 1`** (log `v163c-on-v11-side04.log`, line "ok 23 … allocates ONLY a synthetic job row"): the write you flagged was there by design in v1.1 | pass (zero rows) | your SIDE-04 |
| B/SQL ×4 (real PostgreSQL via PGlite) | pass (SQL-only) | pass | application guards, self-revocation, atomic consume, expiry, binding, Stuart revoke + rollback |
| D/ENV-02 | n/a on v1.1 (API shape) | pass | ENV-02 preserved |

Logs: `v165-on-v11.log` (5 pass / 6 fail), `v163c-on-v11-side04.log`.

## 3. Commands and exact results (v1.2 candidate, Node v22.22.0, `npm ci`)

```
npx tsc --noEmit -p tsconfig.json                                → exit 0
tests/v163a-*  gate (DB-anchored)                                → 29/29
tests/v163b-*  adapter + structural (SQL-lot assertions updated) → 15/15
tests/v163c-*  scenarios e2e (+SEC-01 TPE, SIDE-04 delivery ×2, AUTH-03 replay) → 25/25
tests/v164-monetico-*  v1.1 counterexamples (kept)               →  8/8
tests/v165-monetico-*  v1.2 proofs (A/B/C/D)                     → 11/11   (file glob also runs 14 unrelated pre-existing tests: all pass)
   simulator total                                                 88
```
Full-suite comparison **by exact failure identity** (not by count): `scripts/simulator-audit/compare-test-failures.mjs <main-checkout> <v1.2-checkout>` — runs `npm test` in both, parses TAP, keys each failure by `tests/<file>:<line> :: <name>`, prints `onlyInCandidate` (must be ∅). Result on this machine: see `MONETICO-SIMULATOR-V1.2-CANDIDATE.txt` (JSON report `compare-main-vs-v12.json` delivered). This is the answer to "INCONCLUSIVE": on *your* Windows machine run the same script against `main 03441a5` and the candidate — the expected outcome is `onlyInCandidate = []` whatever the absolute count (89 there, 15 here) is.

## 4. Operator runbook for the dedicated test project (not executed here — no hosted SQL, no preview activation)

1. On the **dedicated test project** (never production), in one SQL session: `set app.simulator_project_ref = '<that project's ref>';` then run `DRAFT-lot-monetico-simulator-test-authority-v1.sql`. It aborts if a `live` provider config exists or the ref is not set. Rollback: `…-rollback.sql`.
2. Adjust `simulator_authority.allowed_tpes` to the synthetic TPEs you seed (default `{1234567,7654321}`).
3. Preview env: `PAYMENT_MONETICO_SIMULATOR_ENABLED=true`, `PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS=preview`, `PAYMENT_MONETICO_SIMULATOR_SECRET=<≥32>`, `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` of **that** project, optionally `SCANYM_PRODUCTION_SUPABASE_PROJECT_REF=<prod ref>`, `STUART_LIVE_ACTIVATION_ENABLED` unset. The two v1.1 variables `…_SUPABASE_PROJECT_REF` / `…_ALLOWED_TPES` are ignored and should be deleted.
4. Smoke (yours): `paid`, `bad_mac`, then replay the same decide POST → 400 `token_already_used`; a delivery-mode synthetic order → `stuart_delivery_jobs` stays empty.

## 5. What is deliberately NOT claimed
Real checkout E2E (needs the `required` state); 12-connection PostgreSQL concurrency (PGlite is single-connection — the proof is 12 racing calls from 4 processes serialized by one real PostgreSQL executing the real function); preview smoke over HTTP.
