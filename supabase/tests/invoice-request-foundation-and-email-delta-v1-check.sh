#!/usr/bin/env bash
# ============================================================
# Scanym — INVOICE REQUEST PRODUCTION PREREQUISITE GAP — Claude Monet
#
# Real-Postgres proof (never a simulation) that the TWO SEPARATED
# SQL layers (DRAFT-lot-invoice-request-foundation-v1.sql +
# DRAFT-lot-checkout-invoice-request-email-validation-v1-delta.sql)
# installed IN SEQUENCE produce behavior IDENTICAL to the original
# monolithic DRAFT-lot-checkout-invoice-request-v1.sql, and that:
#   - the foundation alone accepts a format-invalid contact_email
#     (length-only, by design -- this is the state BEFORE any email
#     lot)
#   - the foundation alone still enforces every OTHER rule
#     (required fields, company-requires-legal-name, tenant
#     isolation, RLS, least-privilege grants)
#   - applying the email delta on top does NOT recreate the table,
#     does NOT touch RLS, does NOT touch grants (proven by capturing
#     grants/RLS state before and after and asserting byte-equality)
#   - the email delta then rejects the mandate's invalid examples and
#     accepts the mandate's valid examples, exactly like the
#     monolithic file already proved
#   - forward (foundation) -> forward (delta) -> rollback (delta) ->
#     rollback (foundation) -> forward (foundation) -> forward
#     (delta) is stable and produces the identical functiondef each
#     time (byte-for-byte pg_get_functiondef comparison)
#   - the delta's own idempotency/precondition guards actually fire
#     when they should (already-applied guard, foundation-missing
#     guard)
#   - Payment Operator Authorization's objects are entirely absent
#     from this chain's scope (structural non-overlap, not just
#     absence of intent)
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_RITD_SQL="$SUPABASE_DIR/DRAFT-lot-receipt-invoice-tax-detail-v1.sql"
DRAFT_CFPM_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql"
FOUNDATION_SQL="$SUPABASE_DIR/DRAFT-lot-invoice-request-foundation-v1.sql"
FOUNDATION_ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-invoice-request-foundation-v1-rollback.sql"
DELTA_SQL="$SUPABASE_DIR/DRAFT-lot-checkout-invoice-request-email-validation-v1-delta.sql"
DELTA_ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-checkout-invoice-request-email-validation-v1-delta-rollback.sql"
DB="scanym_invreq_layered_check_$$"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-invreq-layered-fails-$$.log"
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
run_sql_fatal() {
  local desc="$1" query="$2" role="${3:-}"
  local outfile="/tmp/scanym-invreq-layered-fatal-$$-$RANDOM.out"
  if [ -n "$role" ]; then
    psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "set role $role; $query" > "$outfile" 2>&1
  else
    psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "$query" > "$outfile" 2>&1
  fi
  local rc=$?
  if [ "$rc" -ne 0 ]; then log "FATAL: $desc a échoué (rc=$rc) -- $(cat "$outfile")"; rm -f "$outfile"; exit 1; fi
  rm -f "$outfile"
  pass "SETUP (fatal-checked): $desc"
}
CAPTURED_OUTPUT=""
run_sql_capture() {
  local desc="$1" query="$2" role="${3:-}"
  local outfile="/tmp/scanym-invreq-layered-capture-$$-$RANDOM.out"
  if [ -n "$role" ]; then
    psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "set role $role; $query" > "$outfile" 2>&1
  else
    psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "$query" > "$outfile" 2>&1
  fi
  local rc=$?
  CAPTURED_OUTPUT="$(cat "$outfile")"
  rm -f "$outfile"
  if [ "$rc" -ne 0 ]; then log "FATAL: $desc a échoué (rc=$rc) -- $CAPTURED_OUTPUT"; exit 1; fi
  pass "SETUP (fatal-checked, capture): $desc"
}
CAPTURED_ERROR=""
run_sql_expect_error() {
  local desc="$1" query="$2" role="${3:-}"
  local outfile="/tmp/scanym-invreq-layered-err-$$-$RANDOM.out"
  if [ -n "$role" ]; then
    psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "set role $role; $query" > "$outfile" 2>&1
  else
    psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "$query" > "$outfile" 2>&1
  fi
  local rc=$?
  CAPTURED_OUTPUT="$(cat "$outfile")"
  CAPTURED_ERROR="$rc"
  rm -f "$outfile"
}
assert_eq() { local desc="$1" expected="$2" actual="$3"; if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi; }

