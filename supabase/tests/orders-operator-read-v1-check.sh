#!/usr/bin/env bash
# ============================================================
# Scanym — ORDERS OPERATOR READ v1 — harnais SQL RÉEL (PostgreSQL
# réel, aucune simulation, jamais contre Production).
#
# Baseline gelée : main 051893071fee337340af600cab7c01ffed8b8f7a
#
# Construit la même chaîne de migrations réelles que
# invoice-request-production-acl-remediation-v1-check.sh (jusqu'à
# INVOICE REQUEST FOUNDATION v1, qui crée order_invoice_request),
# applique DRAFT-lot-orders-operator-read-v1.sql puis prouve :
#   - opérateur Scanym (aucune ligne restaurant_users) : lit la liste
#     minimale du restaurant ciblé, jamais celle d'un autre ;
#   - colonnes EXACTEMENT celles du mandat, aucune donnée client ;
#   - item_count / has_invoice_request / filtre actif-historique ;
#   - marchand non opérateur (owner du restaurant) : RPC refusée (42501)
#     et lecture marchande directe (RLS) INCHANGÉE ;
#   - utilisateur authentifié sans lien : refusé (42501), lecture
#     directe = 0 ligne ;
#   - anonyme : aucun EXECUTE ;
#   - aucune écriture sur les commandes ;
#   - anti-double-application, rollback propre.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/orders-operator-read-v1-check.sh"
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_RITD_SQL="$SUPABASE_DIR/DRAFT-lot-receipt-invoice-tax-detail-v1.sql"
DRAFT_CFPM_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql"
FOUNDATION_SQL="$SUPABASE_DIR/DRAFT-lot-invoice-request-foundation-v1.sql"
LOT_SQL="$SUPABASE_DIR/DRAFT-lot-orders-operator-read-v1.sql"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-orders-operator-read-v1-rollback.sql"
DB="scanym_ordop_read_v1_$$"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-ordop-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" /tmp/scanym-ordop-*-$$.txt 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-ordop-err-$$.txt; }
sql_err() { cat /tmp/scanym-ordop-err-$$.txt 2>/dev/null; }

as_authenticated() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    2>/tmp/scanym-ordop-err-$$.txt
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-ordop-out-$$.txt 2>/tmp/scanym-ordop-err-$$.txt
  echo $?
}
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-ordop-out-$$.txt 2>/tmp/scanym-ordop-err-$$.txt
  echo $?
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_denied_with() {
  local desc="$1" rc="$2" needle="$3"
  if [ "$rc" -ne 0 ] && grep -q "$needle" /tmp/scanym-ordop-err-$$.txt; then
    pass "$desc (rc=$rc, '$needle')"
  else
    fail "$desc — attendu un refus contenant '$needle', obtenu rc=$rc : $(sql_err)"
  fi
}

build_common_bootstrap() {
  psql -v ON_ERROR_STOP=1 -d "$DB" >/dev/null 2>&1 <<'SQL'
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create extension if not exists pgcrypto;
create publication supabase_realtime;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
alter role service_role bypassrls;
alter role anon nobypassrls;
alter role authenticated nobypassrls;
create schema if not exists storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/'); $$;
SQL
}

build_chain() {
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: $f"; return 1; }
    psql -v ON_ERROR_STOP=1 -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1 || return 1
  done
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: $f"; return 1; }
  done
  for f in "$DRAFT_P1_SQL" "$DRAFT_CFPM_SQL" "$DRAFT_RITD_SQL" "$FOUNDATION_SQL"; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1 || { log "FATAL: $f"; return 1; }
  done
  return 0
}

# ============================================================
# 0. Chaîne réelle + application du lot
# ============================================================
log "=== [0] Construction $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB" || { log "FATAL: createdb"; exit 1; }
build_common_bootstrap || { log "FATAL: bootstrap"; exit 1; }
build_chain || { log "FATAL: chaîne de migrations"; exit 1; }
pass "Chaîne réelle appliquée jusqu'au prérequis (order_invoice_request présent)"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$LOT_SQL" >/tmp/scanym-ordop-out-$$.txt 2>/tmp/scanym-ordop-err-$$.txt; echo $?)
if [ "$RC" -eq 0 ]; then pass "Application propre du lot (préflight + post-check satisfaits)"; else fail "Application du lot (rc=$RC) : $(sql_err)"; cat "$FAIL_LOG"; exit 1; fi

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$LOT_SQL" >/tmp/scanym-ordop-out-$$.txt 2>/tmp/scanym-ordop-err-$$.txt; echo $?)
assert_denied_with "Seconde application refusée (anti-double-application)" "$RC" "SCANYM_SCHEMA_DRIFT"

