#!/usr/bin/env bash
# ============================================================
# Scanym — CUSTOMER CHECKOUT — EMAIL VALIDATION v1 (Claude Monet)
# Harnais SQL ciblé -- preuve RÉELLE (Postgres réel, pas un mock) que
# set_order_invoice_request rejette désormais un p_contact_email au
# FORMAT invalide (nouveau, ce lot), tout en conservant intact le
# comportement déjà couvert par
# checkout-invoice-request-v1-1-check.sh (longueur, obligatoire vs
# optionnel, upsert déterministe, isolation cross-tenant, RLS, GRANT).
# Réutilise EXACTEMENT la même chaîne de construction FIDÈLE au
# baseline authoritative que ce script existant -- jamais une
# nouvelle chaîne divergente.
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_RITD_SQL="$SUPABASE_DIR/DRAFT-lot-receipt-invoice-tax-detail-v1.sql"
DRAFT_CFPM_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-checkout-invoice-request-v1.sql"
DB="scanym_invoice_email_v1_check_$$"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-invoice-email-v1-fails-$$.log"
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
  local outfile="/tmp/scanym-inv-email-v1-fatal-$$-$RANDOM.out"
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
  local outfile="/tmp/scanym-inv-email-v1-capture-$$-$RANDOM.out"
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
# utilisée pour les cas où l'ÉCHEC lui-même est le comportement testé.
CAPTURED_ERROR=""
run_sql_expect_error() {
  local desc="$1" query="$2" role="${3:-}"
  local outfile="/tmp/scanym-inv-email-v1-err-$$-$RANDOM.out"
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
assert_contains() { local desc="$1" needle="$2" haystack="$3"; if [[ "$haystack" == *"$needle"* ]]; then pass "$desc"; else fail "$desc — attendu de contenir '$needle', obtenu '$haystack'"; fi; }

build_common_bootstrap() {
  psql -v ON_ERROR_STOP=1 -d "$DB" > /tmp/scanym-inv-email-v1-bootstrap-$$.out 2>&1 <<'SQL'
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
  rm -f /tmp/scanym-inv-email-v1-bootstrap-$$.out
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

log "=== [0] Construction FIDÈLE au baseline authoritative (identique à checkout-invoice-request-v1-1-check.sh) ==="
psql -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
run_fatal "createdb" createdb "$DB"
run_fatal "bootstrap" build_common_bootstrap
run_fatal "chaîne minimale (v66)" build_minimal_chain
run_fatal "chaîne jusqu'à create_order courant" build_full_chain_through_sibling_delivery_pricing
run_fatal "PAYMENT P1 (orders_id_restaurant_id_unique)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_P1_SQL"
run_fatal "CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.3 (prérequis RITD)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_CFPM_SQL"
run_fatal "RECEIPT/INVOICE TAX DETAIL v1.1 (dernière définition effective de create_order)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_RITD_SQL"
run_fatal "migration order_invoice_request -- CANDIDAT ce lot (EMAIL VALIDATION v1)" psql -v VERBOSITY=verbose -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL"

log "=== [1] Fixture -- une commande via create_order() RÉEL ==="
run_sql_fatal "restaurant 1" "insert into restaurants (id, slug, name, is_active, status) values ('11111111-1111-1111-1111-111111111111', 'r1', 'R1', true, 'active');"
run_sql_fatal "restaurant_configs 1" "insert into restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values ('11111111-1111-1111-1111-111111111111', 'EUR', 1, '+33600000000');"
run_sql_fatal "menu category" "insert into menu_categories (id, restaurant_id, name, display_order) values ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Cat', 1);"
run_sql_fatal "menu item" "insert into menu_items (id, category_id, name, price, is_available) values ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'Item', 5.00, true);"
run_sql_fatal "mode de vente pickup activé pour r1" "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled) values ('11111111-1111-1111-1111-111111111111', 'pickup', true);"

run_sql_capture "création commande 1 (pickup, r1) via create_order() réel" "select order_id from create_order('r1', 'pickup', '[{\"menu_item_id\":\"dddddddd-0000-0000-0000-000000000001\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Client Test\",\"phone\":\"+33612345678\"}'::jsonb);"
ORDER1_ID="$CAPTURED_OUTPUT"
run_sql_capture "public_token de la commande 1" "select public_token from orders where id='$ORDER1_ID';"
ORDER1_TOKEN="$CAPTURED_OUTPUT"
if [ -z "$ORDER1_ID" ] || [ -z "$ORDER1_TOKEN" ]; then log "FATAL: ORDER1_ID/TOKEN vide"; exit 1; fi

log "=== [2] LOT EMAIL VALIDATION v1 -- sondes contact_email (format, ce lot) ==="

# 1. Emails structurellement VALIDES -- mandat, exemples exacts --
#    doivent tous être ACCEPTÉS.
for email in "emmanuel@aulaitcru.fr" "facturation@entreprise.com" "prenom.nom+facture@gmail.com"; do
  run_sql_fatal "1. contact_email valide accepté -- '$email'" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'company', '1 avenue Société', 'Lyon', '69001', 'FR', null, 'ACME SARL', null, 'Jean Contact', '$email');" "service_role"
  run_sql_capture "1. lecture -- '$email' bien persisté" "select contact_email from get_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid);" "service_role"
  assert_eq "1. contact_email persisté = '$email'" "$email" "$CAPTURED_OUTPUT"
done

# 2. Emails structurellement INVALIDES -- mandat, exemples exacts --
#    doivent tous être REJETÉS (nouveau contrôle de ce lot).
for email in "emmanuel" "emmanuel@" "@aulaitcru.fr" "emmanuel @aulaitcru.fr" "emmanuel@aulaitcru" "emmanuel@ aulaitcru.fr"; do
  run_sql_expect_error "2. contact_email invalide REJETÉ -- '$email'" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'company', '1 avenue Société', 'Lyon', '69001', 'FR', null, 'ACME SARL', null, 'Jean Contact', '$email');" "service_role"
  assert_eq "2. contact_email invalide REJETÉ (erreur) -- '$email'" "1" "$CAPTURED_ERROR"
  assert_contains "2. code erreur SQLSTATE 22023 -- '$email'" "SCANYM_INVOICE_REQUEST" "$CAPTURED_OUTPUT"
