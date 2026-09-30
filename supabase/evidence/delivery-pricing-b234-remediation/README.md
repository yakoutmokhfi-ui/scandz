# B234 — narrow remediation for independent re-audit

Baseline: `74b83a3cf21784066c3704156cadf80655598df6`. Previous failed candidate: `d5bc75c8b522fecc5a20c07ab5c188b3f31653bd`. Same branch and draft PR #122; the new SHA/tree are published in that PR and orchestration issue #18. Exact delta: `git diff d5bc75c8b522fecc5a20c07ab5c188b3f31653bd <new-SHA>`.

- **BLK-1:** forward preflight checks existing active configurations with B0 semantics before any persistent DDL. Failure details contain restaurant ID, slug, rule ID, zone and blocker. Empty active sets remain legal. No data cleanup. Mode triggers ignore pickup and metadata-only edits; delivery activation/identity changes still validate. Country identity/set changes still validate, while no-op updates do not. Multi-country union semantics are unchanged.
- **BLK-2:** read-only `preview_merchant_delivery_rule_save` checks tenant authorization and persisted rules/legacy configuration before a disabled-rule save. Native explicit confirmation distinguishes unavailable delivery (null/empty legacy zones) from legacy zone/fee behavior (France only). Cancel sends no mutation. The mutation rechecks after its tenant lock and rejects missing/stale confirmation; delivery config writes share that lock without invoking zone validation. Successful saves retain the server reread; context-generation guards precede confirmation and mutation. FR/EN/AR messages; no client resolver or invented fee.
- **BLK-3:** preflight checks every referenced application table/column/type, helper signature/result, predecessor projection and application role/write privilege. A DDL-rejecting event trigger in tests proves dependency/data errors occur before DDL, rather than merely being hidden by transaction rollback.

## Rollback

`supabase/ROLLBACK-delivery-pricing-b234.sql` removes the six B234 triggers, three new public RPCs and five private functions. A private, RLS-enabled, application-inaccessible B234 table captures the installed predecessor's exact `pg_get_functiondef`, owner, grants/grantors/grant options and comment. Rollback restores that predecessor, removes the snapshot table, and removes the private schema only if B234 created it. No CASCADE and no business-data modification. Both predecessor variants (operator authorization and translations projection) are tested, with before/after function definitions, ACLs, comments, schema inventory, unrelated triggers/functions and rule data compared.

This rollback requires the remediated forward migration's snapshot; it is not an upgrade/rollback for an already installed unremediated draft. No environment has been migrated by this work. A future authorized installation must run forward SQL before the new UI; an authorized rollback must withdraw that UI together with its RPCs.

## Verification

Targeted: **63/63 PASS**. TypeScript and `git diff --check`: PASS. Tests include missing hash/translations/config/operator/country dependencies, preexisting empty and covered zones, pickup vs delivery/country edits, exact rollback, all authorization roles, tenant rejection, B0 differential cases, tester/resolver parity, multi-country handling and immutable B1 snapshot after edit/move/disable. UI tests execute the real services and SQL and cover null/empty/nonempty legacy, cancellation, confirmation, creation/reactivation and another active rule remaining. SQL and UI tests also change persisted configuration between preview and save and require a fresh confirmation before the mutation can succeed.

Full-suite counts and exact failure identities are in `manifest.json` and `failure-delta.json`; compressed TAP logs are included. Commands and source SHA-256 hashes are recorded. These are Windows/Node 24.18.0 results, not a claim of a fresh Linux run. The previous Claude audit established the Linux baseline/candidate's same ten failures.

| Full suite | Total | PASS | FAIL |
| --- | ---: | ---: | ---: |
| Exact B1 baseline | 4217 | 4183 | 34 |
| Remediated candidate | 4249 | 4215 | 34 |

Failure identity sets: **added `[]`, removed `[]`**. There are eleven additional targeted scenarios relative to the previous candidate. All 34 exact failure identities and their file/line locations are retained in `failure-delta.json`.

## Remaining limits

- SQL runs locally in PGlite; no PostgREST/JWT or new PostgreSQL multi-session run. `unchanged-core.json` proves byte identity of four audited B0/tester function definitions; the tenant advisory lock and unique constraints remain. The mutation additionally checks confirmation under that lock. Claude's prior two-session test passed; an independent multi-session rerun remains necessary to extend that evidence to this candidate.
- Confirmation covers the resulting legacy behavior category, not an immutable configuration revision. Zero active rules remain legal after confirmation. Later authorized changes remain possible.
- Numerical fixed postal formats only, unchanged. Dormant/no-country configurations are validated when they become relevant. No historical data repair, B5, merge, Production or PREPROD action.