# ============================================================
# 1. Fixtures
# ============================================================
RESTO_ALC="11111111-1111-1111-1111-111111111111"   # Au lait cru
RESTO_RH="22222222-2222-2222-2222-222222222222"    # Royal Hotel
RESTO_NONE="99999999-9999-9999-9999-999999999999"  # n'existe pas
UID_OWNER_ALC="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
UID_UNRELATED="dddddddd-dddd-dddd-dddd-dddddddddddd"
UID_OWNER_RH="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
UID_OPERATOR="ffffffff-ffff-ffff-ffff-ffffffffffff"

sql "insert into public.restaurants (id, slug, name, is_active, status, country) values
  ('$RESTO_ALC','au-lait-cru-t','Au lait cru', true, 'active', 'FR'),
  ('$RESTO_RH','royal-hotel-t','Royal Hotel', true, 'active', 'FR');" >/dev/null || { log "FATAL: restaurants $(sql_err)"; exit 1; }
sql "insert into auth.users (id, email) values
  ('$UID_OWNER_ALC','owner-alc@test.local'), ('$UID_UNRELATED','unrelated@test.local'),
  ('$UID_OWNER_RH','owner-rh@test.local'), ('$UID_OPERATOR','operator@test.local');" >/dev/null
sql "insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('$RESTO_ALC','$UID_OWNER_ALC','owner'), ('$RESTO_RH','$UID_OWNER_RH','owner');" >/dev/null
sql "insert into public.scanym_operators (user_id) values ('$UID_OPERATOR');" >/dev/null

O_ALC_NEW=$(sql "insert into public.orders (restaurant_id, order_number, service_mode, customer_name, customer_phone, customer_email, subtotal, total, currency) values ('$RESTO_ALC', 1, 'pickup', 'CANARY_NAME_ALC', '+33611111111', 'canary-alc@test.local', 12.50, 12.50, 'EUR') returning id;")
O_ALC_DONE=$(sql "insert into public.orders (restaurant_id, order_number, service_mode, status, subtotal, total, currency) values ('$RESTO_ALC', 2, 'pickup', 'completed', 8.00, 8.00, 'EUR') returning id;")
O_RH_NEW=$(sql "insert into public.orders (restaurant_id, order_number, service_mode, table_number, customer_name, subtotal, total, currency) values ('$RESTO_RH', 1, 'table', 4, 'CANARY_NAME_RH', 30.00, 30.00, 'EUR') returning id;")
[ -n "$O_ALC_NEW" ] && [ -n "$O_ALC_DONE" ] && [ -n "$O_RH_NEW" ] || { log "FATAL: fixtures orders $(sql_err)"; exit 1; }
sql "insert into public.order_items (order_id, item_name, quantity, unit_price, line_total) values
  ('$O_ALC_NEW','Comté', 2, 5.00, 10.00), ('$O_ALC_NEW','Beurre', 1, 2.50, 2.50),
  ('$O_RH_NEW','Plat', 3, 10.00, 30.00);" >/dev/null || { log "FATAL: order_items $(sql_err)"; exit 1; }
sql "insert into public.order_invoice_request (order_id, invoice_type, contact_name, address_line_1, city, postal_code, country) values
  ('$O_ALC_NEW','individual','CANARY_INVOICE','1 rue du Test','Paris','75001','FR');" >/dev/null || { log "FATAL: order_invoice_request $(sql_err)"; exit 1; }
pass "Fixtures : 2 restaurants, owner par restaurant, 1 opérateur sans rattachement, 3 commandes"

# ============================================================
# 2. Opérateur
# ============================================================
log "=== [2] Opérateur Scanym ==="
R=$(as_authenticated "$UID_OPERATOR" "select order_number || '|' || status || '|' || service_mode || '|' || total || '|' || currency || '|' || item_count || '|' || case when has_invoice_request then 'BOOL_TRUE' else 'BOOL_FALSE' end from public.get_operator_restaurant_orders('$RESTO_ALC');")
assert_eq "Opérateur -> Au lait cru (actives) : 1 commande, champs exacts" "1|new|pickup|12.50|EUR|3|BOOL_TRUE" "$R"

R=$(as_authenticated "$UID_OPERATOR" "select string_agg(order_number::text, ',' order by order_number) from public.get_operator_restaurant_orders('$RESTO_ALC', true);")
assert_eq "Opérateur -> Au lait cru (historique) : commandes 1 et 2" "1,2" "$R"

R=$(as_authenticated "$UID_OPERATOR" "select id || '|' || item_count || '|' || case when has_invoice_request then 'BOOL_TRUE' else 'BOOL_FALSE' end from public.get_operator_restaurant_orders('$RESTO_RH');")
assert_eq "Opérateur -> Royal Hotel : uniquement sa commande (isolation)" "$O_RH_NEW|3|BOOL_FALSE" "$R"

R=$(as_authenticated "$UID_OPERATOR" "select count(*) from public.get_operator_restaurant_orders('$RESTO_NONE', true);")
assert_eq "Opérateur -> restaurant inexistant : 0 ligne, aucune fuite" "0" "$R"

