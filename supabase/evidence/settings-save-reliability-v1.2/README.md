# SETTINGS SAVE RELIABILITY v1.2 — evidence (remediation)

Evidence for the SECOND independent re-audit of PR #128 ("TO: BOULEZ /
CLAUDE, STATUS: INDEPENDENT AUDIT FAIL — NARROW REMEDIATION REQUIRED,
PR: #128"), delivered as a direct mandate attachment. This packet
**supersedes** `supabase/evidence/settings-save-reliability-v1.1/`
(v1.1's own packet, candidate `f379477`) — that packet closed the
*first* re-audit's two blockers (the v1 reorder's partial-save
ambiguity, and a stale full-suite baseline); this one closes the
*second* re-audit's two **new** blockers, found in v1.1's own design.

"The rest of the v1.1 dirty-state design is accepted as a basis.
Do NOT rewrite the whole settings page." — honored: this remediation
only inserts staleness checks around existing code, splits one
existing try/catch into four, and fixes two back-writes. No new RPC,
no new DB transaction, no rewrite.

## Blocker 1 — concurrency / snapshot provenance (closed)

v1.1's `submit()` wrote into `legalSnapshotRef`/`generalSnapshotRef`
(and, for mapsUrl/whatsapp, back into React state) immediately after
an `await`, without proving the save still belonged to the
currently-displayed restaurant, or that no newer edit had happened
while the RPC was in flight. Two concrete failure modes named by the
audit:

- **A.** Switch restaurant A→B while `save(A)` is in flight: a late
  successful A mutation could overwrite B's snapshot.
- **B.** Maps URL: submit X, type Y while the RPC is in flight,
  resolve X → the old code wrote `snapshot = X` **and** called
  `setMapsUrl(X)` unconditionally, erasing Y from the UI.

### Fix — reuse the existing restaurant-context-guard token

`submit()` now calls `guard.beginRequest(restaurantId)`
(`lib/restaurant-context-guard.ts`, the **same** hook `load()`
already uses — nothing new invented) right after `setSaving(true)`,
and checks `token.isCurrent()` immediately after **every** `await` in
every mutation block (legal, the four contact sub-writes, colors,
mapsUrl, identity, bgColor, social, languages) — in both the success
path and the `catch` — before touching any snapshot ref, any `set*`
call, any success counter, or the final outcome. A restaurant switch
(`handleSelectRestaurant` → `guard.enterContext`) invalidates any
in-flight token from the old restaurant synchronously, in the same
event handler that changes `restaurantId` — there is no intermediate
render where a stale save could still look current.

Where submit() wrote a submitted value back into state
(`setMapsUrl`, `setWhatsapp`), that write is now a conditional
updater: `setX((live) => (live === rawValueAtSubmitStart ? X : live))`.
It reads the **live** state at update time, and only overwrites if
nothing newer was typed while the RPC was in flight; otherwise the
newer edit is left alone, the snapshot still advances to `X`, and the
newer value correctly stays dirty for the next Save. Legal/tax never
had this back-write hazard (it only advances `legalSnapshotRef`, never
calls a `setLegalXxx`), so only the staleness guard was needed there.

### A deadlock found and fixed along the way

Aborting a stale continuation with an early `return` means it never
reaches `setSaving(false)` at the bottom of `submit()`. Without a
further fix, `saving` would stay stuck at `true` **forever** after a
restaurant switch mid-save, permanently disabling the Save button for
every subsequently-selected restaurant. Fixed with one line —
`setSaving(false)` added to `handleSelectRestaurant`, alongside the
other synchronous per-switch resets — so a new restaurant context
always starts with Save available.

## Blocker 2 — contact bundle not atomic (closed)

The "contact group" wrapped 5 separate RPCs
(`updateRestaurantPublicContact`, `updateRestaurantWhatsapp`,
`updateRestaurantWhatsappEnabled`, `updateRestaurantSettings`,
`setAllMerchantTrackingStatusText`) in **one** `try`/`catch`. A
`try`/`catch` does not make writes atomic: if public contact succeeded
and WhatsApp then failed, the group reported zero success even though
public contact had already persisted.

### Fix — four independent sub-writes, same RPCs, same section

No new transaction, no SQL, no RPC added/removed/merged. The bundle is
split into four sub-writes matching the mandate's own grouping:
`publicContact` (phone+email), `whatsapp` (number **and** enabled
state — ONE sub-group, per the mandate's own single-bullet listing),
`restaurantSettings` (lang/address/hours), `trackingText`
(status texts). Each has its own dirty comparator, its own
`try`/`catch`, and its own partial snapshot advance on success. All
four share one visual error message (`stContactSaveError`, explicitly
permitted by the mandate), but the internal dirty state stays
field/subgroup-accurate: a failed sub-write's fields stay dirty and
are retried alone; a succeeded one's fields go clean and are never
rewritten. The pre-existing three-way outcome mechanism
(success / direct failure / `stPartialSaveError`-mixed) needed **zero**
new code — `succeededCount`/`failedKeys` are simply populated at finer
granularity automatically.

K5's design choice: all four sub-writes are always attempted, in their
original order, regardless of an earlier one's failure ("continue",
never "stop") — maximizes real persistence, keeps reporting granular.

## Tests