done

# 3. contact_email NULL/absent -- champ TOUJOURS optionnel, ce lot
#    n'introduit AUCUNE obligation nouvelle.
run_sql_fatal "3. contact_email absent (individuelle, jamais fourni) -- toujours accepté" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '2 rue Sans Email', 'Nice', '06000', 'FR');" "service_role"
run_sql_capture "3. lecture -- contact_email NULL" "select contact_email is null from get_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid);" "service_role"
assert_eq "3. contact_email optionnel absent -- toujours NULL, accepté" "t" "$CAPTURED_OUTPUT"

# 4. Chaîne vide -- normalisée en NULL (inchangé, jamais un rejet de format sur une chaîne vide).
run_sql_fatal "4. contact_email chaîne vide -- normalisée en NULL, jamais un rejet de format" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '3 rue Vide', 'Metz', '57000', 'FR', null, null, null, null, '');" "service_role"
run_sql_capture "4. lecture -- contact_email NULL après chaîne vide" "select contact_email is null from get_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid);" "service_role"
assert_eq "4. chaîne vide normalisée en NULL -- accepté" "t" "$CAPTURED_OUTPUT"

# 5. La règle de LONGUEUR (v1.4, déjà établie) reste prioritaire et
#    intacte -- une chaîne trop longue reste rejetée AVANT même
#    d'atteindre le nouveau contrôle de format.
LONG_EMAIL="$(printf 'f%.0s' $(seq 1 101))"
run_sql_expect_error "5. contact_email trop long (101 car., pas un email) -- REJETÉ par la règle de LONGUEUR, inchangée" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '4 rue Longue', 'Metz', '57000', 'FR', null, null, null, null, '$LONG_EMAIL');" "service_role"
assert_eq "5. contact_email trop long -- REJETÉ (erreur)" "1" "$CAPTURED_ERROR"

# 6. Email exactement à la limite de longueur (100) ET
#    structurellement valide -- ACCEPTÉ (aucune régression de la
#    limite v1.4, combinée à la nouvelle règle de format).
EMAIL_AT_MAX="$(printf 'f%.0s' $(seq 1 88))@example.com"
run_sql_fatal "6. contact_email à la limite EXACTE (100 car.) ET valide -- accepté" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '5 rue Limite', 'Metz', '57000', 'FR', null, null, null, null, '$EMAIL_AT_MAX');" "service_role"
run_sql_capture "6. lecture -- email à la limite bien persisté" "select contact_email from get_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid);" "service_role"
assert_eq "6. contact_email à la limite exacte persisté" "$EMAIL_AT_MAX" "$CAPTURED_OUTPUT"

# 7. NON-RÉGRESSION -- toutes les sondes déjà couvertes par
#    checkout-invoice-request-v1-1-check.sh restent valables (société
#    sans nom légal rejetée, TVA optionnelle, cross-tenant, RLS,
#    upsert déterministe). Sonde ciblée ici : société SANS nom légal
#    reste rejetée MÊME avec un contact_email par ailleurs valide --
#    prouve que les deux règles (v1.1 et ce lot) coexistent sans que
#    l'une masque l'autre.
run_sql_expect_error "7. société sans nom légal (contact_email valide par ailleurs) -- toujours REJETÉE (règle v1.1, inchangée)" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'company', '6 rue Sans Nom', 'Lyon', '69001', 'FR', null, null, null, 'Jean', 'valide@example.com');" "service_role"
assert_eq "7. société sans nom légal -- REJETÉE (erreur), non-régression v1.1" "1" "$CAPTURED_ERROR"

log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL ==="
if [ "$FAIL_COUNT" -gt 0 ]; then echo "--- ÉCHECS ---"; cat "$FAIL_LOG"; exit 1; fi
exit 0
