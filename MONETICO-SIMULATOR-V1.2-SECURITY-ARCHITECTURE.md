# MONETICO PAYMENT SIMULATOR v1.2 — Security architecture (after re-audit v1.1: SEC-01/AUTH-03/SIDE-04 FAIL)

Baseline (audited v1.1, untouched): `b16787fc5257873c1173ce760b5c6198faefc04e` (tree `952418e5…`). Branch: `feature/monetico-simulator-v1.2-security-remediation`.

## 1. The change in one sentence

The authority that distinguishes "simulation" from "production" moves **out of the environment and into the dedicated test database**: a SQL lot applied only there creates `get_simulator_authority()`; production has no such function, so no combination of environment variables — however mutually consistent — can open the gate.

## 2. Trust model

| Question | v1.1 (FAIL) | v1.2 |
|---|---|---|
| What proves "this is the test project"? | env var `…SUPABASE_PROJECT_REF` equal to the URL ref and the JWT ref — all three set by the same operator, defeatable together | `get_simulator_authority()` **exists and answers** on the connected database. Only the test project has it (lot §1–§2). The returned `project_ref` must still match the URL ref and the service-role JWT ref/role (defense in depth), and must differ from `SCANYM_PRODUCTION_SUPABASE_PROJECT_REF` if set |
| What if the lot is applied to the wrong database? | — | The lot **refuses to apply** if any `payment_provider_configs.mode = 'live'` exists or if `app.simulator_project_ref` is not explicitly set in the session (§0). Even if forced, `get_simulator_authority()` **re-checks at every call** and raises `42501` as soon as a live merchant exists — the authority revokes itself |
| Which merchants may be simulated? | env allowlist of TPEs | `simulator_authority.allowed_tpes` (DB), per-merchant enforcement after the Vault credential read |
| Deployment identity (ENV-02) | PASS | **Unchanged**: `VERCEL_ENV` required ∈ explicit allowlist ⊂ {preview, development}; production always refused; `NODE_ENV` never read (structural test) |
| Decision replay (AUTH-03) | process-local nonce Map | `simulator_decision_tokens` row per nonce, written by `issue_…` **from the attempt row** (restaurant, order, transaction, reference, URLs; attempt must be `pending`), consumed by `consume_…` under `for update` + conditional UPDATE. One success across instances/restarts; expiry by DB clock; TTL clamped ≤ 15 min server-side |
| Delivery side effects (SIDE-04) | allocation row written (non-live transport) | lot §4 **revokes EXECUTE** on `allocate_stuart_delivery_job` and the four send/confirm RPCs for `service_role` on the test project. The unchanged hook's allocation call fails `42501`, is absorbed best-effort (D1 v1.1), payment stays applied, **zero `stuart_delivery_jobs` rows** |

Gate evaluation order (both routes, and the checkout runtime): pure env preconditions (1 enabled, 2 ENV-02, 3 secret, 6 Stuart live off) → **no RPC if closed** → `get_simulator_authority()` → tenant verdict → per-merchant mode `test` + TPE ∈ DB allowlist.

## 3. Downstream trace of a simulated `paid` (what can execute)

| Effect | Mechanism | v1.2 status on the test project |
|---|---|---|
| `payment_transactions.status = paid`, `orders.payment_status = paid`, inbox `applied` | unchanged pipeline | **permitted** (synthetic data; this is the purpose) |
| `simulator_decision_tokens` row consumed | lot §3 | **permitted** (synthetic) |
| Stuart eligibility read | unchanged hook | permitted (read-only) |
| Stuart allocation / send_started / ambiguous / confirmed / terminal rows | unchanged hook → RPC | **impossible** (EXECUTE revoked, 42501) |
| Stuart HTTP (auth/create-job/pricing) | `create-job.ts` reachable only via `sandbox-trigger` route (own secret) or the merchant runtime adapter (not wired to the hook) | none; hook transport is structurally non-live |
| Notification outbox / email / WhatsApp | written at order creation, not at payment; no trigger on `paid` | none |
| Scheduling engine (CSDJ) RPCs | none reads `payment_status` | none |
| Background workers | only `/api/internal/payments/monetico/recover` (cron) — payment inbox only; Stuart reaper not scheduled | recover may finalize a simulated event (synthetic) |
| Cross-tenant / production writes | authority absent on production → gate closed; tokens/attempts bound to the merchant found by correlation | none |

Writes intentionally permitted on the test database: payment attempt/event rows for synthetic merchants, decision-token rows. Nothing else.

## 4. Threat → control → proof

| Threat | Control | Proof |
|---|---|---|
| Consistent env pointing at production | no authority function on production | v165 A/SEC-01(a) (red on v1.1), v163a cond.4, ROUTES production-project 404 |
| Lot mistakenly applied on a real DB | §0 refusal; §2 self-revocation on live merchant | v165 B (real PG), A/SEC-01(b) (red on v1.1), v163c ISOLATION live merchant |
| Real merchant simulated | DB TPE allowlist | v165 A/SEC-01(c) (red on v1.1), v163a cond.5 |
| Replay across instances / restart | DB atomic consume | v165 C multi-process (4 procs × 3 in-flight → 1 success; new process refused), A/AUTH-03 (red on v1.1), B token proofs |
| Decision re-targeted to another attempt/merchant/URL | binding from attempt row; 23514 on mismatch; transaction/restaurant/order re-checked at decision | v165 B, v163c FORGERY ×2 |
| Delivery job created from a simulated payment | §4 revocation | v165 A/SIDE-04, B (privileges, rollback), v163c SIDE-04 delivery ×2 (zero rows, zero external HTTP) |
| Live Stuart activation in the same env | precondition 6 | v163a cond.6, v163c SIDE-04 + live flag |
| Production deployment / unknown env / missing metadata | ENV-02 unchanged | v165 D, v163a cond.2 (13 cases), v164 ENV-02 |

## 5. Remaining risks and limitations (honest)

* **Shared `scanym-simulator` MAC-covered marker is informational only.** A MAC-valid callback is, by definition, a real callback to the production route. If the real merchant key were ever placed in the test project, a simulated callback replayed against production would be accepted — exactly Cat Turing's v1 observation. The control is organizational + the DB allowlist (synthetic TPEs only). A production-side hardening (refuse any callback carrying `scanym-simulator`) would touch `payment-callback-runtime.ts` and is **escalated, not implemented** (§6).
* **The JWT `ref` check binds identity, it does not verify the key's signature.** The key is only ever used by the existing client against the URL it must match.
* **PGlite concurrency** is single-connection: the multi-process proof demonstrates one success across 12 racing calls from 4 processes through the real SQL function and the real TS path, with the database serializing them; it is not a 12-connection PostgreSQL test. The SQL (`for update` + conditional UPDATE on a PK row) is the standard PostgreSQL idiom whose atomicity does not depend on the client.
* **Nonce table growth**: no purge job; `expires_at` is indexed, a periodic `delete … where expires_at < now() - interval '1 day'` is left to the test-project operator.
* **No preview activation / no real HTTP smoke** in this session (prohibited). The runbook in the handoff lists it for the auditor.

## 6. Escalations (require a separately reviewed contract — not done here)

1. Production callback route: refuse callbacks carrying the `scanym-simulator` field unless `get_simulator_authority()` is active (touches `payment-callback-runtime.ts`).
2. Payment event processor: skip the Stuart hook for provider events whose code carries the simulator marker (touches `payment-provider-event-processor.ts`) — made unnecessary on the test project by §4, listed for completeness.