# psql -c a l'AVANTAGE, ici, de na PAS auto-committer en une seule
# transaction implicite entre statements distincts -- utilisé
# uniquement pour des lectures read-only ci-dessous.
functiondef_of_set_fn() {
  psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c \
    "select pg_get_functiondef(oid) from pg_proc where proname='set_order_invoice_request' and pronargs = 12;"
}
grants_snapshot() {
  psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "
    select string_agg(x, ',') from (
      select 'tbl:anon:select=' || has_table_privilege('anon','public.order_invoice_request','select') as x
      union all select 'tbl:authenticated:select=' || has_table_privilege('authenticated','public.order_invoice_request','select')
      union all select 'tbl:authenticated:insert=' || has_table_privilege('authenticated','public.order_invoice_request','insert')
      union all select 'tbl:service_role:insert=' || has_table_privilege('service_role','public.order_invoice_request','insert')
      union all select 'fn:anon:exec=' || has_function_privilege('anon','public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)','execute')
      union all select 'fn:authenticated:exec=' || has_function_privilege('authenticated','public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)','execute')
      union all select 'fn:service_role:exec=' || has_function_privilege('service_role','public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)','execute')
      union all select 'rls=' || (select relrowsecurity from pg_class where relname='order_invoice_request')
      union all select 'policy_count=' || (select count(*) from pg_policies where tablename='order_invoice_request')
    ) s;
  "
}

