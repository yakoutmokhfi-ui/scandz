# CGV W2 — remediation B1/B2 evidence (scanym-orchestrator#23)

Evidence for Noether's remediation mandate (comment id 5945862932,
2026-10-02T04:57:23Z) following Chateaubriand's independent audit of
candidate `d6ad2497d2af13270034648745f88d5229a3d0bb`, which returned
`FAIL — BLOCKERS` on exactly two items (B1, B2). This directory is the
B2 full-suite non-regression proof, run from scratch against the new
remediated candidate (never a reuse of the audited `d6ad249`).

## Files

- `manifest.json` — SHAs/trees, environment (OS/Node/lockfile), exact
  commands, and per-run test counts with raw/gzip hashes.
- `failure-delta.json` — the machine-computed identity delta
  (`added=[]`, `removed=[]`) plus the full list of the 10 failure
  identities common to both runs.
- `baseline.tap.gz` / `candidate.tap.gz` — full raw TAP logs, gzip, for
  the exact base (`24dde51ac047100de7d23c6b28d78b54f013a72c`) and the
  new remediated candidate (`f56c4a5228f5148f2c3f78fae83232d30fa9c0eb`)
  respectively.
- `baseline-failures-sorted.txt` / `candidate-failures-sorted.txt` —
  the sorted failure-identity lists `comm`/`diff` were run against.
- `targeted.tap.gz` — raw TAP for `tests/cgv-publication-boundary-v1.dom.test.ts`
  alone on the remediated candidate (19/19 pass, including the B1-rewritten
  W2-T-02 and the new secondary W2-T-02b).

## Method

Two **separate** checkouts, same lockfile (sha256
`0ff7fc6293ef5e5874ca8858b4edb916c62f0169bda53605115bdc225d296a38`),
same Node binary (`v22.22.2`), same OS (`Linux ... 6.18.44-fc-v51 ...
x86_64 GNU/Linux`), each `npm ci`'d clean immediately before its run,
with the exact git SHA printed and verified (`git rev-parse HEAD`
checked against the expected value) right before each full-suite
invocation:

```
node --experimental-strip-types --import ./tests/register.mjs --test tests/*.test.ts
```

Failure identities were extracted with:

```
grep '^not ok' <tap> | sed -E 's/^not ok [0-9]+ - //' | sort
```

and compared with `diff`/`comm -13`/`comm -23`.

## Result

| | base (`24dde51a`) | candidate (`f56c4a5`) |
|---|---|---|
| tests | 4491 | 4510 |
| pass | 4481 | 4500 |
| fail | 10 | 10 |

Delta explained: 4510 − 4491 = 19 = 18 W2 tests already added by the
audited `d6ad249` (unchanged here) + 1 new test added by this B1
remediation (`W2-T-02b`, a secondary defense-in-depth test; the
primary `W2-T-02` was rewritten in place, not added).

**Failure identities: `added=[]`, `removed=[]`** — exactly the same 10
failures on both runs, none of them in W2/CGV scope:

- 9 are pre-existing structural/architecture assertions
  (`tests/ob1-non-modification-proof.test.ts`,
  `tests/v110c-payment-p3a1-structural.test.ts`) that diff the live
  tree against *other* lots' fixed historical baseline SHAs and are
  already stale on `main`, unrelated to CGV/W2 or to this remediation.
- 1 (`tests/cfte-v1-customer-name-and-email.test.ts`) is a
  container-configuration gap: this execution environment has no
  `.env.local`, and `lib/supabase.ts` validates
  `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` eagerly at
  import time. Reproduced identically, in isolation, on both
  checkouts — confirmed as an environment property, not a code
  regression tied to either SHA.

No suite nondeterminism was observed on either SHA (single clean run
each, identical identities) — the "STOP and report" clause in the
mandate does not apply.

`npx tsc --noEmit -p tsconfig.json`: **0 errors on both SHAs**, under
clean `npm ci` installs.
