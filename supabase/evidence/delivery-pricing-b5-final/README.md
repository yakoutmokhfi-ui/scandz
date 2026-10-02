# B5 final composition evidence — Dirac

Required base: 24dde51ac047100de7d23c6b28d78b54f013a72c.
Tested implementation: 44e77d726729d5b425fca76762769997f16de759; tree 1338bd2a4ac55759a7109685248613f349087aee.
The following evidence commit adds this directory only; it does not change runtime or tests.

- Kernel: 75/75 passing on the composed final B234 schema.
- Targeted: 98/98, real SQL + real React BO/cart with only transport/platform substituted.
- TypeScript noEmit, incremental false: exit 0.
- Full base: 4491 tests, 4477 pass, 14 fail. Full candidate: 4506 tests, 4492 pass, 14 fail.
- Exact normalized file/line/test identity comparison: newFailures=[], resolvedFailures=[]. No skipped/cancelled tests.

Full suite command: node --experimental-strip-types --import ./tests/register.mjs --test --test-concurrency=1 --test-reporter=tap tests/*.test.ts
On this Windows runner, a temporary subst drive avoids esbuild parent-directory ACL failures. A process-scoped safe.directory names only the actual checkout so subprocess Git checks execute. Both clones use physical npm ci dependencies and the same runner. Base was detached at the required SHA.

Reproduce identity comparison: node compare-suites.mjs baseline.tap.gz candidate.tap.gz <output-directory>. This verifies parsed identity count against TAP fail count and rejects either added or resolved failures. No stale historical B1 line-number list is used in place of the exact new baseline.

The live-shaped test replays the actual nine-field public SQL RPC before B5, then calls its extended anonymous projection through the real TS service. The cart DOM test asserts products 12.40 / fee 18.90 / total 31.30 BEFORE submission and calls real create_order AFTER the click. Threshold boundaries 99.99/100/100.01 cover all five fee fixtures; another policy 60/20, zero/100 percent, free/free-above, pickup, configured fallback 12 and 160 seeded random checkout pairs are covered. BO tests save policy and query the real tester; existing staff/owner/manager/operator DOM checks pass unchanged. Rollback restores exact B234/public definitions and ACL, refuses active policies, preserves v2 facts and prevents reactivation. The original 75 tests also cover B1-A-01 mutation refusal, snapshots, VAT and atomic rollback.

No Production/PREPROD access, deployment, merchant-data mutation or merge. Native Supabase/PostgreSQL 16 and multi-session load were not run; PGlite 0.5.8 / PostgreSQL 18.3 WASM was used. JSDOM tests supply native dialog methods and do not constitute browser/device visual certification. Independent micro-audit remains required.

See manifest.json for raw/compressed SHA-256 checksums and exact implementation paths; changed-files.txt lists the entire final delta including this evidence directory.
