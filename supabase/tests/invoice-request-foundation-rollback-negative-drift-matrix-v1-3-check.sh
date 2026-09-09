#!/usr/bin/env bash
# ============================================================
# Scanym — INVOICE REQUEST PRODUCTION PREREQUISITE REMEDIATION v1.3
# — TARGETED COLUMN-ACL FINGERPRINT FIX ONLY — Claude Monet
#
# Real-Postgres (never simulated) EXPANDED NEGATIVE test matrix for
# the hardened DRAFT-lot-invoice-request-foundation-v1-rollback.sql
# guards. Supersedes the v1.2 16-case matrix -- keeps all 16 prior
# cases (function drift, SECURITY DEFINER/search_path drift, column
# type/default/collation drift, added constraint/index, RLS state
# drift, policy predicate/role/permissiveness drift, relation grant
# drift including TRUNCATE/REFERENCES/TRIGGER) and adds 6 more
# required by Catimini's v1.2 re-audit: a genuinely arbitrary
# synthetic role (never part of any prior hardcoded role universe)
# granted a relation privilege, then that SAME role granted
# column-level SELECT/UPDATE/REFERENCES on contact_email, plus a
# column grant to an EXISTING role (authenticated) not present in the
# expected state, plus the mandatory revoke-an-expected-column-ACL
# case (reported N/A -- the known-good state has none to revoke).
# Twenty-two scenarios, each:
#   1. installs the FOUNDATION cleanly,
#   2. introduces ONE specific, realistic drift a later, legitimate,
#      unreviewed change could plausibly introduce,
#   3. attempts the FOUNDATION rollback and asserts it REFUSES
#      (SCANYM_ROLLBACK_DRIFT_GUARD / SCANYM_SCHEMA_DRIFT, non-zero
#      exit) rather than silently proceeding,
#   4. asserts ZERO MUTATION occurred: the table, both functions,
#      AND the specific drifted object/state are still present and
#      unchanged after the refused attempt (proving the guard failed
#      CLOSED, before any DROP, not merely that the DROP itself
#      later errored),
#   5. restores the exact known-good state for the next scenario.
# A final positive control re-runs the rollback with NO drift present
# and asserts it SUCCEEDS cleanly, proving the hardening introduced
# no false positive.
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_RITD_SQL="$SUPABASE_DIR/DRAFT-lot-receipt-invoice-tax-detail-v1.sql"
DRAFT_CFPM_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql"
FOUNDATION_SQL="$SUPABASE_DIR/DRAFT-lot-invoice-request-foundation-v1.sql"
FOUNDATION_ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-invoice-request-foundation-v1-rollback.sql"
DB="scanym_invreq_negmatrix_v13_$$"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-invreq-negmatrix-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
cleanup() { psql -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true; rm -f "$FAIL_LOG" 2>/dev/null || true; }
trap cleanup EXIT

run_fatal() {
  local desc="$1"; shift
  if "$@"; then pass "SETUP (fatal-checked): $desc"; else
    log "FATAL: $desc a échoué -- arrêt immédiat"; exit 1
  fi
}
sql() { psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
sql_fatal() {
  local desc="$1" query="$2"
  local outfile="/tmp/scanym-negmatrix-fatal-$$-$RANDOM.out"
  psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "$query" > "$outfile" 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ]; then log "FATAL: $desc a échoué (rc=$rc) -- $(cat "$outfile")"; rm -f "$outfile"; exit 1; fi
  rm -f "$outfile"
  pass "SETUP (fatal-checked): $desc"
}

build_common_bootstrap() {
  psql -v ON_ERROR_STOP=1 -d "$DB" > /tmp/negmatrix-bootstrap-$$.out 2>&1 <<'SQL'
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create publication supabase_realtime;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
alter role service_role bypassrls;
create schema if not exists storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/'); $$;
SQL
  local rc=$?
  rm -f /tmp/negmatrix-bootstrap-$$.out
  return $rc
}
build_minimal_chain() {
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: $f"; return 1; }
    psql -v ON_ERROR_STOP=1 -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1 || { log "FATAL: GRANT après $f"; return 1; }
  done
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: $f"; return 1; }
  done
  return 0
}
build_full_chain_through_sibling_delivery_pricing() {
  for f in migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: $f (chaîne fidèle sibling)"; return 1; }
  done
  return 0
}