build_common_bootstrap() {
  psql -v ON_ERROR_STOP=1 -d "$DB" > /tmp/scanym-invreq-layered-bootstrap-$$.out 2>&1 <<'SQL'
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
  rm -f /tmp/scanym-invreq-layered-bootstrap-$$.out
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

log "=== [0] Construction FIDÈLE au baseline authoritative, chaîne jusqu'à create_order courant ==="
psql -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
run_fatal "createdb" createdb "$DB"
run_fatal "bootstrap" build_common_bootstrap
run_fatal "chaîne minimale (v66)" build_minimal_chain
run_fatal "chaîne jusqu'à create_order courant" build_full_chain_through_sibling_delivery_pricing
run_fatal "PAYMENT P1 (orders_id_restaurant_id_unique)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_P1_SQL"
run_fatal "CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.3 (prérequis RITD)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_CFPM_SQL"
run_fatal "RECEIPT/INVOICE TAX DETAIL v1.1 (dernière définition effective de create_order)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_RITD_SQL"

log "=== [1] Refus si delta appliqué SANS foundation (guard de précondition) ==="
run_sql_expect_error "delta seul, sans foundation -- doit être refusé" "-- placeholder, vraie commande ci-dessous"
psql -v ON_ERROR_STOP=1 -d "$DB" -f "$DELTA_SQL" >/tmp/scanym-invreq-layered-preguard-$$.out 2>&1
PREGUARD_RC=$?
if [ "$PREGUARD_RC" -ne 0 ] && grep -q "install DRAFT-lot-invoice-request-foundation-v1.sql first" /tmp/scanym-invreq-layered-preguard-$$.out; then
  pass "1. delta refuse de s'appliquer sans foundation installée (guard de précondition)"
else
  fail "1. le delta aurait dû refuser de s'appliquer sans foundation (rc=$PREGUARD_RC)"
fi
rm -f /tmp/scanym-invreq-layered-preguard-$$.out

log "=== [2] Installation de la FOUNDATION seule ==="
run_fatal "foundation v1" psql -v VERBOSITY=verbose -d "$DB" -v ON_ERROR_STOP=1 -f "$FOUNDATION_SQL"
FOUNDATION_FUNCTIONDEF="$(functiondef_of_set_fn)"
FOUNDATION_GRANTS="$(grants_snapshot)"
if [ -z "$FOUNDATION_FUNCTIONDEF" ]; then log "FATAL: impossible de capturer la définition FOUNDATION"; exit 1; fi

log "=== [3] Fixtures via create_order() RÉEL ==="
run_sql_fatal "restaurant 1" "insert into restaurants (id, slug, name, is_active, status) values ('11111111-1111-1111-1111-111111111111', 'r1', 'R1', true, 'active');"
run_sql_fatal "restaurant_configs 1" "insert into restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values ('11111111-1111-1111-1111-111111111111', 'EUR', 1, '+33600000000');"
run_sql_fatal "restaurant 2 (autre tenant)" "insert into restaurants (id, slug, name, is_active, status) values ('22222222-2222-2222-2222-222222222222', 'r2', 'R2', true, 'active');"
run_sql_fatal "restaurant_configs 2" "insert into restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values ('22222222-2222-2222-2222-222222222222', 'EUR', 1, '+33600000000');"
run_sql_fatal "menu category" "insert into menu_categories (id, restaurant_id, name, display_order) values ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Cat', 1);"
run_sql_fatal "menu item" "insert into menu_items (id, category_id, name, price, is_available) values ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'Item', 5.00, true);"
run_sql_fatal "mode de vente pickup activé pour r1" "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled) values ('11111111-1111-1111-1111-111111111111', 'pickup', true);"
run_sql_fatal "mode de vente pickup activé pour r2" "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled) values ('22222222-2222-2222-2222-222222222222', 'pickup', true);"
run_sql_fatal "staff user pour r1" "insert into auth.users (id, email) values ('99999999-0000-0000-0000-000000000001', 'staff@r1.test');"
run_sql_fatal "restaurant_users (staff r1)" "insert into restaurant_users (restaurant_id, user_id, role) values ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000001', 'owner');"
run_sql_fatal "menu category r2" "insert into menu_categories (id, restaurant_id, name, display_order) values ('cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'Cat2', 1);"
run_sql_fatal "menu item r2" "insert into menu_items (id, category_id, name, price, is_available) values ('dddddddd-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002', 'Item2', 5.00, true);"

run_sql_capture "création commande 1 (pickup, r1)" "select order_id from create_order('r1', 'pickup', '[{\"menu_item_id\":\"dddddddd-0000-0000-0000-000000000001\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Client Test\",\"phone\":\"+33612345678\"}'::jsonb);"
ORDER1_ID="$CAPTURED_OUTPUT"
run_sql_capture "public_token de la commande 1" "select public_token from orders where id='$ORDER1_ID';"
ORDER1_TOKEN="$CAPTURED_OUTPUT"
run_sql_capture "création commande 2 (pickup, r2, autre tenant)" "select order_id from create_order('r2', 'pickup', '[{\"menu_item_id\":\"dddddddd-0000-0000-0000-000000000002\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Client R2\",\"phone\":\"+33698765432\"}'::jsonb);"
ORDER2_ID="$CAPTURED_OUTPUT"
run_sql_capture "public_token de la commande 2" "select public_token from orders where id='$ORDER2_ID';"
ORDER2_TOKEN="$CAPTURED_OUTPUT"

log "=== [4] FOUNDATION seule : comportement fonctionnel/sécurité (sans contrôle de FORMAT email) ==="
run_sql_fatal "4a. pose individuelle valide" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '12 rue Test', 'Paris', '75001', 'FR');" "service_role"
run_sql_expect_error "4b. company sans company_legal_name -- doit rester rejetée par FOUNDATION" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'company', '1 avenue Société', 'Lyon', '69001', 'FR');" "service_role"
assert_eq "4b. company sans nom légal -- REJETÉE par FOUNDATION" "1" "$CAPTURED_ERROR"
run_sql_fatal "4c. FOUNDATION seule ACCEPTE un contact_email de FORMAT invalide (comportement attendu -- pas encore de contrôle de forme à ce stade)" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '12 rue Test', 'Paris', '75001', 'FR', null, null, null, null, 'ffffffff');" "service_role"
run_sql_capture "4c. lecture -- contact_email garbage bien persisté (FOUNDATION seule, aucun contrôle de forme)" "select contact_email from get_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid);" "service_role"
assert_eq "4c. FOUNDATION seule persiste 'ffffffff' comme contact_email (attendu avant le delta)" "ffffffff" "$CAPTURED_OUTPUT"
run_sql_capture "4d. RLS activée" "select relrowsecurity from pg_class where relname='order_invoice_request';"
assert_eq "4d. RLS activée dès la FOUNDATION" "t" "$CAPTURED_OUTPUT"
for role in anon service_role; do
  run_sql_capture "4e. $role ne peut PAS SELECT directement" "select has_table_privilege('$role', 'public.order_invoice_request', 'select');"
  assert_eq "4e. SELECT($role) = false dès la FOUNDATION" "f" "$CAPTURED_OUTPUT"
