# MONETICO PAYMENT SIMULATOR v1.1 — Security remediation handoff (for Cat Turing's targeted re-audit)

Audited v1 candidate (preserved, untouched): commit `8425e015648a90c9f8da0fe09b2c0f15613d0f74`, tree `82f604421261626a3e445ae6c3fa2895a17be4f1`, branch `feature/monetico-simulator-v1`.
Remediation branch: `feature/monetico-simulator-v1.1-security-remediation` (from 8425e015). Candidate SHA/tree, bundle and manifest: `MONETICO-SIMULATOR-V1.1-CANDIDATE.txt` (delivered alongside, not committed).

Unchanged by this lot: the payment state machine (SQL), `payment-checkout-runtime.ts` (its single guarded substitution is identical to v1), the callback route and Stage A/B, the inbox, the recovery worker, the Stuart hook and orchestration, the CSDJ scheduling engine, the back-office. **No production SQL, no live payment, no real Stuart request, no merge, no deployment.**

## 1. Findings → changes → evidence

| Finding | Change (file) | Evidence (test · name) |
|---|---|---|
| **MSIM-SEC-01** (HIGH) provable simulation/production boundary | `policy.ts` cond. 4 **tenant boundary**: `PAYMENT_MONETICO_SIMULATOR_SUPABASE_PROJECT_REF` (authorized dedicated test project) must equal the ref of `NEXT_PUBLIC_SUPABASE_URL` **and** the `ref` claim of `SUPABASE_SERVICE_ROLE_KEY` (role must be `service_role`), and must differ from `SCANYM_PRODUCTION_SUPABASE_PROJECT_REF` when set. No fallback: the simulator never builds a client; any absent/inconsistent element closes the gate (and the routes return 404, no RPC). Cond. 5 **synthetic credentials**: the merchant credential's TPE must be on `PAYMENT_MONETICO_SIMULATOR_ALLOWED_TPES`; enforced per merchant in `runtime.ts` after the credential read, before any page/decision. | v163a · GATE cond.4 (13 negative cases), GATE cond.5, ROUTES tenant-boundary 404, RUNTIME ×2 (other project / other key → real URL); v163c · SEC-01 real-looking TPE → 404; v164 · SEC-01 (a)(b)(c) |
| **MSIM-ENV-02** explicit environment allowlist | `policy.ts` cond. 2: `VERCEL_ENV` **required**; must be in `PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS`; that list may only contain `preview`/`development` (anything else invalidates the whole list); `production` refused even if listed; `NODE_ENV` **never consulted** (the v1 local fallback is removed — local runs set `VERCEL_ENV=development` explicitly). | v163a · GATE cond.2 (13 cases incl. missing metadata, unknown, malformed list, NODE_ENV ignored); RUNTIME metadata-missing → real URL; v164 · ENV-02 (a)(b)(c) |
| **MSIM-AUTH-03** replay-resistant decisions | `session.ts`: **single-use decision token** = HMAC-SHA256(operator secret) over {reference, transactionId, url_ok, url_err, 128-bit nonce, iat, exp(10 min)}; `consumeDecisionToken` verifies signature/TTL/binding then marks the nonce used (bounded in-process registry). `runtime.ts`: the page issues a token only for a `pending` attempt; a decision must present an unconsumed token bound to the same reference/URLs **and** the same `transactionId`, and the attempt must still be `pending` (`attempt_not_pending` otherwise). Callback idempotency (P3-B5 fingerprint) is untouched and separately demonstrated. | v163a · TOKEN (single-use, binding, expiry, signature, payload tamper); v163c · AUTH-03 replay (second POST → `token_already_used`, zero notification; terminal attempt → no token; raw callback replay still deduplicated), delayed_confirmation (re-issue path); v164 · AUTH-03 |
| **MSIM-SIDE-04** no real fulfillment | `policy.ts` cond. 6: `STUART_LIVE_ACTIVATION_ENABLED=true` closes the gate (page 404, decision `gate_closed`) — simulated payments cannot coexist with a live delivery activation. Tenant boundary (SEC-01) guarantees any allocation row is in the isolated test project. The production pipeline is **not** modified: for a delivery order the unchanged hook allocates a job row in the test DB with the structurally non-live transport (D1 v1.1) and ends `send_ambiguous`, no Stuart job id, zero external HTTP. | v163a · GATE cond.6, RUNTIME Stuart-live → real URL; v163c · SIDE-04 delivery (global `fetch` guard: 0 external calls; RPC sequence pinned; no `confirm_stuart_delivery_job_created`, no scheduling RPC), SIDE-04 delivery + live flag (refused before notification, 0 allocations), SIDE EFFECTS pickup; v164 · SIDE-04 |

