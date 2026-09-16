-- =============================================================================
-- ROLLBACK — SELLER LEGAL PROFILE + CGV ENGINE v2.1 (ENRICHMENT CYCLE)
--
-- Baseline: yakoutmokhfi-ui/scandz, origin
--   SHA  e4c90f4f57ba37b46ab388e05847fd57610275a3
--   TREE 30643c6c0a236cca5babe7e5baaf9afcf17695f5
--
-- WHY THIS FILE EXISTS (rather than relying on the pre-existing v1.2
-- rollback alone): the pre-existing DRAFT-lot-seller-legal-profile-cgv-
-- engine-v1-2-rollback.sql was written before v2.1's columns/functions
-- existed, and it DOES still handle most of v2.1's own footprint
-- correctly, by construction:
--   - it `drop table`s merchant_legal_profile/merchant_cgv_profile/
--     cgv_template outright, which removes v2.1's 8 new columns and the
--     new template-version-2 row automatically (a dropped table takes
--     every one of its columns and rows with it, regardless of when
--     they were added);
--   - it `drop function`s persist_merchant_cgv_version(uuid,uuid,text,
--     text,uuid), _compute_cgv_publication_context_fingerprint(uuid),
--     resolve_cgv_publication_context(uuid) and get_merchant_cgv_
--     profile(uuid) by exact INPUT-argument-type list -- PostgreSQL
--     resolves DROP FUNCTION by (schema, name, input argument types)
--     ONLY, never by return type/RETURNS TABLE column list, so these 4
--     statements still correctly match and drop v2.1's versions of
--     these functions even though their RETURN shape changed.
-- BUT it does NOT correctly handle the two functions whose INPUT
-- argument list itself changed:
--   - update_merchant_legal_profile: v1.2's rollback names the OLD
--     12-argument signature. v2.1 replaced it with an 18-argument
--     signature (DROP + CREATE, see the forward migration). The old
--     rollback's `drop function if exists ...(uuid,text,text,text,
--     text,text,text,text,text,text,text,text)` (12 args) does NOT
--     match the new 18-arg function -- IF EXISTS makes it a silent
--     no-op, and the 18-arg function survives the "rollback",
--     orphaned, referencing a table (merchant_legal_profile) the same
--     rollback goes on to drop a few statements later.
--   - update_merchant_cgv_profile: identical problem, 8-arg vs 10-arg.
-- Confirmed by this cycle's own harness (see supabase/tests/seller-
-- legal-profile-cgv-engine-v2-1-check.sh, [ROLLBACK] section): applying
-- the v1.2 rollback alone, on top of the full v1.1..v2.1 chain, leaves
-- exactly these two 18-/10-argument functions behind. This file exists
-- to close exactly that gap -- and nothing else: it does NOT repeat any
-- of the v1.2 rollback's own statements (they are correct and already
-- run first), it only drops the two functions the old file cannot name.
--
-- USAGE: run the EXISTING v1.2 rollback FIRST (it undoes everything
-- through v1.4 and most of v2.1's own footprint), THEN this file
-- (which only cleans up the two orphaned new-signature functions it
-- would otherwise leave behind). Running this file without having run
-- the v1.2 rollback first is harmless (both DROPs are IF EXISTS) but
-- leaves everything else in place -- it is not a substitute for the
-- v1.2 rollback, only a small addendum to it.
-- =============================================================================

begin;

drop function if exists public.update_merchant_legal_profile(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text);
drop function if exists public.update_merchant_cgv_profile(uuid,text,integer,integer,text,text,text,text,boolean,text);

commit;