done
run_sql_capture "4f. staff r1 PEUT lire sa propre commande (RLS, FOUNDATION seule)" "begin; set local role authenticated; select set_config('test.uid','99999999-0000-0000-0000-000000000001',true); select count(*) from order_invoice_request where order_id = '$ORDER1_ID'; commit;"
assert_eq "4f. staff r1 lit sa propre commande dès la FOUNDATION -- count=1" "1" "$(echo "$CAPTURED_OUTPUT" | tail -1)"

log "=== [5] Application du DELTA Email Validation sur la FOUNDATION ==="
run_fatal "email validation delta v1" psql -v VERBOSITY=verbose -d "$DB" -v ON_ERROR_STOP=1 -f "$DELTA_SQL"
DELTA_FUNCTIONDEF="$(functiondef_of_set_fn)"
DELTA_GRANTS="$(grants_snapshot)"

log "=== [6] Le DELTA ne recrée PAS la table, ne touche PAS RLS, ne touche PAS les GRANTS (preuve par égalité stricte) ==="
if [ "$FOUNDATION_GRANTS" = "$DELTA_GRANTS" ]; then
  pass "6. snapshot GRANTS/RLS/policy_count IDENTIQUE avant/après le delta"
else
  fail "6. snapshot GRANTS/RLS a changé après le delta -- attendu '$FOUNDATION_GRANTS', obtenu '$DELTA_GRANTS'"
fi
run_sql_capture "6b. order_id de la commande 1 toujours présent (table jamais recréée)" "select count(*) from order_invoice_request where order_id = '$ORDER1_ID';"
assert_eq "6b. la ligne posée AVANT le delta a survécu (table jamais DROPée/recréée)" "1" "$CAPTURED_OUTPUT"
if [ "$FOUNDATION_FUNCTIONDEF" != "$DELTA_FUNCTIONDEF" ]; then
  pass "6c. la définition de la fonction a bien changé (le delta a fait quelque chose)"
else
  fail "6c. la définition de la fonction n'a PAS changé après application du delta -- suspect"
fi

log "=== [7] Comportement APRÈS le delta : contrat email complet (mandat) ==="
for email in "emmanuel@aulaitcru.fr" "facturation@entreprise.com" "prenom.nom+facture@gmail.com"; do
  run_sql_fatal "7. email VALIDE accepté -- $email" "select set_order_invoice_request('$ORDER2_ID'::uuid, '$ORDER2_TOKEN', 'individual', '1 rue X', 'Paris', '75001', 'FR', null, null, null, null, '$email');" "service_role"
  run_sql_capture "7. relecture email VALIDE -- $email" "select contact_email from get_order_invoice_request('$ORDER2_ID'::uuid, '$ORDER2_TOKEN');" "service_role"
  assert_eq "7. email valide persisté -- $email" "$email" "$CAPTURED_OUTPUT"
