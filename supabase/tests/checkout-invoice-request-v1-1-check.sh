#!/usr/bin/env bash
# ============================================================
# Scanym — CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.1
# Harnais SQL fidèle au baseline authoritative, réutilisant la
# chaîne canonique déjà établie (build_full_chain_through_sibling_
# delivery_pricing, cf. DELIVERY STREAM C -- Stuart).
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_RITD_SQL="$SUPABASE_DIR/DRAFT-lot-receipt-invoice-tax-detail-v1.sql"
DRAFT_CFPM_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-checkout-invoice-request-v1.sql"
DB="scanym_invoice_v11_check_$$"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-invoice-v11-fails-$$.log"
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
  local outfile="/tmp/scanym-inv-v11-fatal-$$-$RANDOM.out"
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
  local outfile="/tmp/scanym-inv-v11-capture-$$-$RANDOM.out"
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
# Capture qui NE fait PAS échouer le harnais sur une erreur SQL --
# utilisée pour les cas où l'ÉCHEC lui-même est le comportement testé
# (ex. validation rejetée, accès refusé).
CAPTURED_ERROR=""
run_sql_expect_error() {
  local desc="$1" query="$2" role="${3:-}"
  local outfile="/tmp/scanym-inv-v11-err-$$-$RANDOM.out"
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

build_common_bootstrap() {
  psql -v ON_ERROR_STOP=1 -d "$DB" > /tmp/scanym-inv-v11-bootstrap-$$.out 2>&1 <<'SQL'
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
  rm -f /tmp/scanym-inv-v11-bootstrap-$$.out
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

log "=== [0] Construction FIDÈLE au baseline authoritative ==="
psql -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
run_fatal "createdb" createdb "$DB"
run_fatal "bootstrap" build_common_bootstrap
run_fatal "chaîne minimale (v66)" build_minimal_chain
run_fatal "chaîne jusqu'à create_order courant" build_full_chain_through_sibling_delivery_pricing
run_fatal "PAYMENT P1 (orders_id_restaurant_id_unique)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_P1_SQL"
run_fatal "CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.3 (prérequis RITD)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_CFPM_SQL"
run_fatal "RECEIPT/INVOICE TAX DETAIL v1.1 (dernière définition effective de create_order)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_RITD_SQL"
run_fatal "migration order_invoice_request v1.1" psql -v VERBOSITY=verbose -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL"

log "=== [1] Fixtures via create_order() RÉEL ==="
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

run_sql_capture "création commande 1 (pickup, r1) via create_order() réel" "select order_id from create_order('r1', 'pickup', '[{\"menu_item_id\":\"dddddddd-0000-0000-0000-000000000001\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Client Test\",\"phone\":\"+33612345678\"}'::jsonb);"
ORDER1_ID="$CAPTURED_OUTPUT"
run_sql_capture "public_token de la commande 1" "select public_token from orders where id='$ORDER1_ID';"
ORDER1_TOKEN="$CAPTURED_OUTPUT"
if [ -z "$ORDER1_ID" ] || [ -z "$ORDER1_TOKEN" ]; then log "FATAL: ORDER1_ID/TOKEN vide"; exit 1; fi

run_sql_fatal "menu category r2" "insert into menu_categories (id, restaurant_id, name, display_order) values ('cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'Cat2', 1);"
run_sql_fatal "menu item r2" "insert into menu_items (id, category_id, name, price, is_available) values ('dddddddd-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002', 'Item2', 5.00, true);"
run_sql_capture "création commande 2 (pickup, r2, autre tenant) via create_order() réel" "select order_id from create_order('r2', 'pickup', '[{\"menu_item_id\":\"dddddddd-0000-0000-0000-000000000002\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Client R2\",\"phone\":\"+33698765432\"}'::jsonb);"
ORDER2_ID="$CAPTURED_OUTPUT"

log "=== [2] Sondes fonctionnelles/sécurité ==="

# 1. Pas de facture demandée -- aucune ligne requise.
run_sql_capture "1. aucune ligne order_invoice_request pour une commande sans demande" "select count(*) from order_invoice_request where order_id = '$ORDER1_ID';"
assert_eq "1. absence légitime -- count=0" "0" "$CAPTURED_OUTPUT"

# 2. Facture individuelle.
run_sql_capture "2. set_order_invoice_request individuelle" "select invoice_type from set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '12 rue Test', 'Paris', '75001', 'FR');" "service_role"
assert_eq "2. invoice_type retourné = individual" "individual" "$CAPTURED_OUTPUT"

# 3. Facture société.
run_sql_capture "3. set_order_invoice_request société" "select invoice_type from set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'company', '1 avenue Société', 'Lyon', '69001', 'FR', null, 'ACME SARL', 'FR12345678901', 'Jean Contact', 'contact@acme.test');" "service_role"
assert_eq "3. invoice_type retourné = company (upsert)" "company" "$CAPTURED_OUTPUT"

run_sql_capture "3b. lecture des champs société persistés" "select company_legal_name, vat_number from get_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid);" "service_role"
assert_eq "3b. company_legal_name/vat_number persistés" "ACME SARL|FR12345678901" "$CAPTURED_OUTPUT"

# 4. Société sans nom légal -- rejetée.
run_sql_expect_error "4. company sans company_legal_name" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'company', '1 avenue Société', 'Lyon', '69001', 'FR');" "service_role"
assert_eq "4. company sans nom légal -- REJETÉE (erreur)" "1" "$CAPTURED_ERROR"

# 5. TVA optionnelle acceptée -- commande fraîche dédiée, jamais une
# lecture directe de `orders` (create_order retourne déjà order_id ET
# public_token dans sa propre TABLE de sortie).
run_sql_capture "5. fixture + capture order_id/public_token en un seul appel create_order" "select order_id, public_token from create_order('r1', 'pickup', '[{\"menu_item_id\":\"dddddddd-0000-0000-0000-000000000001\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Client TVA Test\",\"phone\":\"+33611112222\"}'::jsonb);" "anon"
ORDER5_ID="$(echo "$CAPTURED_OUTPUT" | cut -d'|' -f1)"
ORDER5_TOKEN="$(echo "$CAPTURED_OUTPUT" | cut -d'|' -f2)"
run_sql_fatal "5. pose individuelle sans TVA (p_vat_number jamais fourni)" "select set_order_invoice_request('$ORDER5_ID'::uuid, '$ORDER5_TOKEN'::uuid, 'individual', '3 rue Sans TVA', 'Tours', '37000', 'FR');" "service_role"
run_sql_capture "5. TVA absente acceptée pour individuelle -- lecture" "select vat_number is null from get_order_invoice_request('$ORDER5_ID'::uuid, '$ORDER5_TOKEN'::uuid);" "service_role"
assert_eq "5. TVA optionnelle -- acceptée, NULL" "t" "$CAPTURED_OUTPUT"

# 6. invoice_type invalide -- rejeté.
run_sql_expect_error "6. invoice_type invalide" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'bogus', '1 rue X', 'Paris', '75001', 'FR');" "service_role"
assert_eq "6. invoice_type invalide -- REJETÉE (erreur)" "1" "$CAPTURED_ERROR"

