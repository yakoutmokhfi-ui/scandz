# B5 final composition — Dirac

Required base: `24dde51ac047100de7d23c6b28d78b54f013a72c` (final B234).
Mandate: https://github.com/yakoutmokhfi-ui/scanym-orchestrator/issues/17#issuecomment-5932634360
PR #123 stays DRAFT for micro-audit. No merge, deployment, Production or PREPROD access in this composition task. No merchant data changed.

## Result and composition

The public RPC previously returned nine routing/translation fields without prices. It now appends pricing_mode, fixed_fee, free_threshold and the three B5 discount fields. Provider and raw configuration remain private; internal routing codes are never rendered by the new public surfaces. Existing active filters, customer text and validated translations remain.

The merchant editor configures enabled/threshold/percentage through the B234 RPC, with no business defaults. A complete policy can remain disabled. Old payloads omitting all three fields preserve existing policy; old-style new rules default to disabled. Partial policies, invalid JSON types, non-finite, negative, over-precision and out-of-range values are refused. Owner/manager/operator authorization, staff read-only, tenant checks, B0, advisory lock and last-active-rule confirmation remain. The editor draft helper's assignment order was also corrected because it erased explicit validation errors.

The public estimate uses integer cents and the configured policy. The real cart shows 12.40 products + 18.90 delivery = 31.30 before checkout for fixture postcode 75013. Missing configured pricing visibly abstains and blocks submission rather than inventing zero. Legacy delivery without rules and pickup retain their behavior. create_order remains authoritative; no estimate is sent as an authoritative fee. The Stuart consumer explicitly rejects an unavailable estimate.

The menu now exposes “Modes et tarifs de livraison”, opening a native dialog with configured areas, prices, minimums, thresholds and customer notices. A valid resolved postcode opens a dismissible result dialog with eligibility, effective fee, notice and discount condition/application. A debounced semantic result key prevents ordinary rerenders from reopening it. Close button, Escape/backdrop dismissal, accessible title and bounded scrolling are provided. Existing validated-translation/source fallback applies; FR/EN/AR UI labels and unknown-language fallback are supported.

The audited B5 kernel cherry-picked cleanly onto final B234. No B0/B234 source migration was edited. Semantic integration is explicit in the additive DRAFT migration. The old evidence commit was not replayed; new evidence uses the required base.

## Formula and history

Option B: discount_enabled, discount_threshold, discount_percentage are separate policy fields, not a pricing mode. Compute free/fixed/free-above-threshold base fee first. Enabled and subtotal >= threshold gives round(base_fee * (1 - percentage / 100), 2). SQL numeric is authoritative; public integer-cent half-up arithmetic matches it. Threshold range [0,99999999.99], percentage [0,100], finite and at most two decimals. Zero and 100 percent are valid. Free delivery stays free.

Resolver and independent B1-A-01 verification change atomically and remain fail-closed. Checkout signature, return and ACL remain. Enabled policies produce v2 snapshot facts even below threshold or at zero percent; disabled policies produce v1 with null discount facts. No backfill, historical rewrite, mutable rule FK or duplicate final fee. Final fee remains in orders.delivery_fee.

## Migration and rollback

- Forward: DRAFT-lot-delivery-pricing-v2-b5.sql.
- Adjacent rollback: DRAFT-lot-delivery-pricing-v2-b5-ROLLBACK.sql.
- Five changed functions: resolver, checkout, merchant read, merchant mutation, public fulfillment projection. No new public RPC.
- Preflight checks exact normalized B1 definitions and final B234/public bodies. Only CRLF/LF is normalized. Unknown drift, dependencies and extra checkout overloads abort transactionally; no CASCADE.
- Private RLS-protected metadata saves definitions, owners, grants and comments for the three composed RPCs. No business data; no direct anon/authenticated DML on new policy columns.
- Rollback refuses active policies and changed installed bodies. After explicit authorized disabling, it restores B1 and exact B234/public predecessor contracts/ACL. It preserves policy columns and v1/v2 history and prohibits reactivation under B1 with a CHECK. Re-enablement needs a reviewed forward migration; original additive DDL is not replayable.

## Validation and limits

Reproduce from root:

```sh
npm ci --no-audit --no-fund
npm ci --prefix supabase/tests/b5 --no-audit --no-fund
npm test --prefix supabase/tests/b5
npx tsc --noEmit --incremental false
node --experimental-strip-types --import ./tests/register.mjs --test --test-concurrency=1 --test-reporter=tap tests/*.test.ts
```

The bootstrap replays B1, operator authorization, notices, the actual nine-field public projection and final B234 before B5. The 75 kernel tests cover hostile domains, formulas, checkout, rounding, VAT, history, isolation, migration atomicity and rollback. Composition tests route the real public service to SQL, comparing estimator, staff tester and checkout across five fees, threshold boundaries and 160 deterministic random pairs. React DOM tests mount the actual BO/cart, replace transport only, and create real SQL orders.

Fresh full-suite logs, SHA-256 hashes, exact changed paths and failure identity comparison are in evidence/delivery-pricing-b5-final/. The evidence commit adds documentation/proofs only after testing.

Limits: PGlite 0.5.8 / PostgreSQL 18.3 WASM, not native Supabase/PostgreSQL 16 or multi-session load. JSDOM supplies native-dialog platform methods; no visual browser/device certification claimed. Production Chronofresh 12.00 versus desired 18.90 remains a separate CIO data decision. No time slots, cutoffs, dates, spacing or CGV work.