R=$(as_authenticated "$UID_OPERATOR" "select string_agg(column_name, ',' order by ordinal_position) from (select (unnest(proargnames)) as column_name, generate_series(1, array_length(proargnames,1)) as ordinal_position from pg_proc where proname = 'get_operator_restaurant_orders') s where ordinal_position > 2;")
assert_eq "Colonnes retournées = liste approuvée exacte" "id,order_number,status,service_mode,created_at,updated_at,total,currency,item_count,has_invoice_request" "$R"

R=$(as_authenticated "$UID_OPERATOR" "select row_to_json(t)::text from public.get_operator_restaurant_orders('$RESTO_ALC', true) t;")
if printf '%s' "$R" | grep -q -E "CANARY|canary-alc|\+3361|customer_|delivery_address|public_token"; then
  fail "Aucune donnée client ne doit sortir de la RPC opérateur (obtenu : $R)"
else
  pass "Aucune donnée client (nom/email/téléphone/adresse/facture) dans la sortie opérateur"
fi

R=$(as_authenticated "$UID_OPERATOR" "select count(*) from public.orders where restaurant_id = '$RESTO_ALC';")
assert_eq "Opérateur : lecture DIRECTE de public.orders toujours filtrée par RLS marchande (inchangée)" "0" "$R"

RC=$(as_authenticated_rc "$UID_OPERATOR" "update public.orders set status = 'accepted' where id = '$O_ALC_NEW';")
R=$(sql "select status from public.orders where id = '$O_ALC_NEW';")
assert_eq "Opérateur : aucune capacité d'écriture ajoutée (commande inchangée)" "new" "$R"

# ============================================================
# 3. Marchands, utilisateur sans lien, anonyme
# ============================================================
log "=== [3] Refus ==="
RC=$(as_authenticated_rc "$UID_OWNER_ALC" "select * from public.get_operator_restaurant_orders('$RESTO_ALC');")
assert_denied_with "Owner Au lait cru (non opérateur) : RPC opérateur refusée, pas de repli membership" "$RC" "Not authorized"
RC=$(as_authenticated_rc "$UID_OWNER_RH" "select * from public.get_operator_restaurant_orders('$RESTO_ALC');")
assert_denied_with "Owner Royal Hotel -> Au lait cru : refusé (cross-tenant)" "$RC" "Not authorized"
RC=$(as_authenticated_rc "$UID_UNRELATED" "select * from public.get_operator_restaurant_orders('$RESTO_ALC');")
assert_denied_with "Utilisateur authentifié sans lien : refusé" "$RC" "Not authorized"
RC=$(as_authenticated_rc "" "select * from public.get_operator_restaurant_orders('$RESTO_ALC');")
assert_denied_with "Authenticated sans uid : refusé" "$RC" "Authentication required"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select * from public.get_operator_restaurant_orders(null);")
assert_denied_with "Opérateur, restaurant null : refusé" "$RC" "p_restaurant_id requis"
RC=$(as_anon_rc "select * from public.get_operator_restaurant_orders('$RESTO_ALC');")
assert_denied_with "Anonyme : aucun EXECUTE" "$RC" "permission denied"

R=$(as_authenticated "$UID_OWNER_ALC" "select count(*) from public.orders where restaurant_id = '$RESTO_ALC';")
assert_eq "Owner Au lait cru : lecture marchande directe inchangée" "2" "$R"
R=$(as_authenticated "$UID_OWNER_ALC" "select count(*) from public.orders where restaurant_id = '$RESTO_RH';")
assert_eq "Owner Au lait cru : aucune lecture Royal Hotel" "0" "$R"
R=$(as_authenticated "$UID_UNRELATED" "select count(*) from public.orders;")
assert_eq "Utilisateur sans lien : lecture directe = 0" "0" "$R"

# ============================================================
# 4. Rollback
# ============================================================
log "=== [4] Rollback ==="
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >/tmp/scanym-ordop-out-$$.txt 2>/tmp/scanym-ordop-err-$$.txt; echo $?)
assert_eq "Rollback appliqué" "0" "$RC"
R=$(sql "select not exists (select 1 from pg_proc where proname = 'get_operator_restaurant_orders');")
assert_eq "Rollback : fonction retirée" "t" "$R"
R=$(as_authenticated "$UID_OWNER_ALC" "select count(*) from public.orders where restaurant_id = '$RESTO_ALC';")
assert_eq "Rollback : lecture marchande toujours intacte" "2" "$R"
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$LOT_SQL" >/tmp/scanym-ordop-out-$$.txt 2>/tmp/scanym-ordop-err-$$.txt; echo $?)
assert_eq "Ré-application après rollback" "0" "$RC"

log "=== RÉSUMÉ ==="
log "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  log "--- échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
