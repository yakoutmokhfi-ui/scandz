# CSDJ v1.2 / CSDJ-3 — Production predecessor fingerprints

Status: **evidence, read-only.** No SQL was run against Supabase. PROD values were read by Dirac and given to Boulez; everything else was computed in disposable PostgreSQL 16 clusters and by scanning the repository (working tree and all 180 known remote branches).

## 1. Canonical hash expression (same on both sides)

```sql
md5(replace(prosrc, E'\r\n', E'\n'))        -- LF-normalised
```
and, alongside it, the raw `md5(prosrc)`. A raw mismatch with a normalised match means line endings only. `md5(pg_get_functiondef(...))` is a different quantity (it includes the header and ACL-independent attributes) and must never be compared to a `prosrc` hash.

## 2. Results

| Function | PROD `md5(prosrc)` (Dirac) | Boulez chain `md5(prosrc)` | Verdict |
|---|---|---|---|
| `update_order_status(uuid,text)` | `30748835d2e489627a9bede8abb7e468` | `96d497842e0701cb54358cafa4cbc5bd` | **Explained — line endings only.** The body of `supabase/migration-v29-merchant-dashboard.sql` with CRLF line endings hashes to exactly `30748835…`; LF-normalised it is `96d49784…`, identical to the chain. Reproduced by `supabase/tests/prod-predecessor-compare.py` (equality "after line-ending normalisation"). PROD holds the v29 body, stored CRLF. |
| `create_order(text,text,jsonb,integer,jsonb,text,text,boolean)` | `c327445751333e7908d60e6d7f838eb5` | `ccbff371d8a30fed36928a624b2a0878` (after CGV engine v2.5) | **NOT explained.** No `create_order` definition in the repository's working tree, nor in any of the 180 remote branches, hashes to `c3274457…` — raw, CRLF, trimmed, trailing-space-stripped, or any combination. |

Consequences for `create_order`:
* PROD's body is **not any state of the repository's lineage** that Boulez can reconstruct. It is either an unreleased/unknown lineage, or a hand-edited body. The Boulez harness chain (`ccbff371…`) is therefore **not** a faithful PROD predecessor for this function, and any harness result involving `create_order` internals says nothing about PROD.
* A CSDJ-3 migration that **replaces** `create_order`'s body ("rebase verbatim + insertions") cannot be validated against PROD until PROD's exact `prosrc` is diffed against a known lineage.
* The repository candidates (LF-normalised `prosrc` md5) are listed in §4 so that the nearest ancestor can be identified.

## 3. What is needed to close the `create_order` difference (Dirac / PROD read-only)

```sql
-- 1) exact source, to a file (function source is not sensitive)
select prosrc from pg_proc
where oid = 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)'::regprocedure;

-- 2) canonical fingerprints + properties
select md5(prosrc)                              as md5_raw,
       md5(replace(prosrc, E'\r\n', E'\n'))     as md5_lf,
       length(prosrc), prosecdef, proconfig, proacl,
       md5(pg_get_functiondef(oid))             as md5_functiondef
from pg_proc
where oid = 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)'::regprocedure;

-- 3) other overloads under the same name (a stale overload would matter)
select oid::regprocedure from pg_proc
where proname = 'create_order' and pronamespace = 'public'::regnamespace;
```
Then, in a checkout of this branch:
```
python3 -I supabase/tests/prod-predecessor-compare.py create_order prod-create_order.prosrc --refs
```
It prints exact equality (raw or line-ending-normalised) or the three nearest candidates and the unified diff against the nearest one. If the source cannot leave PROD, per-line hashes are enough to rank candidates:
```sql
select n, md5(l) from regexp_split_to_table(replace(prosrc, E'\r\n', E'\n'), E'\n') with ordinality t(l, n)
```

Until this is done: **no `create_order` replacement intended for PROD may be produced** (CTO instruction F). Contract §8 gives the fingerprint-independent alternative.

## 4. Repository `create_order` candidates (`md5` of LF-normalised `prosrc`)

| md5 (LF) | Defined in |
|---|---|
| `323a3c84…` / `a674d488…` | `migration-orders.sql` |
| `e4cbdf47…` | `migration-orders-lang.sql` |
| `cbf8e290…` | `migration-v65-order-note.sql` |
| `67b367d2…` | `migration-lotd-establishment-creation.sql` |
| `30ef80e7…` | `migration-v82-lot2a-sale-modes.sql` |
| `01c7fba1…` | `DRAFT-lot-product-service-modes-v1.sql` |
| `6fbbee8d…` | `DRAFT-lot-server-delivery-fulfillment-pricing.sql` |
| `59fcf37e…` / `deb03538…` | `DRAFT-lot-payment-p3b6-checkout-billing-context.sql` |
| `650ae2cc…` | `DRAFT-lot-receipt-invoice-tax-detail-v1.sql` |
| `101c2be3…` | `DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql` |
| `3319cc1b…` | `DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql` |
| `ccbff371…` / `d048c6f4…` | `DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql` |
| `768dffa6…` | `DRAFT-lot-customer-followup-tracking-email-v1.sql` |
| `688bab18…` | `DRAFT-lot-delivery-country-scope-v1.sql` |
| `cbc4b1e5…` | `DRAFT-lot-delivery-financial-persistence-foundation-v1.sql` |
| `a6974421…` | `DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1.sql` (B1) |

(The B1 / B5 header comments quote `md5(pg_get_functiondef(...))` values, a different quantity; they are not comparable to the hashes above.)

The chain states observed in the Boulez harness, file by file, for `create_order`: `…orders-lang e4cbdf47` → `v65 cbf8e290` → `lotd 67b367d2` → `v82 30ef80e7` → `server-delivery-fulfillment-pricing 6fbbee8d` → `p3b6 59fcf37e` → `receipt-invoice-tax-detail 650ae2cc` → `cgv v1.1 101c2be3` → `n1a 3319cc1b` → `cgv v2.5 ccbff371` (final). `update_order_status` is `96d49784…` from v29 onward and never changes.