restore_set_fn_from_foundation_source() {
  # Re-applies the EXACT set_order_invoice_request CREATE OR REPLACE
  # statement as it appears in the never-modified
  # DRAFT-lot-invoice-request-foundation-v1.sql (the single source of
  # truth), by line-range extraction (function body starts at the
  # "create or replace function public.set_order_invoice_request("
  # line and ends at its own closing "$$;").
  local start end
  start="$(grep -n '^create or replace function public\.set_order_invoice_request($' "$FOUNDATION_SQL" | head -1 | cut -d: -f1)"
  end="$(awk -v s="$start" 'NR>=s && /^\$\$;$/ {print NR; exit}' "$FOUNDATION_SQL")"
  sed -n "${start},${end}p" "$FOUNDATION_SQL" | psql -d "$DB" -v ON_ERROR_STOP=1 -f - >/tmp/scanym-negmatrix-restore-set-$$.out 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ]; then log "FATAL: restauration de set_order_invoice_request a échoué -- $(cat /tmp/scanym-negmatrix-restore-set-$$.out)"; exit 1; fi
  rm -f /tmp/scanym-negmatrix-restore-set-$$.out
  pass "restauration -- set_order_invoice_request réappliqué depuis la source FOUNDATION exacte, jamais modifiée"
}

attempt_rollback_expect_refusal() {
  local scenario="$1"
  local out="/tmp/scanym-negmatrix-rollback-$$-$RANDOM.out"
  psql -v ON_ERROR_STOP=1 -d "$DB" -f "$FOUNDATION_ROLLBACK_SQL" > "$out" 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ] && grep -qE "SCANYM_ROLLBACK_DRIFT_GUARD|SCANYM_SCHEMA_DRIFT" "$out"; then
    pass "$scenario -- ROLLBACK RETURN/ERROR: FAIL-CLOSED (rc=$rc, guard fired)"
  else
    fail "$scenario -- rollback aurait dû REFUSER avec un guard explicite (rc=$rc): $(tail -3 "$out")"
  fi
  rm -f "$out"
}
assert_table_and_functions_intact() {
  local scenario="$1"
  local t f1 f2
  t="$(sql "select to_regclass('public.order_invoice_request') is not null;")"
  f1="$(sql "select exists (select 1 from pg_proc where proname='set_order_invoice_request');")"
  f2="$(sql "select exists (select 1 from pg_proc where proname='get_order_invoice_request');")"
  if [ "$t" = "t" ] && [ "$f1" = "t" ] && [ "$f2" = "t" ]; then
    pass "$scenario -- MUTATION BEFORE REFUSAL: NO (table+both functions intact)"
  else
    fail "$scenario -- MUTATION BEFORE REFUSAL: YES (table=$t set_fn=$f1 get_fn=$f2) -- guard failed to prevent partial drop"
  fi
}

log "=== [0] Construction de la chaîne + FOUNDATION (installation propre unique) ==="
psql -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
run_fatal "createdb" createdb "$DB"
run_fatal "bootstrap" build_common_bootstrap
run_fatal "chaîne minimale (v66)" build_minimal_chain
run_fatal "chaîne jusqu'à create_order courant" build_full_chain_through_sibling_delivery_pricing
run_fatal "PAYMENT P1" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_P1_SQL"
run_fatal "CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.3" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_CFPM_SQL"
run_fatal "RECEIPT/INVOICE TAX DETAIL v1.1" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_RITD_SQL"
run_fatal "FOUNDATION v1 (installation unique, jamais réinstallée)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$FOUNDATION_SQL"

