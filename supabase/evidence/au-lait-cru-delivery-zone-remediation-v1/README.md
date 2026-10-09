# AU LAIT CRU DELIVERY ZONE REMEDIATION v1

Dirac — implementation preparation for CIO review only. Base main: `7bbb70b9f6f7f522b1b452a60b2092a69699ba95`.
Observed Production project: `ctqfpszwunfomrbxgigu`; tenant `e8647a29-4971-4629-a5e8-1f00650adfb4` (`au-lait-cru`).
First evidence: 2026-10-08T17:18:34.956782+00:00. Final read: 2026-10-08 17:30:44.405401+00.
**No Production mutation, no merge, no deployment.** This Git object is a review artifact, not attached to a branch/PR.

## Root cause and scope

Data/configuration only. Production's complete resolver SQL body equals the B5 resolver source at the supplied main SHA, byte-for-byte after CRLF normalization. It matches non-fallback postal prefixes first, ordered by display_order, and selects fallback only when no local rule matches. The five expected postal codes are absent from local prefixes, so Chronofresh 18.90 is the correct result for the incorrect configuration. No resolver or application code change is required. B0 checks syntax/overlap, not the business meaning of numeric commune identifiers.

Only two rows are updated, tenant-scoped by UUID:

| Row UUID | Preserved fee | Change |
| --- | --- | --- |
| 1d222236-2958-4ada-a5e5-7ce52a52b438 | 10.90 | zone token 93008 → 93000 |
| 6434ba6a-707f-41ff-8995-1476dc3c8f10 | 15.90 | 92051 → 92200; 92009 → 92270; 92004 → 92600; 93045 → 93260; provider internal → stuart |

The replacements retain array positions. Existing Paris prefixes, Saint-Ouen, Pantin, Bagnolet and every other unaffected token stay present. The provider belongs to the ENTIRE 15.90 rule: its eight already-correct tokens (75005,75006,75007,75011,75012,75015,93500,93170) also move from internal to Stuart, as required by the instruction to correct that rule's provider. Their fees do not change. No unrelated rule changes.

## Exact before / proposed after

Below, subtotal=50, quantity=1, delivery enabled (fees in EUR):

| Postcode | Production BEFORE | Proposed AFTER |
| --- | --- | --- |
| 93000 Bobigny | chronofresh 18.90 | stuart 10.90 |
| 92600 Asnières-sur-Seine | chronofresh 18.90 | stuart 15.90 |
| 92270 Bois-Colombes | chronofresh 18.90 | stuart 15.90 |
| 92200 Neuilly-sur-Seine | chronofresh 18.90 | stuart 15.90 |
| 93260 Les Lilas | chronofresh 18.90 | stuart 15.90 |
| 75018 | stuart 6.90 | stuart 6.90 |
| 69001 fallback | chronofresh 18.90 | chronofresh 18.90 |

All six active rules retain discount_enabled=true, threshold=100, percentage=50. At 100 or 100.01 the corresponding effective fees remain 5.45 / 7.95 / 3.45 / 9.45, not the undiscounted base tariffs. The disabled legacy row and its null discount parameters are preserved too.

Complete seven-row BEFORE and proposed AFTER are in before.json / after-proposed.json, including all prices, discounts, notices, translations, order, flags and disabled configuration. PostgreSQL MD5 of ordered full-row JSON: BEFORE `4f055edce98ab555e342969fc486d43a`, proposed AFTER `541b7e5773748b930f0edbe3224f2fc7`. These are drift checks, not cryptographic signatures. Git blob/tree/commit identities provide artifact integrity.

## Proposed patch and rollback

- Forward: ../../DRAFT-lot-au-lait-cru-delivery-zone-remediation-v1.sql (two UPDATEs).
- Rollback: ../../DRAFT-lot-au-lait-cru-delivery-zone-remediation-v1-ROLLBACK.sql (inverse two UPDATEs).

Both are explicit transactions, using B234's tenant advisory lock and row locks, bounded wait/execution time, exact tenant/active mode/country checks, resolver-definition fingerprint and complete seven-row state fingerprints. The forward accepts only the observed BEFORE state; the rollback accepts only the exact proposed AFTER. Both refuse stale/replayed/mixed states rather than overwriting concurrent edits. Both run the existing B234/B0 guard without disabling triggers or constraints. Forward additionally asserts all 28 resolver outcomes before commit. No new schema/function/RPC, no fixed_fee/discount SET, no mode change, no order/snapshot rewrite.

