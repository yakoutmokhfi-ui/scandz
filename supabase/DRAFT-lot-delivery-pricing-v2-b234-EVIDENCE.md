# B234 — boundary and governance remediation

Authority: [Ravel / CIO decision, issue #18 comment 5924445175](https://github.com/yakoutmokhfi-ui/scanym-orchestrator/issues/18#issuecomment-5924445175). Previous candidate: `85ba126d86515c8e6fd9041be29f444c76b1848b`. PR #122 remains draft. No business-logic redesign, B5, Production/PREPROD or merge.

## Authorization boundary (B-D-1 / B-D-2)

Staff may read `provider` and `fulfillment_code` in Delivery Pricing and postcode testing: these are operational routing facts. This is explicitly CIO-approved; staff mutation remains forbidden. Owner/manager or Scanym operator retain mutation authorization and tenant checks.

Rule input/select/textarea controls remain gated by `canEdit`. Postcode, country, quantity and subtotal inputs in `DeliveryPostcodeTester` are intentionally editable by read-authorized staff: they are simulation parameters, not configuration mutation controls. A named DOM test proves this distinction, displays provider/rule code, executes only the tester and observes no mutation call. SQL tests separately prove staff reads these fields through the real read/test RPCs and cannot mutate rules.

Both forward preflight (before DDL) and postflight reject table **or column-only** INSERT/UPDATE grants to application roles. `has_any_column_privilege` covers every column, including future additions. Tests also explicitly check `has_column_privilege` and attempt direct UPDATE of `zone_prefixes`, `provider`, `is_fallback`, `display_order`, `fulfillment_code`, `enabled`, `pricing_mode`, `fixed_fee`, `free_threshold`, `customer_text` and `min_items` as owner/staff users under authenticated/anon. Negative fixtures grant UPDATE on each column separately: the table-only privilege check stays false, while preflight and postflight both reject the grant. An event trigger proves the preflight rejection occurs before attempted DDL.

## Manual release inventory (B-D-3)

| Item | Current artifact / decision |
| --- | --- |
| Forward SQL | `supabase/DRAFT-lot-delivery-pricing-v2-b234.sql` |
| Paired rollback | `supabase/DRAFT-lot-delivery-pricing-v2-b234-ROLLBACK.sql` |
| Release convention | Existing manually reviewed root `DRAFT-lot` convention; forward SQL before UI on a future authorized release, rollback with withdrawal of the corresponding UI. |
| Migration ledger | Not adopted here. No B234 forward SQL remains in `supabase/migrations/`; no CLI/config behavior added. |
| New B234 dev/test dependency | `@electric-sql/pglite`, pinned **0.5.8** in `package.json` and lockfile, explicitly CIO-approved. Used solely by local tests to execute PostgreSQL, predecessor SQL, B234 and rollback without a remote database. Not a production dependency or deployment convention. |

The rollback still restores the exact captured predecessor function, owner, ACL/grantors and comment and changes no business data. All nine installed function definitions remain byte-identical to the previous candidate; only the outer pre/postflight privilege checks and artifact paths change. Historical evidence directories describe their pinned historical SHAs and retain their old paths for provenance.

## Verification and remaining limits

Targeted suite: **66/66 PASS**. TypeScript with incremental cache disabled and `git diff --check`: PASS.

Current commands, source hashes, exact failure identity comparison and compressed TAP logs are recorded under `supabase/evidence/delivery-pricing-b234-boundaries/`. Re-audit scope: B-D-1/2/3 and confirmation of original BLK-1/2/3 closure against comments 5918006069 and 5918057074. The declared limitation about immutable configuration revision tokens is accepted as non-blocking by Ravel; no new revision-token model is introduced.

Local Windows/Node 24/PGlite evidence does not substitute for PostgreSQL multi-session or PostgREST/JWT execution. No claim of a new Linux execution. Original B0, authorization, tenant, multi-country, B1 and legacy confirmation regression cases are retained.