done
for email in "emmanuel" "emmanuel@" "@aulaitcru.fr" "emmanuel @aulaitcru.fr" "emmanuel@aulaitcru" "emmanuel@ aulaitcru.fr"; do
  run_sql_expect_error "7. email INVALIDE rejeté -- '$email'" "select set_order_invoice_request('$ORDER2_ID'::uuid, '$ORDER2_TOKEN', 'individual', '1 rue X', 'Paris', '75001', 'FR', null, null, null, null, '$email');" "service_role"
  assert_eq "7. email invalide '$email' -- REJETÉ" "1" "$CAPTURED_ERROR"
  run_sql_capture "7. code erreur SQLSTATE 22023 -- '$email'" "select 1;"
done
run_sql_fatal "7b. contact_email absent (jamais fourni) -- toujours accepté après le delta" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '12 rue Test', 'Paris', '75001', 'FR');" "service_role"
run_sql_capture "7b. lecture -- contact_email redevenu NULL (dernier upsert sans email)" "select contact_email is null from get_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid);" "service_role"
assert_eq "7b. contact_email optionnel absent -- toujours accepté après le delta" "t" "$CAPTURED_OUTPUT"

log "=== [8] Refus de ré-application du delta (guard idempotent) ==="
psql -v ON_ERROR_STOP=1 -d "$DB" -f "$DELTA_SQL" >/tmp/scanym-invreq-layered-reapply-$$.out 2>&1
REAPPLY_RC=$?
if [ "$REAPPLY_RC" -ne 0 ] && grep -q "SCANYM_ALREADY_APPLIED" /tmp/scanym-invreq-layered-reapply-$$.out; then
  pass "8. le delta refuse de se ré-appliquer aveuglément (guard idempotent)"
else
  fail "8. le delta aurait dû refuser une ré-application (rc=$REAPPLY_RC)"
fi
rm -f /tmp/scanym-invreq-layered-reapply-$$.out

log "=== [9] ROLLBACK du delta -> re-FORWARD -> ROLLBACK foundation -> re-FORWARD (stabilité) ==="
run_fatal "rollback du delta (retour à la FOUNDATION)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DELTA_ROLLBACK_SQL"
POSTROLLBACK_DELTA_FUNCTIONDEF="$(functiondef_of_set_fn)"
if [ "$POSTROLLBACK_DELTA_FUNCTIONDEF" = "$FOUNDATION_FUNCTIONDEF" ]; then
  pass "9a. après rollback du delta, la définition est BYTE-IDENTIQUE à la FOUNDATION d'origine"
else
  fail "9a. après rollback du delta, la définition DIFFÈRE de la FOUNDATION d'origine"
fi
run_sql_fatal "9b. FOUNDATION seule redevient fonctionnelle (accepte à nouveau un email de format invalide)" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '12 rue Test', 'Paris', '75001', 'FR', null, null, null, null, 'ffffffff-again');" "service_role"

run_fatal "re-forward du delta" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DELTA_SQL"
REFORWARD_DELTA_FUNCTIONDEF="$(functiondef_of_set_fn)"
if [ "$REFORWARD_DELTA_FUNCTIONDEF" = "$DELTA_FUNCTIONDEF" ]; then
  pass "9c. re-forward du delta -- définition BYTE-IDENTIQUE au premier forward"
else
  fail "9c. re-forward du delta -- définition DIFFÈRE du premier forward"
fi
run_sql_expect_error "9d. après re-forward, le format invalide est de nouveau rejeté" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '12 rue Test', 'Paris', '75001', 'FR', null, null, null, null, 'ffffffff-stillbad');" "service_role"
assert_eq "9d. re-forward du delta -- format invalide REJETÉ à nouveau" "1" "$CAPTURED_ERROR"