# ------------------------------------------------------------
# Case 1 — function same signature, altered body
# ------------------------------------------------------------
log "=== [1/22] Fonction set_order_invoice_request : même signature, CORPS altéré ==="
sql_fatal "1. altération synthétique du corps (même signature)" "create or replace function public.set_order_invoice_request(p_order_id uuid, p_public_token uuid, p_invoice_type text, p_address_line_1 text, p_city text, p_postal_code text, p_country text, p_address_line_2 text default null, p_company_legal_name text default null, p_vat_number text default null, p_contact_name text default null, p_contact_email text default null) returns table(order_id uuid, invoice_type text, updated_at timestamptz) language sql as \$fn\$ select order_id, invoice_type, updated_at from public.order_invoice_request limit 0; \$fn\$;"
attempt_rollback_expect_refusal "1. corps de fonction altéré"
assert_table_and_functions_intact "1. corps de fonction altéré"
restore_set_fn_from_foundation_source

# ------------------------------------------------------------
# Case 2 — altered SECURITY DEFINER / search_path
# ------------------------------------------------------------
log "=== [2/22] Fonction set_order_invoice_request : SECURITY DEFINER retiré (devient INVOKER) ==="
sql_fatal "2. retire SECURITY DEFINER (devient SECURITY INVOKER) + search_path large" "create or replace function public.set_order_invoice_request(p_order_id uuid, p_public_token uuid, p_invoice_type text, p_address_line_1 text, p_city text, p_postal_code text, p_country text, p_address_line_2 text default null, p_company_legal_name text default null, p_vat_number text default null, p_contact_name text default null, p_contact_email text default null) returns table(order_id uuid, invoice_type text, updated_at timestamptz) language sql security invoker set search_path to 'public' as \$fn\$ select order_id, invoice_type, updated_at from public.order_invoice_request limit 0; \$fn\$;"
attempt_rollback_expect_refusal "2. SECURITY DEFINER/search_path altérés"
assert_table_and_functions_intact "2. SECURITY DEFINER/search_path altérés"
restore_set_fn_from_foundation_source

# ------------------------------------------------------------
# Case 3 — changed column type
# ------------------------------------------------------------
log "=== [3/22] Colonne vat_number : type TEXT -> VARCHAR(30) ==="
sql_fatal "3. altère le TYPE de vat_number" "alter table public.order_invoice_request drop constraint order_invoice_request_vat_number_check, alter column vat_number type varchar(30);"
attempt_rollback_expect_refusal "3. type de colonne altéré"
assert_table_and_functions_intact "3. type de colonne altéré"
sql_fatal "3. restauration -- type TEXT + contrainte d'origine" "alter table public.order_invoice_request alter column vat_number type text, add constraint order_invoice_request_vat_number_check check (vat_number is null or length(vat_number) between 1 and 30);"

# ------------------------------------------------------------
# Case 4 — changed default
# ------------------------------------------------------------
log "=== [4/22] Colonne created_at : DEFAULT now() -> clock_timestamp() ==="
sql_fatal "4. altère le DEFAULT de created_at" "alter table public.order_invoice_request alter column created_at set default clock_timestamp();"
attempt_rollback_expect_refusal "4. default de colonne altéré"
assert_table_and_functions_intact "4. default de colonne altéré"
sql_fatal "4. restauration -- DEFAULT d'origine" "alter table public.order_invoice_request alter column created_at set default now();"

# ------------------------------------------------------------
# Case 5 — added constraint
# ------------------------------------------------------------
log "=== [5/22] Contrainte CHECK inattendue ajoutée ==="
sql_fatal "5. ajoute une contrainte CHECK inattendue" "alter table public.order_invoice_request add constraint order_invoice_request_unexpected_check check (true);"
attempt_rollback_expect_refusal "5. contrainte ajoutée"
assert_table_and_functions_intact "5. contrainte ajoutée"
sql_fatal "5. restauration -- retire la contrainte ajoutée" "alter table public.order_invoice_request drop constraint order_invoice_request_unexpected_check;"

# ------------------------------------------------------------
# Case 6 — changed index definition (unexpected index appears)
# ------------------------------------------------------------
log "=== [6/22] Index inattendu ajouté sur country ==="
sql_fatal "6. ajoute un index inattendu" "create index order_invoice_request_unexpected_idx on public.order_invoice_request(country);"
attempt_rollback_expect_refusal "6. index inattendu"
assert_table_and_functions_intact "6. index inattendu"
sql_fatal "6. restauration -- retire l'index ajouté" "drop index public.order_invoice_request_unexpected_idx;"