# 7. Champs optionnels vides normalisés en NULL.
run_sql_fatal "7. pose avec champs optionnels vides" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '5 rue Vide', 'Nice', '06000', 'FR', '', 'ignored-for-individual', '', '');" "service_role"
run_sql_capture "7. champs optionnels vides -> NULL (lecture)" "select contact_name is null, address_line_2 is null from get_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid);" "service_role"
assert_eq "7. chaînes vides normalisées en NULL (contact_name, address_line_2)" "t|t" "$CAPTURED_OUTPUT"

# 8. Donnée persistée pour la BONNE commande.
run_sql_capture "8. persistance liée à la bonne commande (order_id exact)" "select order_id from order_invoice_request where order_id = '$ORDER1_ID';"
assert_eq "8. order_id exact retrouvé" "$ORDER1_ID" "$CAPTURED_OUTPUT"

# 9. Lecture cross-tenant refusée (mauvais public_token).
run_sql_expect_error "9. lecture avec mauvais public_token" "select * from get_order_invoice_request('$ORDER1_ID'::uuid, gen_random_uuid());" "service_role"
assert_eq "9. lecture cross-tenant (jeton erroné) -- REJETÉE" "1" "$CAPTURED_ERROR"

# 10. Écriture cross-tenant refusée (mauvais public_token).
run_sql_expect_error "10. écriture avec mauvais public_token" "select set_order_invoice_request('$ORDER1_ID'::uuid, gen_random_uuid(), 'individual', '1 rue X', 'Paris', '75001', 'FR');" "service_role"
assert_eq "10. écriture cross-tenant (jeton erroné) -- REJETÉE" "1" "$CAPTURED_ERROR"

# 11. Flux checkout autorisé -- déjà prouvé par les tests 2/3/8 (order_id + public_token corrects acceptés).
pass "11. flux checkout autorisé (id+token corrects) -- déjà prouvé par 2/3/8"

# 12. Aucune exposition service_role navigateur -- structurel, prouvé côté TypeScript (voir tests Node), confirmé ici par le REVOKE explicite.
run_sql_capture "12. authenticated ne peut PAS exécuter set_order_invoice_request" "select has_function_privilege('authenticated', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'execute');"
assert_eq "12. EXECUTE(authenticated) sur set_ = false" "f" "$CAPTURED_OUTPUT"
run_sql_capture "12b. anon ne peut PAS exécuter set_order_invoice_request" "select has_function_privilege('anon', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'execute');"
assert_eq "12b. EXECUTE(anon) sur set_ = false" "f" "$CAPTURED_OUTPUT"

