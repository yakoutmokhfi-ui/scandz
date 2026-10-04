# SETTINGS SAVE RELIABILITY v1.3 — evidence (remediation)

Evidence for the THIRD independent re-audit of PR #128 ("TO: BOULEZ /
CLAUDE, STATUS: SECOND INDEPENDENT RE-AUDIT FAIL, NARROW REMEDIATION
REQUIRED, PR: #128"), delivered as a direct mandate attachment. This
packet **supersedes** `supabase/evidence/settings-save-reliability-v1.2/`
(candidate `675089e`) — that packet closed the *second* re-audit's two
blockers (stale-save concurrency/snapshot provenance, and the
four-sub-write contact-bundle split); this one closes the *third*
re-audit's finding that two of those four "sub-writes" were
themselves still bundles of more than one real RPC.

"Blocker 1 ... CLOSED for the audited named cases. Do NOT redesign
that part." — honored: no change to any `token.isCurrent()` guard,
restaurant-switch protection, Maps X→Y protection, legal X→Y
protection, or conditional live-state write-back. This remediation
only widens the Blocker-2 split from four sub-writes to six, and
leaves every v1.2 concurrency mechanic untouched.

## Blocker 2A — WhatsApp number/enabled split (closed)

v1.2 treated "whatsapp" (number + enabled) as ONE sub-write with one
`try`/`catch`, even though it performs TWO separate RPCs
(`updateRestaurantWhatsapp`, `updateRestaurantWhatsappEnabled`). If the
number RPC succeeded and the enabled RPC then failed, the sub-write was
recorded as a single failure: the number's real persistence was
invisible to the outcome/snapshot, and a retry would needlessly
resubmit the already-persisted number.

### Fix — two independent sub-writes, same two RPCs

`whatsappSubDirty`/`whatsappDirty` are replaced by two pure
comparators and two dirty flags: `whatsappNumberSubDirty` /
`whatsappNumberDirty` and `whatsappEnabledSubDirty` /
`whatsappEnabledDirty`. Each now has its own `attemptedCount++`,
`try`/`catch`, and its own partial `generalSnapshotRef` advance —
exactly the same pattern the other four contact sub-writes already
use.

The pre-existing SQL/product dependency (CUSTOMER CONTACT v1:
activating WhatsApp requires an already-valid number) is preserved,
not dropped, and scoped precisely:

- The number sub-write is attempted only `if (whatsappNumberDirty &&
  currentGeneral.whatsappEnabled)` — unchanged contract: never write
  the number while WhatsApp is currently disabled.