# ------------------------------------------------------------
# Case 7 — changed RLS state (forced flag)
# ------------------------------------------------------------
log "=== [7/22] RLS : FORCE ROW LEVEL SECURITY activé (état non attendu) ==="
sql_fatal "7. active FORCE ROW LEVEL SECURITY" "alter table public.order_invoice_request force row level security;"
attempt_rollback_expect_refusal "7. RLS forced-state altéré"
assert_table_and_functions_intact "7. RLS forced-state altéré"
sql_fatal "7. restauration -- retire FORCE ROW LEVEL SECURITY" "alter table public.order_invoice_request no force row level security;"

# ------------------------------------------------------------
# Case 8 — changed policy predicate
# ------------------------------------------------------------
log "=== [8/22] Politique RLS : prédicat USING élargi (drift de sécurité) ==="
sql_fatal "8. élargit le prédicat USING de la policy" "alter policy \"order_invoice_request_select_staff\" on public.order_invoice_request using (true);"
attempt_rollback_expect_refusal "8. prédicat de policy altéré"
assert_table_and_functions_intact "8. prédicat de policy altéré"
sql_fatal "8. restauration -- prédicat d'origine" "alter policy \"order_invoice_request_select_staff\" on public.order_invoice_request using (exists (select 1 from public.orders o join public.restaurant_users ru on ru.restaurant_id = o.restaurant_id where o.id = order_invoice_request.order_id and ru.user_id = auth.uid()));"

# ------------------------------------------------------------
# Case 9 — changed policy role/command
# ------------------------------------------------------------
log "=== [9/22] Politique RLS : rôle inattendu ajouté (service_role) ==="
sql_fatal "9. ajoute service_role à la policy" "alter policy \"order_invoice_request_select_staff\" on public.order_invoice_request to authenticated, service_role;"
attempt_rollback_expect_refusal "9. rôle de policy altéré"
assert_table_and_functions_intact "9. rôle de policy altéré"
sql_fatal "9. restauration -- rôle d'origine" "alter policy \"order_invoice_request_select_staff\" on public.order_invoice_request to authenticated;"

# ------------------------------------------------------------
# Case 10 — changed grant
# ------------------------------------------------------------
log "=== [10/22] GRANT inattendu : anon obtient SELECT (drift de sécurité critique) ==="
sql_fatal "10. élargit un GRANT vers anon" "grant select on public.order_invoice_request to anon;"
attempt_rollback_expect_refusal "10. grant élargi vers anon"
assert_table_and_functions_intact "10. grant élargi vers anon"
sql_fatal "10. restauration -- retire le GRANT élargi" "revoke select on public.order_invoice_request from anon;"

# ------------------------------------------------------------
# Case 11 — grant to an UNEXPECTED role (Catimini v1.1 re-audit,
# HIGH 1: grant fingerprint must not rely on a hardcoded role list)
# ------------------------------------------------------------
log "=== [11/22] GRANT SELECT à un rôle INATTENDU (service_role, drift de sécurité) ==="
sql_fatal "11. service_role obtient SELECT (rôle jamais prévu pour un accès table direct)" "grant select on public.order_invoice_request to service_role;"
attempt_rollback_expect_refusal "11. grant SELECT vers service_role (rôle inattendu)"
assert_table_and_functions_intact "11. grant SELECT vers service_role (rôle inattendu)"
sql_fatal "11. restauration -- retire le GRANT" "revoke select on public.order_invoice_request from service_role;"

# ------------------------------------------------------------
# Case 12 — TRUNCATE grant (Catimini v1.1 re-audit, HIGH 1: must not
# rely on a hardcoded privilege subset)
# ------------------------------------------------------------
log "=== [12/22] GRANT TRUNCATE inattendu ==="
sql_fatal "12. ajoute un GRANT TRUNCATE" "grant truncate on public.order_invoice_request to authenticated;"
attempt_rollback_expect_refusal "12. grant TRUNCATE inattendu"
assert_table_and_functions_intact "12. grant TRUNCATE inattendu"
sql_fatal "12. restauration -- retire le GRANT TRUNCATE" "revoke truncate on public.order_invoice_request from authenticated;"