Rollback deliberately restores the ORIGINAL defective configuration. It is for an explicitly approved reversal, not a tariff reset; it refuses later edits to any tenant rule. Re-read and review if any fingerprint differs. These scripts have NOT been executed on Production or any remote writeable database in this task.

## Historical read-only evidence — 2026-10-08

1. actual-postflight-read-only.sql calls the real deployed resolver for seven postcodes × four subtotals (50,99.99,100,100.01). actual-before-results.json records 20 expected failures for the five misroutes and 8 passes for the two unchanged controls. The same SELECT-only script is supplied for verification after an independently approved remediation.
2. targeted-read-only.sql calls the actual resolver for BEFORE, then executes its exact SQL body against a CTE-only proposed relation for AFTER. No function replacement or table mutation. targeted-results.json: **28/28 proposed outcomes pass**, including inclusive discount boundaries.
3. regression-read-only.sql compares selection across all **100000 five-digit strings**; this is exhaustive string routing, not a claim that all strings are assigned French postcodes. It applies the inspected local-prefix-before-fallback selection. **No overlaps before or after**, one fallback before/after, only **18 expected routing changes**: five newly local postcodes, five removed erroneous identifiers falling back, and eight provider-only changes in the corrected 15.90 rule. Therefore **99982 routing tuples are unchanged**.
4. The same query proves all non-provider/non-prefix columns are identical, all five unrelated rows are identical, and the inverse transformation restores all seven original full rows exactly. regression-results.json contains the complete changed-route list and booleans.
5. final-read.json confirms Production still has the exact BEFORE fingerprint and seven rules at the end of inspection.

## Claude re-audit correction — 2026-10-09

Previous candidate: `35bfa96271a1956c33f4d827b261be174a5cbdc6`. The only functional SQL change wraps the CASE expression in parentheses within the delivery_fee IF comparison. No resolver, business rule, rollback or existing test code changed. CIO/CTO explicitly confirmed that provider=stuart applies to the entire 15.90 rule, including its eight already-correct tokens; this remains intact.

The earlier execution limitation is resolved: the actual forward SQL and rollback now execute successfully against the saved seven-row fixture in isolated PGlite 0.5.8 (PostgreSQL 18.3), Node v24.14.1. No Production or PREPROD access occurred during this re-audit. The October 8 files above remain historical observations, not a fresh Production check. The AFTER state below is validated in memory, not applied to Production.

Executed from repository root:

```sh
npm ci --prefix supabase/tests/b5 --no-audit --no-fund
node --test supabase/tests/au-lait-cru-delivery-zone-remediation-v1.test.mjs
node supabase/tests/au-lait-cru-delivery-zone-remediation-v1-evidence.mjs
```

- npm ci completed successfully; the unchanged four-test harness passed 4/4, with zero failures, skips or cancellations.
- Forward DML, B0 triggers, all 28 resolver assertions, exact two-row delta, replay/stale-state refusal, and complete rollback restoration passed.
- The evidence runner reran the SELECT-only targeted simulation (28/28), then executed the real forward script and the SELECT-only postflight against the updated in-memory database (28/28).
- Exhaustive selection regression was rerun: 100000 strings, 18 expected changes, 99982 unchanged, no overlaps, one fallback, all unrelated rows and other fields preserved.
- All seven rows' discount fields are unchanged. Active rules retain the inclusive 100 EUR threshold and 50% discount; the disabled legacy rule is preserved.
- Full-row BEFORE, AFTER and restored fingerprints match the original guards exactly. SQL syntax correction does not change data fingerprints.

Raw outputs are under `reaudit/`: npm-ci.log, test-results.log, targeted-results.json, actual-after-results.json, regression-results.json and state-checks.json. The reproducible evidence runner is under ../../tests/. manifest.json records refreshed SHA-256 hashes for all evidence and script files except itself (avoiding circular hashing). The original test source's "not run" comment describes its preparation date; the execution logs in this revision supersede that historical comment.

Validation uses an ephemeral isolated Vercel Sandbox solely as a Node/PGlite process host because the local Windows process helper remains unavailable. No application deployment or remote database connection was made. This is not native hosted-PostgreSQL or application end-to-end validation. Preparation still does not authorize Production application.

AU LAIT CRU DELIVERY ZONE REMEDIATION v1
REMEDIATION COMPLETE
READY FOR INDEPENDENT CLAUDE RE-AUDIT