- `whatsappEnabledBlockedByNumberDependency = currentGeneral.whatsappEnabled
  && whatsappNumberDirty && whatsappNumberFailedThisSubmit` blocks the
  enabled RPC **only** when activating, **only** when the number was
  dirty, and **only** when that number attempt just failed in this
  same `submit()` call. Disabling never depends on the number
  (unchanged: "désactivé → le numéro stocké n'est ni exigé ni
  modifié"), and an already-clean number never blocks activation.
  When blocked, `whatsappEnabled` is touched by **zero** RPCs and
  **zero** counters — it simply stays dirty, retried alone once the
  number is actually persisted (W2).

The v1.2 conditional back-write for the number
(`setWhatsapp((live) => (live === whatsapp ? currentGeneral.whatsapp :
live))`) is unchanged — it still protects a newer in-flight edit from
being clobbered by a stale resolved value (W5).

## Blocker 2B — tracking-text per-status split (closed)

`setAllMerchantTrackingStatusText` (`lib/services/tracking-status-text.ts`)
loops `CANONICAL_ORDER_STATUSES` and calls the single-status RPC once
per status, sequentially, aborting the whole loop on the first
rejection — so it was never atomic, even though v1/v1.1/v1.2 all used
it as the save flow's one "tracking text" sub-write. If status #1
persisted and status #2 then failed, the whole sub-write was recorded
as failed: #1's real persistence was invisible, and a retry would
needlessly resubmit it.

### Fix — one sub-write per dirty status, same unitary RPC

A new `trackingTextDirtyStatuses` (computed once per `submit()`, same
place as every other `*Dirty` flag) is
`CANONICAL_ORDER_STATUSES.filter(status => !generalSnap ||
trackingStatusDirty(generalSnap.statusTexts, currentGeneral.statusTexts, status))`
— the canonical statuses that are **actually** changed, nothing else.
`submit()` then loops **only** over that list, calling the existing,
unmodified, unitary `setMerchantTrackingStatusText(restaurantId,
status, body)` (already used directly by
`tests/cfte-v1-merchant-status-text-write.test.ts` "2a") once per dirty
status, each with its own `attemptedCount++`/`try`/`catch`/partial
snapshot advance (`generalSnapshotRef.current.statusTexts[status]`).

Policy: **CONTINUE** (mandate's own stated preference) — one status's
failure never skips or aborts the remaining dirty statuses; every
dirty status is always attempted, every result accounted for
individually.

`setAllMerchantTrackingStatusText` stays in
`lib/services/tracking-status-text.ts`, completely unmodified ("may
remain in the repository if other callers need it") — it is simply no
longer imported or called by `app/dashboard/settings/page.tsx`'s save
flow, which now imports and calls `setMerchantTrackingStatusText`
directly, once per dirty status. No SQL change, no DB transaction
invented, no RPC added/removed/merged — only which existing exported
function the page calls, and how many times.

## Outcome accounting / snapshot invariant

Both fixes keep exactly the same, unmodified three-way outcome
mechanism (`succeededCount`/`failedKeys`/`attemptedCount`,
`stSaved`/direct failure/`stPartialSaveError`-prefixed mixed) — it
needed **zero** new code, since it already counts whatever
`attemptedCount++`/`succeededCount++` sites actually run. Splitting one
sub-write into two (or seven) sites simply makes the SAME mechanism
more precise: "number succeeds + enabled fails" is now two real
persistence units (1 success + 1 failure ⇒ partial), never a
false "0 successes". The snapshot continues to mean "known persisted
state" — only the exact field/status confirmed persisted ever
advances; anything failed or blocked by the dependency rule stays
dirty.

## Tests

### W1–W5 — WhatsApp number/enabled independence (Blocker 2A)

- **W1** — number succeeds, enabled fails ⇒ partial-save shown, number
  sub-write succeeds once, enabled sub-write attempted and fails once;
  retry (failure cleared) never rewrites the number (still 1 call) and
  retries enabled alone (now 2 calls).
- **W2** — number fails while activating ⇒ direct failure (never
  partial, never success), enabled is never attempted at all (blocked
  by the dependency — no false success); retry, with the failure
  cleared, attempts and succeeds at both.
- **W3** — enabled-only change (disabling, number untouched) ⇒ zero
  number RPC, one enabled RPC.
- **W4** — number-only edit while already enabled ⇒ one number RPC,
  zero enabled RPC (not redundantly rewritten).
- **W5** — number X→Y while the number RPC is in flight, resolve X ⇒
  UI still shows Y, the first call's exact payload was X, the second
  Save's exact payload is Y — the same concurrency proof C3 gives
  mapsUrl, now given directly for WhatsApp (closing the re-audit note
  that WhatsApp concurrency previously had only code-inspection
  evidence).

### T1–T6 — per-status tracking-text independence (Blocker 2B)

- **T1** — exactly one status changed ⇒ exactly one RPC.
- **T2** — status A succeeds, status B fails ⇒ partial-save shown, A's
  call is never repeated by retry, retry calls B alone.
- **T3** — the FIRST changed status (in canonical order) fails ⇒ the
  two later changed statuses are still attempted (continue policy),
  proven via the exact call-order log.
- **T4** — the MIDDLE of three changed statuses fails ⇒ the two
  successful ones go clean (never rewritten by retry), the failed one
  alone is retried.
- **T5** — all changed statuses succeed ⇒ an immediate second Save
  with no further edit causes zero additional tracking RPCs.
- **T6** — the seven-status grid is left entirely untouched (even
  while an unrelated field, address, is saved) ⇒ zero tracking RPCs —
  proves the old "all seven, unconditionally" shape is gone.

### Non-vacuousness check

Before finalizing, all 11 new tests were run against the
pre-remediation (v1.2) `app/dashboard/settings/page.tsx` (`git stash`
of that one file only, keeping the new tests and a temporary
compatibility shim so the reverted page's now-stale
`setAllMerchantTrackingStatusText` import still resolves in the test
harness's mocked module — the shim reproduces that function's real,
already-existing sequential/abort-on-first-failure loop, nothing new).

**11 of the 34 tests in the file correctly failed** without this
remediation: K1, K2, K3, K4, K5 (the v1.2 four-sub-write contact bundle
no longer matches the new five/six-way split's expectations), and, of
the new tests themselves, W1, W4, T1, T2, T3, T4, T5 — including all
three the mandate named as critical (**W1, T2, T4**). The remaining new
tests (W2, W3, W5, T6) pass on the pre-remediation code too, as
expected: each covers a scenario the old bundled/looped behavior
already happened to satisfy (a direct number failure already blocked
the combined call; an enabled-only or number-only edit already singled
out the one changed field at the UI level; the mapsUrl-style
concurrency guard this reuses was already closed in v1.2; an untouched
grid already triggered nothing). After restoring the fix, all 34 pass.

## S1–S10 / C1–C6 / K1–K5 (v1.1/v1.2, re-verified unchanged in shape)

Still green. K1/K2/K3/K5 were updated **only** where they previously
asserted the old combined `whatsappEnabled` call count for a scenario
that never actually edits the enabled checkbox (corrected from an
assumption the new independent model intentionally supersedes — never
the sub-write-atomicity invariant each test actually exists to prove,
which is unchanged and still enforced). K4 was extended to toggle the
enabled checkbox so it still exercises all five (now six, counting the
split) independent contact sub-writes, matching the test's own
"whole contact section clean" claim.

## Full-suite regression identity (fresh, current main)

Base (`73ca103fdb2045693abebc7738994b4e33fa803f`, current `main`,
unchanged since v1.1/v1.2) vs. candidate
(`41524d7de8d79da56b28f9a658006b66ee31de08`), separate clean
checkouts (`git worktree add --detach` for both), identical
`package-lock.json` (sha256 `0ff7fc62...d296a38`, same as v1.2's own
packet), identical Node (`v22.22.2`), `npm ci` on both.

| | base (`73ca103f`) | candidate (`41524d7`) |
|---|---|---|
| tests | 4550 | 4584 |
| pass | 4540 | 4574 |
| fail | 10 | 10 |

Count delta (34) fully explained by the 11 new tests (W1–W5, T1–T6)
added on top of v1.2's existing 23 (S1–S10, C1–C6, K1–K5).

**Failure identities: `added=[]`, `removed=[]`** — the 10 failing test
identities are byte-for-byte identical between base and candidate
(`baseline-failures-sorted.txt` / `candidate-failures-sorted.txt`):
the same pre-existing, out-of-scope, process-level structural checks
for other lots — none touched by this lot, none newly broken, none
newly fixed.

`npx tsc --noEmit --incremental false -p tsconfig.json`: **0 errors**.

## Scope discipline

Files changed: `app/dashboard/settings/page.tsx`,
`tests/settings-save-reliability-v1.dom.test.ts`,
`tests/cfte-v1-merchant-status-text-write.test.ts` — the last is a
narrow, structural-assertion-only adaptation of its test "3." (asserts
the page now calls the unitary per-status RPC and no longer calls the
grouped RPC as its atomicity unit; the service module itself,
`lib/services/tracking-status-text.ts`, was **not** touched, and that
file's own tests "1a"–"2e" are unmodified). No SQL/migration file
touched. No forbidden-scope file touched.
`lib/services/dashboard.ts` and `lib/restaurant-context-guard.ts` were
**not** modified.

## Files

- `manifest.json` — SHAs/trees, blockers closed, exact fix mechanics,
  environment, counts, failure-identity delta, non-vacuousness check,
  invariant confirmations.
- `baseline.tap.gz` / `baseline-failures-sorted.txt` — full raw TAP and
  sorted failure identities for `73ca103f`.
- `candidate.tap.gz` / `candidate-failures-sorted.txt` — full raw TAP
  and sorted failure identities for `41524d7`.
- `targeted.tap.gz` — raw TAP for
  `tests/settings-save-reliability-v1.dom.test.ts` alone (34/34 pass).
- `structural.tap.gz` — raw TAP for
  `tests/lot-merchant-legal-tax-profile-v1.test.ts` +
  `tests/lot-merchant-legal-tax-profile-v1-dom.test.ts` +
  `tests/cfte-v1-merchant-status-text-write.test.ts` +
  `tests/v71-hardening.test.ts` + `tests/v72-hardening.test.ts`
  together (119/119 pass) — the files most at risk from the
  WhatsApp-split and tracking-text-loop wiring changes (literal
  source-string / structural checks on `submit()`'s exact shape and
  on the dashboard's tracking-text wiring).

---

**SETTINGS SAVE RELIABILITY v1.3 REMEDIATION COMPLETE — READY FOR
INDEPENDENT RE-AUDIT.**

**NO MERGE / NO PRODUCTION / NO PREPROD.**