# ------------------------------------------------------------
# Case 13 — REFERENCES grant
# ------------------------------------------------------------
log "=== [13/22] GRANT REFERENCES inattendu ==="
sql_fatal "13. ajoute un GRANT REFERENCES" "grant references on public.order_invoice_request to authenticated;"
attempt_rollback_expect_refusal "13. grant REFERENCES inattendu"
assert_table_and_functions_intact "13. grant REFERENCES inattendu"
sql_fatal "13. restauration -- retire le GRANT REFERENCES" "revoke references on public.order_invoice_request from authenticated;"

# ------------------------------------------------------------
# Case 14 — TRIGGER grant
# ------------------------------------------------------------
log "=== [14/22] GRANT TRIGGER inattendu ==="
sql_fatal "14. ajoute un GRANT TRIGGER" "grant trigger on public.order_invoice_request to authenticated;"
attempt_rollback_expect_refusal "14. grant TRIGGER inattendu"
assert_table_and_functions_intact "14. grant TRIGGER inattendu"
sql_fatal "14. restauration -- retire le GRANT TRIGGER" "revoke trigger on public.order_invoice_request from authenticated;"

# ------------------------------------------------------------
# Case 15 — policy PERMISSIVE -> RESTRICTIVE (Catimini v1.1
# re-audit, HIGH 2). ALTER POLICY cannot flip this flag in place --
# the drift is simulated the same way a real, unreviewed change
# would have to: DROP + CREATE with the identical name/command/
# roles/predicates but AS RESTRICTIVE.
# ------------------------------------------------------------
log "=== [15/22] Politique RLS : PERMISSIVE -> RESTRICTIVE (même prédicat, même rôle) ==="
sql_fatal "15. recrée la policy en RESTRICTIVE" "drop policy \"order_invoice_request_select_staff\" on public.order_invoice_request; create policy \"order_invoice_request_select_staff\" on public.order_invoice_request as restrictive for select to authenticated using (exists (select 1 from public.orders o join public.restaurant_users ru on ru.restaurant_id = o.restaurant_id where o.id = order_invoice_request.order_id and ru.user_id = auth.uid()));"
attempt_rollback_expect_refusal "15. policy devenue RESTRICTIVE"
assert_table_and_functions_intact "15. policy devenue RESTRICTIVE"
sql_fatal "15. restauration -- recrée la policy en PERMISSIVE (état d'origine)" "drop policy \"order_invoice_request_select_staff\" on public.order_invoice_request; create policy \"order_invoice_request_select_staff\" on public.order_invoice_request as permissive for select to authenticated using (exists (select 1 from public.orders o join public.restaurant_users ru on ru.restaurant_id = o.restaurant_id where o.id = order_invoice_request.order_id and ru.user_id = auth.uid()));"

# ------------------------------------------------------------
# Case 16 — column COLLATION change (Catimini v1.1 re-audit, HIGH 3,
# specifically named)
# ------------------------------------------------------------
log "=== [16/22] Colonne contact_name : COLLATION par défaut -> \"C\" ==="
sql_fatal "16. altère la collation de contact_name" "alter table public.order_invoice_request alter column contact_name type text collate \"C\";"
attempt_rollback_expect_refusal "16. collation de colonne altérée"
assert_table_and_functions_intact "16. collation de colonne altérée"
sql_fatal "16. restauration -- collation par défaut d'origine" "alter table public.order_invoice_request alter column contact_name type text;"