Design note on SIDE-04: the only way to suppress the allocation row itself would be to make the production processor behave differently for simulated events (e.g. reading the MAC-covered `scanym-simulator` field) — rejected per mandate ("do not weaken the production pipeline"). The row is synthetic by construction (SEC-01), never sent anywhere (non-live transport), and cannot coexist with live activation (cond. 6).

## 2. Reproduction of the auditor counterexamples (before/after)

`tests/v164-monetico-simulator-v1-1-remediation.test.ts` encodes the four counterexamples using only APIs present in both trees. Run unmodified against the audited v1 candidate (worktree at 8425e015, production code untouched, only the test scaffolding `tests/helpers/monetico-simulator-{env,db}.ts` copied in):

```
node --experimental-strip-types --import ./tests/register.mjs --test tests/v164-monetico-simulator-v1-1-remediation.test.ts
  on 8425e015 (v1) : 8 counterexample tests → 7 FAIL, 1 pass   (reproduced; log: v164-on-v1.log)
      not ok SEC-01 (a)  gate open for an unauthorized project
      not ok SEC-01 (b)  production key + test URL accepted
      not ok SEC-01 (c)  real-looking TPE served
      not ok ENV-02 (a)  NODE_ENV fallback with platform metadata missing
      not ok ENV-02 (b)  no explicit allowlist required
      ok     ENV-02 (c)  unknown/production already refused in v1 (kept as negative regression)
      not ok AUTH-03     replayed decision accepted, second notification emitted
      not ok SIDE-04     Stuart live flag ignored; job row allocated
  on v1.1           : 8/8 pass
```
(The glob `tests/v164-*` also matches two pre-existing unrelated files — 19 further tests, all passing on both trees.)

## 3. Commands and exact results (v1.1 candidate)

```
npx tsc --noEmit -p tsconfig.json                                  → exit 0
tests/v163a-*  security gate            → 24/24
tests/v163b-*  adapter + structural     → 15/15
tests/v163c-*  scenarios e2e            → 25/25   (v1: 21; +SEC-01 TPE, +SIDE-04 delivery ×2, +AUTH-03 replay)
tests/v164-monetico-simulator-v1-1-*    →  8/8
   simulator total                        72 (v1 had 51; 24+15+25+8)
npm test (full)                         → # tests 5536  # pass 5521  # fail 15
npm test on main 03441a5 (reference)    → # tests 5464  # pass 5449  # fail 15
```
The 15 failures are the same 15 as on `main` (set difference = ∅): stale structural enumerations (`v110c` ×2, `v111h`), OB-1 non-modification proofs (×5), wording/render assertions of other streams (×6), `cfte-v1-customer-name-and-email` load failure. None touches the simulator. **No new failure.**

Independent fresh-clone verification: see `MONETICO-SIMULATOR-V1.1-CANDIDATE.txt` (clone of the pushed branch into a new directory, `npm ci`, `tsc`, simulator suites, full suite — recorded there).

## 4. Configuration contract (preview/development only)

| Variable | Requirement |
|---|---|
| `PAYMENT_MONETICO_SIMULATOR_ENABLED` | exact `true` |
| `PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS` | subset of `preview,development` |
| `VERCEL_ENV` | set by the platform; must be in the list; never `production` |
| `PAYMENT_MONETICO_SIMULATOR_SECRET` | ≥ 32 random chars; shared with nothing else |
| `PAYMENT_MONETICO_SIMULATOR_SUPABASE_PROJECT_REF` | ref of the **dedicated test project** |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | must belong to that same project (URL host ref = JWT `ref`, role `service_role`) |
| `SCANYM_PRODUCTION_SUPABASE_PROJECT_REF` | recommended: production ref, so a mistaken equality is refused |
| `PAYMENT_MONETICO_SIMULATOR_ALLOWED_TPES` | synthetic TPEs only |
| `STUART_LIVE_ACTIVATION_ENABLED` | must not be `true` |

Residual limits (unchanged posture, documented): the nonce registry is per server instance — cross-instance replay is bounded by the 10-minute TTL and refused once the attempt leaves `pending`; the JWT `ref` check binds identity, it does not verify the key's signature (the key is only ever used by the existing client against the matching URL).

## 5. Open items carried over (unchanged)
`required` order state, `verified` operator RPC, customer "Pay" step — separate lots (see `MONETICO-SIMULATOR-V1-REQUIRED-STATE-SPEC.md`). Staging smoke over real HTTP remains for the auditor.
