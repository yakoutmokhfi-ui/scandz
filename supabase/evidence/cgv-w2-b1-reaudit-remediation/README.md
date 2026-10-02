# CGV W2 — re-audit remediation evidence (B1 only, scanym-orchestrator#23)

Evidence for Noether's re-audit mandate (comment id 5951442732,
2026-10-02T11:30:32Z), following a second independent audit of PR #125
head `51d8e104b1da5f7b201a4a24e6a68c3a0ef1ca8c` (code commit
`f56c4a5228f5148f2c3f78fae83232d30fa9c0eb`). The only remaining blocker
was the **combined state**: `template === null` AND
`cgv.completeness_errors` non-empty — the prior fix's JSX tested
completeness errors before the no-template reason, so the combined
case silently lost the no-template explanation.

Per the mandate, B2's exhaustive from-scratch base+candidate full-suite
comparison is explicitly **not reopened**:

> B2 STATUS: CLOSED for remediation purposes. Do NOT reopen the Linux
> full-suite evidence work unless your B1 code change requires a fresh
> candidate/full-suite comparison. Exact identities and counts from
> the prior evidence were accepted by the re-auditor.

This directory therefore reuses the already-accepted base evidence in
`../cgv-w2-b1-b2-remediation/` (base `24dde51ac047100de7d23c6b28d78b54f013a72c`)
unchanged, and adds only a **fresh candidate run** against the new
code SHA, diffed against that already-accepted base.

## Files

- `manifest.json` — SHAs/trees, environment, method, counts, hashes.
- `candidate.tap.gz` / `candidate-failures-sorted.txt` — full raw TAP
  and sorted failure identities for the new code candidate
  `48ecd5c510f77eec8721304e67c5547cc52576a9`.
- `targeted-raw.tap.gz` — raw TAP for
  `tests/cgv-publication-boundary-v1.dom.test.ts` alone (20/20 pass,
  including the new `W2-T-02c` combined-state test).

## Result

| | accepted base (`24dde51a`) | new candidate (`48ecd5c`) |
|---|---|---|
| tests | 4491 | 4511 |
| pass | 4481 | 4501 |
| fail | 10 | 10 |

Count delta (20) explained: 18 pre-existing W2 tests + `W2-T-02b`
(prior remediation's secondary test) + `W2-T-02c` (this remediation's
new combined-state test).

**Failure identities vs the already-accepted base: `added=[]`,
`removed=[]`** — identical 10 pre-existing, out-of-scope failures (see
`../cgv-w2-b1-b2-remediation/README.md` for the full explanation of
each). No new regression, no newly-fixed test.

`npx tsc --noEmit -p tsconfig.json`: **0 errors**.