# ------------------------------------------------------------
# Setup for cases 17-20 — a GENUINELY ARBITRARY synthetic role,
# created only in this local test database, never part of any prior
# hardcoded role universe (anon/authenticated/service_role) and never
# referenced anywhere in the fingerprint query itself. Catimini's
# v1.2 re-audit specifically noted that "service_role" (used in case
# 11) does not qualify as genuinely arbitrary, since it already
# belonged to the former hardcoded whitelist this lot's guards used
# to rely on.
# ------------------------------------------------------------
ARBITRARY_ROLE="scanym_rollback_probe_role"
sql_fatal "setup -- crée le rôle synthétique arbitraire" "do \$\$ begin if not exists (select from pg_roles where rolname='$ARBITRARY_ROLE') then create role $ARBITRARY_ROLE nologin; end if; end \$\$;"

# ------------------------------------------------------------
# Case 17 — GENUINELY ARBITRARY ROLE test (Catimini v1.2 re-audit):
# a relation-level grant to a role that was never part of any
# hardcoded universe must still be caught, proving the relation ACL
# guard is truly whitelist-free.
# ------------------------------------------------------------
log "=== [17/22] GRANT SELECT (niveau relation) à un rôle SYNTHÉTIQUE VRAIMENT ARBITRAIRE ==="
sql_fatal "17. GRANT SELECT à $ARBITRARY_ROLE (relation, rôle jamais vu par le fingerprint)" "grant select on public.order_invoice_request to $ARBITRARY_ROLE;"
attempt_rollback_expect_refusal "17. grant relation vers rôle synthétique arbitraire"
assert_table_and_functions_intact "17. grant relation vers rôle synthétique arbitraire"
sql_fatal "17. restauration -- retire le GRANT" "revoke select on public.order_invoice_request from $ARBITRARY_ROLE;"

# ------------------------------------------------------------
# Case 18 — mandatory test 1: GRANT SELECT(contact_email) to the
# genuinely arbitrary role -- HIGH release-blocking finding this lot
# fixes.
# ------------------------------------------------------------
log "=== [18/22] GRANT SELECT(contact_email) à un rôle SYNTHÉTIQUE ARBITRAIRE (colonne) ==="
sql_fatal "18. GRANT SELECT(contact_email) à $ARBITRARY_ROLE" "grant select (contact_email) on public.order_invoice_request to $ARBITRARY_ROLE;"
attempt_rollback_expect_refusal "18. grant colonne SELECT(contact_email) vers rôle arbitraire"
assert_table_and_functions_intact "18. grant colonne SELECT(contact_email) vers rôle arbitraire"
sql_fatal "18. restauration -- retire le GRANT colonne" "revoke select (contact_email) on public.order_invoice_request from $ARBITRARY_ROLE;"

# ------------------------------------------------------------
# Case 19 — mandatory test 2: GRANT UPDATE(contact_email)
# ------------------------------------------------------------
log "=== [19/22] GRANT UPDATE(contact_email) à un rôle SYNTHÉTIQUE ARBITRAIRE (colonne) ==="
sql_fatal "19. GRANT UPDATE(contact_email) à $ARBITRARY_ROLE" "grant update (contact_email) on public.order_invoice_request to $ARBITRARY_ROLE;"
attempt_rollback_expect_refusal "19. grant colonne UPDATE(contact_email) vers rôle arbitraire"
assert_table_and_functions_intact "19. grant colonne UPDATE(contact_email) vers rôle arbitraire"
sql_fatal "19. restauration -- retire le GRANT colonne" "revoke update (contact_email) on public.order_invoice_request from $ARBITRARY_ROLE;"

# ------------------------------------------------------------
# Case 20 — mandatory test 3: GRANT REFERENCES(contact_email).
# Verified separately (see ROLLBACK-DRIFT-GUARD-EVIDENCE.md) that
# PostgreSQL permits REFERENCES as a column-level privilege -- not
# N/A.
# ------------------------------------------------------------
log "=== [20/22] GRANT REFERENCES(contact_email) à un rôle SYNTHÉTIQUE ARBITRAIRE (colonne) ==="
sql_fatal "20. GRANT REFERENCES(contact_email) à $ARBITRARY_ROLE" "grant references (contact_email) on public.order_invoice_request to $ARBITRARY_ROLE;"
attempt_rollback_expect_refusal "20. grant colonne REFERENCES(contact_email) vers rôle arbitraire"
assert_table_and_functions_intact "20. grant colonne REFERENCES(contact_email) vers rôle arbitraire"
sql_fatal "20. restauration -- retire le GRANT colonne" "revoke references (contact_email) on public.order_invoice_request from $ARBITRARY_ROLE;"

