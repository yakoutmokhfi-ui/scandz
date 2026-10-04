# SETTINGS SAVE RELIABILITY v1.1 — evidence (remediation)

Evidence for the independent re-audit of PR #128 ("TO: BOULEZ /
CLAUDE, STATUS: REMEDIATION REQUIRED — DO NOT AUDIT YET, PR: #128"),
delivered as a direct mandate attachment. This packet **supersedes**
`supabase/evidence/settings-save-reliability-v1/` (v1's own packet,
candidate `7ff1176`) — that packet's base/candidate comparison used a
stale `main` (Blocker 2); this one is a fresh comparison against
current `main`.

## Blocker 1 — partial save (rejected v1 claim)

v1 (PR #128, candidate `7ff1176`) moved `updateReceiptSettings`
(legal/tax) to be the **first** mutating RPC in `submit()`, while
keeping "submit unconditionally re-mutates all ~11 sections on every
click". Its own evidence claimed *"atomicity preserved, only call
order changed"*.

The re-audit correctly rejected that claim: moving legal/tax first
does not make the page-level flow atomic. A merchant editing **only**
colors could still have legal/tax **silently re-persisted** (even
though nothing in it changed) immediately before colors failed — and
the error shown was colors-specific, never disclosing that legal/tax
had just been written. The inverse is just as real: a merchant editing
legal/tax could have it persist, then an unrelated section fail,
producing a global-looking error that hid the legal/tax success. Both
are the same ambiguity the mandate forbids ("never claim global
success if one section fails" **and** "never leave an
already-persisted section looking unsaved").

### Fix — per-section dirty-state tracking (snapshot-diff)

`submit()` now separates **which sections actually changed** ("dirty")
from **which sections are submitted**: only dirty sections are
mutation candidates.

- `generalSnapshotRef` / `legalSnapshotRef` hold a **normalized**
  snapshot (same trim/null/`normalizeMapsUrl`/`normalizeWhatsappNumber`
  functions used to build each RPC payload) of the state as loaded, or
  as last successfully persisted. They are populated/patched
  throughout `load()` (including its two independently-async
  sub-loads, `statusTexts` and `activeLanguageCodes`), and reset to
  `null` **synchronously** on every restaurant switch
  (`handleSelectRestaurant`) and legal-profile reset
  (`resetLegalProfileState`) — so a dirty check can never compare
  against a stale restaurant's data.
- 8 pure `*GroupDirty` comparator functions — one per **existing**
  RPC/bundle boundary (`legal`, `contact` [owner/manager bundle,
  internal atomicity unchanged], `colors`, `mapsUrl`, `identity`,
  `bgColor`, `social`, `languages`) — compare the snapshot against a
  freshly-built `current*` object at submit() time.
- Each dirty section is attempted **independently** — never a
  DB-wide transaction invented across unrelated RPCs, never an
  authorization/provenance guard bypassed, never finer-grained than
  the existing RPC/bundle split (mandate: "reuse a smaller existing
  mechanism", "keep this narrow").
- The outcome is reported **without ambiguity**, three ways:
  1. all dirty sections succeed, **or none were dirty** → `stSaved`.
  2. **zero** of the attempted sections succeed → their failure
     message(s) directly (nothing was persisted, nothing to hide).
  3. **mixed** (≥1 success, ≥1 failure) → a new, explicit
     `stPartialSaveError`-prefixed message (fr/en/ar) naming the
     failure(s) — the success indicator is **never** shown, and the
     failure message **never** reads as a plain, undifferentiated
     error.

Validation itself is **unchanged** and still runs unconditionally on
every submit (not gated by dirty state) — an explicit, documented,
out-of-mandate-scope decision: the mandate's test matrix and "user
contract" section address mutation scope only, never validation scope.

## Blocker 2 — stale baseline (closed)

v1's evidence compared against base `0826f5f3` (origin/main at the
time v1 branched), but `main` had since advanced to `73ca103f` (merge
of PR #126). This packet's full-suite comparison (below) uses a fresh
`git worktree --detach` checkout of `73ca103f`, separate `npm ci`,
exact failure-**identity** comparison (never counts alone).

## Tests (S1–S10 — S11 below, outside this file)

`tests/settings-save-reliability-v1.dom.test.ts` was substantially
rewritten (same JSDOM/esbuild harness, same mock modules) for the new
contract:

- **S1** — legal-only edit (across a restaurant switch A→B) reaches
  `updateReceiptSettings` exactly once, targeting B, and triggers
  **zero** calls to every one of the other 7 groups + the contact
  bundle.
- **S2** — tax-rate-only edit: same isolation proof.
- **S3** (mandated correction of v1's old S3) — colors-only edit
  reaches `updateRestaurantColors` exactly once and triggers **zero**
  calls to `updateReceiptSettings` — the exact inverse of S1/S2, and
  the explicit new contract the mandate required in place of v1's
  "colors fails after legal succeeds" test.
- **S4** (critical) — legal **and** colors both dirty, colors fails:
  both are attempted independently (legal succeeds, persists; colors
  fails); no unrelated section is ever touched; the error is the new
  `stPartialSaveError`-prefixed, colors-specific message; the success
  indicator is **never** shown (it would hide the colors failure) and
  a plain/generic failure is **never** shown either (it would hide the
  legal success).
- **S5** (×3: invalid email / tax rate >100 / missing tax label) —
  legal validation still blocks: zero mutating RPCs of any kind.
- **S6** (critical) — provenance guard
  (`legalProfileReady`/`legalProfileLoadedRestaurantId`) unchanged:
  zero mutating RPCs, even via a raw `submit` event bypassing the
  disabled button.
- **S7** — operator-only mode: role policy **and** dirty-gating hold
  together. A dirty legal edit plus two dirty operator-allowed
  sections (colors, mapsUrl) all reach their RPC; an **unchanged**
  operator-allowed section (identity/bgColor/social/languages) is
  never called (proves dirty-gating applies even to sections the role
  is allowed to touch); the owner/manager-only contact bundle is never
  called (role policy, unchanged from before v1).
- **S8** — exact payload preservation (all 12 legal fields
  retransmitted unchanged except the one edited field), plus zero
  calls to every unrelated section.
- **S9** — double-save: a second real `.click()` on the
  now-genuinely-disabled Save button never duplicates the RPC.
- **S10** (critical, new) — an **unchanged** form submitted triggers
  **zero** mutating RPCs of any kind — the direct proof that the
  snapshot-diff mechanism itself correctly reflects the loaded state,
  not just that *some* sections get skipped.

## Self-correction during remediation

The first full candidate run after the rewrite showed **13** failures
— 3 more than the base's 10. Both extra failures were pre-existing
tests whose assumptions depended on the exact "always unconditionally
re-mutate everything" behavior this lot replaces:

1. `tests/cfte-v1-merchant-status-text-write.test.ts` ("3.") — a
   literal source-string check for
   `setAllMerchantTrackingStatusText(restaurantId, statusTexts)`.
   Fixed by keeping that call site passing the original `statusTexts`
   variable (same value, same source) instead of the renamed
   `currentGeneral.statusTexts`.
2. `tests/lot-merchant-legal-tax-profile-v1-dom.test.ts` — "Scénario
   C" and "Scénario D" each submitted an **unedited** form right after
   a restaurant switch and asserted `updateReceiptSettings` was still
   called. That is now intentional **zero**-mutation behavior (S10).
   Fixed minimally: each scenario now edits `legal_name` (a field
   verified by **no** existing assertion in either scenario) before
   submitting, so the legal RPC is dirty and still fires — every
   existing assertion (restaurant targeting, anti-staleness proofs,
   safe defaults) is preserved byte-for-byte.

Both files were re-verified green, then the **entire** candidate
suite was re-run from scratch to produce the final comparison below.
This is the same category of adaptation the mandate itself permitted
for v1's own S3 — reality changed because the bug fix the mandate
requires changed it, not because a test was weakened.

## S11 — full-suite regression identity (fresh, current main)

Base (`73ca103fdb2045693abebc7738994b4e33fa803f`, current `main`) vs.
candidate (`f379477c3debee64642089bd3877e0a60bc7cabb`), separate clean
checkouts (`git worktree --detach` for base), identical
`package-lock.json` (sha256 `0ff7fc62...d296a38`), identical Node
(`v22.22.2`), `npm ci` on both.

| | base (`73ca103f`) | candidate (`f379477`) |
|---|---|---|
| tests | 4550 | 4562 |
| pass | 4540 | 4552 |
| fail | 10 | 10 |

Count delta (12) fully explained by the 12 tests in the rewritten
`tests/settings-save-reliability-v1.dom.test.ts` (S1, S2, S3, S4, S5×3,
S6, S7, S8, S9, S10).

**Failure identities: `added=[]`, `removed=[]`** — the 10 failing test
identities are byte-for-byte identical between base and candidate
(`baseline-failures-sorted.txt` / `candidate-failures-sorted.txt`):
the same pre-existing, out-of-scope, process-level structural checks
for other lots — none touched by this lot, none newly broken, none
newly fixed.

`npx tsc --noEmit -p tsconfig.json`: **0 errors**.

## Scope discipline

Files changed: `app/dashboard/settings/page.tsx`, `lib/i18n.ts`,
`tests/settings-save-reliability-v1.dom.test.ts` — the originally
expected set — plus
`tests/lot-merchant-legal-tax-profile-v1-dom.test.ts`, touched only to
adapt two scenarios to the intentionally-changed zero-mutation
contract (see "Self-correction" above; no invariant weakened, no
assertion removed, only one field-choice changed and one stale comment
corrected). No SQL/migration file touched. No forbidden-scope file
touched (Delivery Pricing, `create_order`, MenuView, CartPanel, CGV
W0/W1/W2/W3, payment, Monetico, catalogue, unrelated translations,
Production, PREPROD). `lib/services/dashboard.ts` was not modified —
the RPC contracts did not need to change.

## Files

- `manifest.json` — SHAs/trees, blockers closed, dirty-state mechanism
  detail, environment, counts, failure-identity delta,
  self-correction record, invariant confirmations.
- `baseline.tap.gz` / `baseline-failures-sorted.txt` — full raw TAP and
  sorted failure identities for `73ca103f`.
- `candidate.tap.gz` / `candidate-failures-sorted.txt` — full raw TAP
  and sorted failure identities for `f379477`.
- `targeted.tap.gz` — raw TAP for
  `tests/settings-save-reliability-v1.dom.test.ts` alone (12/12 pass).
- `structural.tap.gz` — raw TAP for
  `tests/lot-merchant-legal-tax-profile-v1.test.ts` +
  `tests/lot-merchant-legal-tax-profile-v1-dom.test.ts` +
  `tests/cfte-v1-merchant-status-text-write.test.ts` together (54/54
  pass), confirming the adapted scenarios and the tracking-text
  call-site fix both hold.

---

**SETTINGS SAVE RELIABILITY v1 — REMEDIATION COMPLETE — READY FOR
INDEPENDENT AUDIT.**

**NO MERGE / NO PRODUCTION / NO PREPROD.**