### C1–C6 — concurrency (Blocker 1)

- **C1** — switch A→B while a legal save(A) is in flight: the late A
  completion is silently dropped (no success banner shown while B is
  displayed, no extra RPC call), B's own edit stays correctly dirty
  and is genuinely saved on B's own next Save.
- **C2** — same pattern for a general-settings save (colors): proves
  B's own **unchanged** colors are never falsely flagged dirty by A's
  late, corrupting completion.
- **C3** — Maps URL: submit X, type Y while in flight, resolve X → UI
  still shows Y, the snapshot represents X, the second Save sends Y.
- **C4** — same pattern for a legal field (no back-write hazard there,
  but confirms the snapshot-advance-only behavior holds).
- **C5** — successful save + immediate second Save, no further edit →
  zero duplicate write.
- **C6** — successful save + a genuinely new edit → the new edit is
  still saved.

### K1–K5 — contact sub-write atomicity (Blocker 2)

- **K1** — public contact succeeds, WhatsApp fails → partial-save
  shown, public contact's snapshot advances, WhatsApp stays dirty,
  retry never rewrites public contact.
- **K2** — WhatsApp succeeds, restaurant settings fails → WhatsApp
  stays clean on retry, restaurant settings alone is retried.
- **K3** — tracking text fails after three earlier sub-writes succeed
  → partial-save shown, retry touches only tracking text.
- **K4** — all four sub-writes succeed → a second Save causes zero
  contact writes.
- **K5** — the **first** sub-write (public contact) fails → the other
  three are still attempted (continue, never stop), reporting stays
  truthful (partial, never a bare global failure or a false success).

### Non-vacuousness check

Before finalizing, all 11 new tests were run against the
pre-remediation `page.tsx` (new tests kept, product fix reverted).
**7 of 11 correctly failed** (C1, C2, C3, K1, K2, K3, K5) — direct
confirmation they exercise the actual blockers. The other 4 (C4, C5,
C6, K4) pass either way, as expected: they guard behavior v1.1's
snapshot-diff mechanism already handled correctly.

## S1–S10 (v1.1, re-verified unchanged)

Still green, unmodified since v1.1 — see
`supabase/evidence/settings-save-reliability-v1.1/README.md` for their
description.

## Full-suite regression identity (fresh, current main)

Base (`73ca103fdb2045693abebc7738994b4e33fa803f`, current `main`,
unchanged since v1.1) vs. candidate
(`675089ee20c12e3468fb36295ca93394de36e120`), separate clean
checkouts (`git worktree --detach` for both), identical
`package-lock.json` (sha256 `0ff7fc62...d296a38`), identical Node
(`v22.22.2`), `npm ci` on both.

| | base (`73ca103f`) | candidate (`675089e`) |
|---|---|---|
| tests | 4550 | 4573 |
| pass | 4540 | 4563 |
| fail | 10 | 10 |

Count delta (23) fully explained by the 11 new tests (C1–C6, K1–K5)
added on top of v1.1's existing 12 (S1–S10).

**Failure identities: `added=[]`, `removed=[]`** — the 10 failing test
identities are byte-for-byte identical between base and candidate
(`baseline-failures-sorted.txt` / `candidate-failures-sorted.txt`):
the same pre-existing, out-of-scope, process-level structural checks
for other lots — none touched by this lot, none newly broken, none
newly fixed.

`npx tsc --noEmit --incremental false -p tsconfig.json`: **0 errors**.

## Scope discipline

Files changed: `app/dashboard/settings/page.tsx`,
`tests/settings-save-reliability-v1.dom.test.ts` — exactly the two
files this remediation needed, nothing else. No SQL/migration file
touched. No forbidden-scope file touched. `lib/services/dashboard.ts`
and `lib/restaurant-context-guard.ts` were **not** modified — the RPC
contracts and the concurrency primitive both stayed exactly as they
already were; only `app/dashboard/settings/page.tsx` was taught to use
the latter more carefully.

## Files

- `manifest.json` — SHAs/trees, blockers closed, exact fix mechanics,
  environment, counts, failure-identity delta, non-vacuousness check,
  invariant confirmations.
- `baseline.tap.gz` / `baseline-failures-sorted.txt` — full raw TAP and
  sorted failure identities for `73ca103f`.
- `candidate.tap.gz` / `candidate-failures-sorted.txt` — full raw TAP
  and sorted failure identities for `675089e`.
- `targeted.tap.gz` — raw TAP for
  `tests/settings-save-reliability-v1.dom.test.ts` alone (23/23 pass).
- `structural.tap.gz` — raw TAP for
  `tests/lot-merchant-legal-tax-profile-v1.test.ts` +
  `tests/lot-merchant-legal-tax-profile-v1-dom.test.ts` +
  `tests/cfte-v1-merchant-status-text-write.test.ts` +
  `tests/v71-hardening.test.ts` + `tests/v72-hardening.test.ts`
  together (119/119 pass) — the files most at risk from the
  staleness-guard and contact-bundle-split edits (literal
  source-string / structural checks on `submit()`'s exact shape).

---

**SETTINGS SAVE RELIABILITY v1.2 REMEDIATION COMPLETE — READY FOR
INDEPENDENT RE-AUDIT.**

**NO MERGE / NO PRODUCTION / NO PREPROD.**