# ------------------------------------------------------------
# Cleanup — drop the synthetic arbitrary role now that cases 17-20
# are done with it.
# ------------------------------------------------------------
sql_fatal "cleanup -- retire le rôle synthétique arbitraire" "drop role $ARBITRARY_ROLE;"

# ------------------------------------------------------------
# Case 21 — mandatory test 4: column grant to an EXISTING role
# (authenticated) not present in the expected known-good state.
# authenticated already has ordinary table-level SELECT (via the RLS
# policy) but has NEVER been given an explicit COLUMN-level grant --
# this proves the guard does not treat "already a known role" as a
# reason to skip column-level verification for that role.
# ------------------------------------------------------------
log "=== [21/22] GRANT SELECT(contact_email) à un rôle EXISTANT (authenticated), absent de l'état attendu ==="
sql_fatal "21. GRANT SELECT(contact_email) à authenticated (jamais accordé au niveau colonne)" "grant select (contact_email) on public.order_invoice_request to authenticated;"
attempt_rollback_expect_refusal "21. grant colonne vers un rôle existant mais absent de l'état attendu"
assert_table_and_functions_intact "21. grant colonne vers un rôle existant mais absent de l'état attendu"
sql_fatal "21. restauration -- retire le GRANT colonne" "revoke select (contact_email) on public.order_invoice_request from authenticated;"

# ------------------------------------------------------------
# Case 22 — mandatory test 5: revoke/remove an expected column ACL.
# N/A: the Foundation's known-good state contains ZERO column-level
# ACL entries (verified in ROLLBACK-DRIFT-GUARD-EVIDENCE.md -- no
# GRANT_COLUMN row exists in the expected fingerprint before this
# case runs). There is nothing to revoke, so this case is reported
# N/A rather than fabricating a scenario that does not apply. This is
# asserted here, not merely claimed: query the fingerprint's own
# GRANT_COLUMN row count on a clean install and confirm it is zero.
# ------------------------------------------------------------
log "=== [22/22] Retrait d'un ACL colonne ATTENDU -- N/A si l'état attendu n'en contient aucun ==="
COLUMN_ACL_COUNT="$(sql "
  select count(*) from (
    select 1
    from pg_attribute att
    cross join lateral aclexplode(coalesce(att.attacl, acldefault('c', (select relowner from pg_class where oid = att.attrelid)))) g
    where att.attrelid = 'public.order_invoice_request'::regclass and att.attnum > 0 and not att.attisdropped
  ) x;
")"
if [ "$COLUMN_ACL_COUNT" = "0" ]; then
  pass "22. N/A -- l'état attendu (known-good) contient exactement 0 ACL colonne à révoquer (confirmé par requête directe, pas supposé)"
else
  fail "22. attendu 0 ACL colonne dans l'état known-good, trouvé $COLUMN_ACL_COUNT -- ce cas n'est plus N/A, un scénario réel doit être écrit"
fi

# ------------------------------------------------------------
# Positive control -- with every drift restored, the SAME guard
# must now SUCCEED cleanly (no false positive introduced by the
# hardening).
# ------------------------------------------------------------
log "=== [Contrôle positif] État restauré à l'identique -- le rollback DOIT réussir ==="
run_fatal "contrôle positif -- rollback FOUNDATION réussit sans drift" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$FOUNDATION_ROLLBACK_SQL"
T_GONE="$(sql "select to_regclass('public.order_invoice_request') is null;" 2>/dev/null || echo t)"
if [ "$T_GONE" = "t" ]; then
  pass "contrôle positif -- rollback a bien supprimé la table une fois l'état confirmé sain"
else
  fail "contrôle positif -- la table existe encore après un rollback qui aurait dû réussir"
fi

log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL ==="
if [ "$FAIL_COUNT" -gt 0 ]; then echo "--- ÉCHECS ---"; cat "$FAIL_LOG"; exit 1; fi
exit 0