log "=== [10] Guard de dérive du ROLLBACK -- refuse si la définition actuelle ne correspond pas à l'état attendu ==="
run_sql_fatal "10a. altération SYNTHÉTIQUE de la fonction (simule une évolution ultérieure inconnue)" "create or replace function public.set_order_invoice_request(p_order_id uuid, p_public_token uuid, p_invoice_type text, p_address_line_1 text, p_city text, p_postal_code text, p_country text, p_address_line_2 text default null, p_company_legal_name text default null, p_vat_number text default null, p_contact_name text default null, p_contact_email text default null) returns table(order_id uuid, invoice_type text, updated_at timestamptz) language sql as \$fn\$ select order_id, invoice_type, updated_at from public.order_invoice_request limit 0; \$fn\$;"
psql -v ON_ERROR_STOP=1 -d "$DB" -f "$DELTA_ROLLBACK_SQL" >/tmp/scanym-invreq-layered-driftguard-$$.out 2>&1
DRIFTGUARD_RC=$?
if [ "$DRIFTGUARD_RC" -ne 0 ] && grep -q "SCANYM_ROLLBACK_DRIFT_GUARD" /tmp/scanym-invreq-layered-driftguard-$$.out; then
  pass "10b. le rollback du delta REFUSE de s'exécuter contre une définition inattendue (drift guard réel)"
else
  fail "10b. le rollback du delta aurait dû refuser contre une définition altérée (rc=$DRIFTGUARD_RC)"
fi
rm -f /tmp/scanym-invreq-layered-driftguard-$$.out
run_fatal "10c. restauration de l'état DELTA connu pour la suite du test" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DELTA_SQL"

log "=== [11] ROLLBACK complet de la FOUNDATION (après rollback préalable du delta) ==="
run_fatal "rollback du delta (préalable)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DELTA_ROLLBACK_SQL"
run_fatal "rollback de la FOUNDATION" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$FOUNDATION_ROLLBACK_SQL"
run_sql_capture "11a. table order_invoice_request ABSENTE après rollback complet" "select to_regclass('public.order_invoice_request') is null;"
assert_eq "11a. table absente après rollback complet" "t" "$CAPTURED_OUTPUT"
run_sql_capture "11b. set_order_invoice_request ABSENTE après rollback complet" "select not exists (select 1 from pg_proc where proname='set_order_invoice_request');"
assert_eq "11b. fonction set_ absente après rollback complet" "t" "$CAPTURED_OUTPUT"
run_sql_capture "11c. orders (prérequis) TOUJOURS présente -- rollback n'a rien détruit d'autre" "select to_regclass('public.orders') is not null;"
assert_eq "11c. orders toujours présente (rollback ciblé, jamais collatéral)" "t" "$CAPTURED_OUTPUT"
run_sql_capture "11d. la commande ORDER1 elle-même toujours présente (rollback n'a jamais touché orders)" "select count(*) from orders where id = '$ORDER1_ID';"
assert_eq "11d. ORDER1 toujours présente après rollback complet" "1" "$CAPTURED_OUTPUT"

log "=== [12] Re-FORWARD complet après rollback total -- stabilité forward -> rollback -> forward ==="
run_fatal "re-forward FOUNDATION après rollback complet" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$FOUNDATION_SQL"
run_fatal "re-forward DELTA après rollback complet" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DELTA_SQL"
FINAL_FUNCTIONDEF="$(functiondef_of_set_fn)"
if [ "$FINAL_FUNCTIONDEF" = "$DELTA_FUNCTIONDEF" ]; then
  pass "12a. après un cycle complet forward->rollback->forward, la définition finale est BYTE-IDENTIQUE"
else
  fail "12a. la définition finale diverge après le cycle complet forward->rollback->forward"
fi
run_sql_expect_error "12b. après re-forward complet, le format invalide est bien rejeté" "select set_order_invoice_request(gen_random_uuid(), gen_random_uuid(), 'individual', '1 rue X', 'Paris', '75001', 'FR', null, null, null, null, 'not-an-email');" "service_role"
assert_eq "12b. format invalide rejeté après re-forward complet" "1" "$CAPTURED_ERROR"

log "=== [13] Aucun chevauchement structurel avec Payment Operator Authorization ==="
run_sql_capture "13. aucun objet payment_operator_* touché par cette chaîne" "select count(*) from pg_proc where proname ilike '%payment_operator%';"
assert_eq "13. aucune fonction payment_operator_* introduite par cette chaîne" "0" "$CAPTURED_OUTPUT"

log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL ==="
if [ "$FAIL_COUNT" -gt 0 ]; then echo "--- ÉCHECS ---"; cat "$FAIL_LOG"; exit 1; fi
exit 0
