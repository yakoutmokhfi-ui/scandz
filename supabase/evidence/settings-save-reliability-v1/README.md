# SETTINGS SAVE RELIABILITY v1 — evidence

Evidence for the "TO: CLAUDE DEVELOPER" mandate (SCANYM — SETTINGS SAVE
RELIABILITY v1), diagnosing and remediating a Production bug: in
Merchant Settings, changing legal/tax/receipt fields and clicking
"Enregistrer" did not persist, and `update_receipt_settings` was never
observed in the Production logs for the failed save attempt.

## Root cause (diagnosis required first — see A-G below)

`submit()` (`app/dashboard/settings/page.tsx`) unconditionally
re-validates and re-mutates **all** ~11 sections on every click of
Enregistrer, regardless of which fields the merchant actually changed.
`updateReceiptSettings` (legal/tax) was the **last** mutating RPC
called. Each section's mutation is wrapped in its own
`try { ... } catch { setError(...); setSaving(false); return; }` —
atomic at the section level, but a failure in **any earlier** section
(public contact/WhatsApp, restaurant settings, tracking status text,
colors, maps URL, identity, bg color, social links, languages) aborts
the whole submission before the legal/tax RPC is ever reached, even
when that earlier section has nothing to do with what the merchant
edited.

Diagnostic findings (mandate §"DIAGNOSTIC REQUIRED FIRST"):

- **A. Early returns before `updateReceiptSettings()`** (pre-fix):
  the `legalProfileReady`/`legalProfileLoadedRestaurantId` guard, 10+
  client-side validation checks (colors, maps URL, bg color, social
  URLs, display name/intro/announcement length, source language,
  legal email/tax-rate/tax-label, then WhatsApp/phone/email/tracking
  length when `!isOperatorOnlyMode`) — none of these block the bug
  scenario (a merchant submitting otherwise-valid data), they are
  working as intended.
- **B. Mutations awaited before `updateReceiptSettings()`** (pre-fix):
  `updateRestaurantPublicContact`, `updateRestaurantWhatsapp`,
  `updateRestaurantWhatsappEnabled`, `updateRestaurantSettings`,
  `setAllMerchantTrackingStatusText` (all four inside one
  `!isOperatorOnlyMode` try/catch), then `updateRestaurantColors`,
  `updateRestaurantMapsUrl`, `updateRestaurantIdentity`,
  `updateRestaurantBgColor`, `updateRestaurantSocialLinks`,
  `updateRestaurantLanguages` — ten RPCs, every one of them capable of
  rejecting (network blip, a transient server-side rejection, a
  latent/stale value in a field the merchant never touched).
- **C. Can any of those fail even when the merchant changed ONLY
  legal/tax fields?** Yes — none of those ten mutations re-validate
  against what changed; they always resend the full current state of
  their own section, so a pre-existing value anywhere in those ten
  sections can trip a server-side rejection independent of the
  merchant's actual edit.
- **D. Can a stale/irrelevant field elsewhere block the legal save?**
  Yes, exactly as above — this is precisely what Production exhibited.
- **E. Operator-only mode:** the same ordering bug applies — in
  `isOperatorOnlyMode`, legal/tax was still the last of the remaining
  7 mutations (colors, maps URL, identity, bg color, social links,
  languages, then legal/tax), so a failure in any of the first 6 still
  blocked it.
- **F. Does the UI surface the actual blocking section?** Yes, each
  section has its own dedicated error message — the problem was never
  an unclear error, it was that the legal/tax RPC was never even
  *attempted*.
- **G. Classification:** **mutation ordering** — not validation
  ordering (validations were already fine), not stale state (the
  provenance guard, fixed in a prior lot, was already correct and is
  unaffected), not a permission failure.

A secondary, related invariant violation was found and fixed in the
same catch block being touched for the reorder: the contact/WhatsApp
catch used `e.message` (raw PostgREST/SQL error text from
`lib/services/dashboard.ts`'s `throw new Error(error.message)`
wrappers), violating the mandate's explicit "no raw server errors
leaked to user" invariant. Replaced with a dedicated translated key
(`stContactSaveError`), matching every other section's pattern.

## Remediation (smallest safe change)

`updateReceiptSettings` is now the **first** mutating RPC in
`submit()`, in both full and operator-only modes. Nothing else moved:

- No validation reordered.
- No guard weakened — `legalProfileReady` /
  `legalProfileLoadedRestaurantId` is still the absolute first
  instruction in `submit()` (MLTP-V11-DASHBOARD-GUARD-ORDER-01,
  untouched).
- No sectional/partial-save redesign — each section (including the
  now-first legal/tax section) still aborts the rest of the
  submission on its own failure. The atomicity contract ("a failure
  interrupts everything after it") is unchanged; only the call
  **order** changed, so a legal/tax-only edit is never again blocked
  by an unrelated section, while a legal/tax-only edit that itself
  fails validation still blocks everything exactly as before.
- No SQL/migration change — not required, and none made.
- No second write path to `receipt_settings` — a single call site,
  the same RPC contract (`update_receipt_settings`), same payload
  shape.

## Tests (S1-S9)

`tests/settings-save-reliability-v1.dom.test.ts` (new, DOM harness
modeled on `tests/cgv-publication-boundary-v1.dom.test.ts`) covers
S1-S8 (10 tests: S1, S2, S3, S4×3, S5, S6, S7, S8). S9 (full-suite
regression identity) is, like W2-T-09/W2-T-10 in the CGV lot, a
process-level check performed here, outside any unit test file.

- **S1** — legal-only edit, across a restaurant switch (A → B),
  reaches `updateReceiptSettings` exactly once with B's (never A's
  stale) `restaurantId` and the new footer text; success shown.