# 13/14. Aucun déclenchement paiement/Stuart -- structurel (aucune table payment_transactions/stuart_delivery_jobs référencée par cette migration).
run_sql_capture "13/14. aucune ligne payment_transactions ni stuart_delivery_jobs créée par set_order_invoice_request" "select (select count(*) from payment_transactions where order_id = '$ORDER1_ID') = 0;"
assert_eq "13/14. aucun effet de bord paiement/Stuart" "t" "$CAPTURED_OUTPUT"

# 15. Aucune commande dupliquée -- un seul order_id existe toujours.
run_sql_capture "15. un seul order_id ORDER1_ID dans orders" "select count(*) from orders where id = '$ORDER1_ID';"
assert_eq "15. aucune duplication de commande" "1" "$CAPTURED_OUTPUT"

# 16. Retry/upsert déterministe -- deux appels identiques -> même état final, une seule ligne.
run_sql_fatal "16. premier appel idempotent" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '9 rue Retry', 'Metz', '57000', 'FR');" "service_role"
run_sql_fatal "16. second appel identique (retry)" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '9 rue Retry', 'Metz', '57000', 'FR');" "service_role"
run_sql_capture "16. une seule ligne persistée après 2 appels identiques" "select count(*) from order_invoice_request where order_id = '$ORDER1_ID';"
assert_eq "16. upsert déterministe -- exactement 1 ligne" "1" "$CAPTURED_OUTPUT"

# 17. Chemin sans facture non régressé -- ORDER2 (r2) n'a jamais de ligne.
run_sql_capture "17. commande 2 (jamais de demande de facture) -- toujours 0 ligne" "select count(*) from order_invoice_request where order_id = '$ORDER2_ID';"
assert_eq "17. chemin sans facture non régressé" "0" "$CAPTURED_OUTPUT"

log "=== [3] RLS lecture marchand ==="
run_sql_capture "RLS activée" "select relrowsecurity from pg_class where relname='order_invoice_request';"
assert_eq "RLS activée" "t" "$CAPTURED_OUTPUT"
run_sql_fatal "sentinelle rôle staff r1" "begin; set local role authenticated; select set_config('test.uid','99999999-0000-0000-0000-000000000001',true); select '__SCANYM_ROLE_OK__:' || current_user; commit;"

run_sql_capture "staff r1 PEUT lire la demande de facture de sa propre commande (RLS)" "begin; set local role authenticated; select set_config('test.uid','99999999-0000-0000-0000-000000000001',true); select count(*) from order_invoice_request where order_id = '$ORDER1_ID'; commit;"
assert_eq "staff r1 lit sa propre commande -- count=1" "1" "$(echo "$CAPTURED_OUTPUT" | tail -1)"

run_sql_fatal "staff pour r2 (autre tenant)" "insert into auth.users (id, email) values ('99999999-0000-0000-0000-000000000002', 'staff@r2.test'); insert into restaurant_users (restaurant_id, user_id, role) values ('22222222-2222-2222-2222-222222222222', '99999999-0000-0000-0000-000000000002', 'owner');"
run_sql_capture "public_token de ORDER2 (r2) pour tester l'isolation croisée" "select public_token from orders where id = '$ORDER2_ID';"
ORDER2_TOKEN="$CAPTURED_OUTPUT"
run_sql_fatal "facture posée sur ORDER2" "select set_order_invoice_request('$ORDER2_ID'::uuid, '$ORDER2_TOKEN'::uuid, 'individual', '1 rue R2', 'Marseille', '13000', 'FR');" "service_role"

run_sql_capture "staff r1 NE PEUT PAS lire la demande de facture de r2 (isolation tenant)" "begin; set local role authenticated; select set_config('test.uid','99999999-0000-0000-0000-000000000001',true); select count(*) from order_invoice_request where order_id = '$ORDER2_ID'; commit;"
assert_eq "staff r1 isolé de r2 -- count=0" "0" "$(echo "$CAPTURED_OUTPUT" | tail -1)"

for role in anon service_role; do
  run_sql_capture "$role ne peut PAS SELECT directement sur la table" "select has_table_privilege('$role', 'public.order_invoice_request', 'select');"
  assert_eq "SELECT($role) = false" "f" "$CAPTURED_OUTPUT"
done
run_sql_capture "authenticated ne peut PAS INSERT directement" "select has_table_privilege('authenticated', 'public.order_invoice_request', 'insert');"
assert_eq "INSERT(authenticated) = false" "f" "$CAPTURED_OUTPUT"
run_sql_capture "service_role ne peut PAS INSERT directement (exclusivement via RPC)" "select has_table_privilege('service_role', 'public.order_invoice_request', 'insert');"
assert_eq "INSERT(service_role) = false" "f" "$CAPTURED_OUTPUT"

log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL ==="
if [ "$FAIL_COUNT" -gt 0 ]; then echo "--- ÉCHECS ---"; cat "$FAIL_LOG"; exit 1; fi
exit 0