- **S2** — tax-rate edit reaches `updateReceiptSettings` once with the
  new numeric rate; no silent no-op.
- **S3** — adapted to the new explicit contract, as the mandate
  permits ("If remediation changes ordering safely, adapt expected
  behavior... but the result must never be ambiguous"): a `colors`
  mutation failure no longer blocks `updateReceiptSettings` (which now
  runs and succeeds first), but still produces a clear,
  `colors`-specific error, aborts every mutation after it
  (`mapsUrl`/`identity`/`languages` never attempted), and never shows
  the success indicator.
- **S4** (3 cases: invalid email, tax rate > 100, missing tax label) —
  legal validation still blocks exactly as before: zero mutating RPCs
  of any kind, a clear validation-specific error.
- **S5 (critical)** — `legalProfileReady = false` (simulated receipt
  read failure): the Save button is already disabled by the same
  condition as the guard; even a raw `submit` event dispatched
  directly on the `<form>` (bypassing the disabled button) is refused
  by the guard itself (defense in depth) — zero mutating RPCs of any
  kind, `stLegalNotReady` shown.
- **S6** — operator-only mode (`isOperator=true`, role `staff`): a
  valid legal/tax edit still reaches `updateReceiptSettings` first,
  without needing any owner/manager-only mutation (public
  contact/WhatsApp/restaurant settings/tracking text never called);
  role policy unchanged — colors/maps/identity/bg/social/languages
  remain available to the operator exactly as before.
- **S7** — changing only the footer text sends every other current
  field back unchanged (business name, legal name, address, phone,
  email, tax identifier, registration number, tax label, tax rate,
  prices-include-tax, show-tax-summary) — no field dropped, stale, or
  unexpectedly normalized.
- **S8** — a second **real** `.click()` on the Save button, while the
  first save is still in flight (receipt RPC deferred), is a no-op:
  jsdom respects the button's `disabled` attribute (verified
  empirically — see the test file), so no duplicate
  `updateReceiptSettings` call is ever created.
- **S9** — see below.

`tests/lot-merchant-legal-tax-profile-v1.test.ts` (pre-existing,
purely structural/static) was left **unmodified** and still fully
passes (41/41) — it asserts source-level invariants (RPC-only writes,
no direct `receipt_settings` access, etc.) that this lot's reordering
does not touch.

## S9 — full-suite regression identity

Base (`0826f5f36d56876fe68cba3a091e6b279a095cb0`, origin/main at the
start of this lot) vs. candidate
(`7ff11769e31a442fdf295b369e4cf3beba5d3d26`), separate clean
checkouts, identical `package-lock.json` (sha256
`0ff7fc62...d296a38`), identical Node (`v22.22.2`), `npm ci` on both.

| | base (`0826f5f3`) | candidate (`7ff1176`) |
|---|---|---|
| tests | 4537 | 4547 |
| pass | 4527 | 4537 |
| fail | 10 | 10 |

Count delta (10) fully explained by the 10 new tests in
`tests/settings-save-reliability-v1.dom.test.ts`.

**Failure identities: `added=[]`, `removed=[]`** — the 10 failing test
identities are byte-for-byte identical between base and candidate
(`baseline-failures-sorted.txt` / `candidate-failures-sorted.txt`):
pre-existing, out-of-scope, process-level structural checks that only
pass on their own lot's branch (Stuart/Payment/Catalogue
scope-change-detector tests, one `cfte-v1` test) — none of them
touched by this lot, none newly broken, none newly fixed.

`npx tsc --noEmit -p tsconfig.json`: **0 errors**.

## Scope discipline

Files changed: `app/dashboard/settings/page.tsx`, `lib/i18n.ts`,
`tests/settings-save-reliability-v1.dom.test.ts` — exactly the
expected-likely-files set, nothing else. `lib/services/dashboard.ts`
was read for diagnosis but **not modified** (the RPC contract did not
need to change). No SQL/migration file touched. No forbidden-scope
file touched (Delivery Pricing, `create_order`, MenuView, CartPanel,
CGV W0/W1/W2/W3, payment, Monetico, catalogue, unrelated translations,
Production, PREPROD).

## Files

- `manifest.json` — SHAs/trees, environment, counts, failure-identity
  delta, invariant confirmations.
- `baseline.tap.gz` / `baseline-failures-sorted.txt` — full raw TAP
  and sorted failure identities for the base commit.
- `candidate.tap.gz` / `candidate-failures-sorted.txt` — full raw TAP
  and sorted failure identities for the candidate commit.
- `targeted.tap.gz` — raw TAP for
  `tests/settings-save-reliability-v1.dom.test.ts` alone (10/10 pass).
- `structural.tap.gz` — raw TAP for
  `tests/lot-merchant-legal-tax-profile-v1.test.ts` alone (41/41 pass,
  confirming it was left unmodified).
