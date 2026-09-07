#!/usr/bin/env bash
# ============================================================
# Scanym — STUART SANDBOX INTEGRATION v2.6.5
# Harnais SQL FIDÈLE au baseline authoritative RÉEL
# (STUART-V264-SQL-HARNESS-BASELINE-01, MEDIUM).
#
# CORRECTIF v2.6.5 : le harnais v2.6.1/v2.6.4 s'arrêtait à
# migration-v66-categories-descriptions.sql -- omettant
# order_delivery_address (LOT 2A, migration-v82) et
# order_billing_context (PAYMENT P3-B6), toutes deux RÉELLEMENT
# persistées par le baseline authoritative c99bb22da... Ce harnais
# réutilise la fonction canonique DÉJÀ ÉTABLIE et déjà validée par un
# lot SIBLING testant CES MÊMES tables
# (supabase/tests/payment-p3b6-checkout-billing-context-check.sh,
# fonction build_full_chain_through_sibling_delivery_pricing) --
# jamais une nouvelle liste tronquée arbitraire.
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_P3B6_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b6-checkout-billing-context.sql"
DRAFT_RITD_SQL="$SUPABASE_DIR/DRAFT-lot-receipt-invoice-tax-detail-v1.sql"
DRAFT_CFPM_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql"
DRAFT_MLTP_SQL="$SUPABASE_DIR/DRAFT-lot-merchant-legal-tax-profile-v1.sql"
DRAFT_STUART_V21_SQL="$SUPABASE_DIR/DRAFT-lot-stuart-sandbox-integration-v2-1.sql"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-stuart-sandbox-integration-v2-6-1-synthetic-guard.sql"
DB="scanym_stuart_v265_check_$$"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-stuart-v265-fails-$$.log"
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
  local outfile="/tmp/scanym-v265-fatal-$$-$RANDOM.out"
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
  local outfile="/tmp/scanym-v265-capture-$$-$RANDOM.out"
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
assert_eq() { local desc="$1" expected="$2" actual="$3"; if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi; }

build_common_bootstrap() {
  psql -v ON_ERROR_STOP=1 -d "$DB" > /tmp/scanym-v265-bootstrap-$$.out 2>&1 <<'SQL'
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
  rm -f /tmp/scanym-v265-bootstrap-$$.out
  return $rc
}

# CORRECTIF v2.6.5 : chaîne FIDÈLE, réutilisant EXACTEMENT la fonction
# canonique déjà établie et validée par le harnais SIBLING P3-B6
# (jamais une nouvelle troncature arbitraire).
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
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: $f (chaîne fidèle sibling P3-B6)"; return 1; }
  done
  return 0
}

log "=== [0] Construction FIDÈLE au baseline authoritative (order_delivery_address + order_billing_context INCLUS) ==="
psql -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
run_fatal "createdb" createdb "$DB"
run_fatal "bootstrap" build_common_bootstrap
run_fatal "chaîne minimale (v66)" build_minimal_chain
run_fatal "chaîne fidèle jusqu'à order_delivery_address + create_order courant (patron canonique sibling P3-B6)" build_full_chain_through_sibling_delivery_pricing
run_fatal "PAYMENT P1 (payment_transactions, orders_id_restaurant_id_unique)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_P1_SQL"
run_fatal "PAYMENT P3-B6 (order_billing_context)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_P3B6_SQL"
run_fatal "CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.3 (prérequis RITD, tax_rate/unit_weight_grams sur menu_items)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_CFPM_SQL"
run_fatal "RECEIPT/INVOICE TAX DETAIL v1.1 (DERNIÈRE définition effective de create_order au baseline authoritative -- STUART-V264-SQL-HARNESS-BASELINE-01)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_RITD_SQL"
run_fatal "MERCHANT LEGAL & TAX PROFILE v1.2 (dernier lot ULTÉRIEUR et SANS RAPPORT fusionné sur main -- ajoute des colonnes fiscales marchand à orders, jamais des PII client, voir BASELINE-SCHEMA-RECONNAISSANCE.md)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_MLTP_SQL"
run_fatal "Stuart v2.1 (stuart_delivery_jobs)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_STUART_V21_SQL"
run_fatal "migration synthetic guard v2.6.5 (inventaire PII complet)" psql -v VERBOSITY=verbose -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL"

log "=== [1] Fixtures via create_order() RÉEL (jamais un INSERT manuel -- preuve fidèle du graphe réellement écrit) ==="
run_sql_fatal "restaurant 1" "insert into restaurants (id, slug, name, is_active, status) values ('11111111-1111-1111-1111-111111111111', 'r1', 'R1', true, 'active');"
run_sql_fatal "restaurant_configs 1" "insert into restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number, delivery_zone_prefixes) values ('11111111-1111-1111-1111-111111111111', 'EUR', 1, '+33639980098', '{75}');"
run_sql_fatal "restaurant 2" "insert into restaurants (id, slug, name, is_active, status) values ('22222222-2222-2222-2222-222222222222', 'r2', 'R2', true, 'active');"
run_sql_fatal "restaurant_configs 2" "insert into restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number, delivery_zone_prefixes) values ('22222222-2222-2222-2222-222222222222', 'EUR', 1, '+33639980098', '{75}');"
run_sql_fatal "menu category" "insert into menu_categories (id, restaurant_id, name, display_order) values ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Cat', 1);"
run_sql_fatal "menu item" "insert into menu_items (id, category_id, name, price, is_available) values ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'Item', 5.00, true);"
run_sql_fatal "mode de vente delivery activé pour r1 (zones 75/92 via config JSONB)" "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, config) values ('11111111-1111-1111-1111-111111111111', 'delivery', true, '{\"delivery_zone_prefixes\": [\"75\", \"92\"]}'::jsonb);"

# Commande RÉELLE via create_order() (jamais un INSERT manuel) --
# preuve directe que order_delivery_address est bien peuplée EN
# PARALLÈLE, exactement comme documenté dans BASELINE-SCHEMA-
# RECONNAISSANCE.md.
run_sql_capture "création commande RÉELLE via create_order()" "select order_id from create_order('r1', 'delivery', '[{\"menu_item_id\":\"dddddddd-0000-0000-0000-000000000001\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Real Customer\",\"phone\":\"+33639980002\",\"address\":\"12 rue Real Customer, 75001 Paris\"}'::jsonb);"
REAL_ORDER_ID="$CAPTURED_OUTPUT"
if [ -z "$REAL_ORDER_ID" ]; then log "FATAL: REAL_ORDER_ID vide"; exit 1; fi

# CORRECTIF v2.6.7.2 (hygiène PII) : TOUT numéro de contraste/négatif
# (commandes fictives non liées à Stuart, config WhatsApp restaurant,
# commande "réelle" de contraste) utilise EXCLUSIVEMENT une valeur
# DISTINCTE au sein du MÊME bloc mobile fictif officiel ARCEP
# `+3363998XXXX` (Décision n° 2018-0881, article 2.5.12) -- jamais un
# numéro français mobile plausible arbitraire. La sémantique de
# contraste (« valeur différente de la fixture synthétique attendue »)
# est préservée sans jamais introduire une valeur pouvant correspondre
# à un abonné réel.
SYN_PHONE="+33639980001"
SYN_NAME="Scanym SandboxSynthetic"
SYN_EMAIL=""
SYN_ADDRESS="2 Place Constantin Pecqueur, 75018 Paris, France"
SYN_ZONE="75018"
SYN_NOTE=""

# CORRECTIF v2.6.6 (STUART-V265-HARNESS-RUNTIME-DIVERGENCE-01) :
# fixture EXACTEMENT identique aux constantes runtime réelles de
# app/api/internal/stuart/sandbox-trigger/route.ts -- email et note
# NULL (jamais fournis dans le JSON p_customer/p_note), adresse
# IDENTIQUE à celle utilisée par le déclencheur réel (plus aucune
# trace de "156 rue de Charonne").
run_sql_capture "création commande SYNTHÉTIQUE via create_order() -- fixture EXACTE runtime (email/note NULL, jamais fournis)" "select order_id from create_order('r1', 'delivery', '[{\"menu_item_id\":\"dddddddd-0000-0000-0000-000000000001\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"$SYN_NAME\",\"phone\":\"$SYN_PHONE\",\"address\":\"$SYN_ADDRESS\"}'::jsonb);"
SYN_ORDER_ID="$CAPTURED_OUTPUT"
if [ -z "$SYN_ORDER_ID" ]; then log "FATAL: SYN_ORDER_ID vide"; exit 1; fi

# Preuve d'intégration RÉELLE (mandat "MANDATORY INTEGRATED CONTRACT
# TEST") : le code postal réellement dérivé DOIT être EXACTEMENT
# "75018" -- jamais deviné, vérifié directement.
run_sql_capture "vérification directe -- postal_code réellement dérivé par create_order()" "select postal_code from order_delivery_address where order_id='$SYN_ORDER_ID';"
assert_eq "postal_code dérivé par create_order() == EXACTEMENT la constante runtime SYN_ZONE" "$SYN_ZONE" "$CAPTURED_OUTPUT"
run_sql_capture "vérification directe -- orders.delivery_zone réellement dérivé" "select delivery_zone from orders where id='$SYN_ORDER_ID';"
assert_eq "orders.delivery_zone dérivé par create_order() == EXACTEMENT la constante runtime SYN_ZONE" "$SYN_ZONE" "$CAPTURED_OUTPUT"
run_sql_capture "vérification directe -- customer_email/customer_note NULL comme runtime" "select coalesce(customer_email,'NULL'), coalesce(customer_note,'NULL') from orders where id='$SYN_ORDER_ID';"
assert_eq "customer_email/customer_note bien NULL (jamais fournis, comme runtime)" "NULL|NULL" "$CAPTURED_OUTPUT"

run_sql_capture "postal_code réellement dérivé par create_order pour la commande synthétique" "select postal_code from order_delivery_address where order_id='$SYN_ORDER_ID';"
SYN_DERIVED_ZONE="$CAPTURED_OUTPUT"
log "postal_code dérivé réellement par create_order pour la commande synthétique: '$SYN_DERIVED_ZONE'"

log "=== [2] Sondes SQL red-team (mandat, 20 cas minimum) ==="

# 1. Commande réelle, non désignée.
run_sql_capture "1. commande réelle non désignée" "select verify_stuart_sandbox_synthetic_order('$REAL_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "1. commande réelle non désignée -- REJETÉE" "f" "$CAPTURED_OUTPUT"

# 2. 6 champs orders synthétiques mais NON désignée.
run_sql_capture "2. synthétique candidate NON désignée" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "2. non désignée -- REJETÉE" "f" "$CAPTURED_OUTPUT"

run_sql_fatal "désignation administrative directe" "insert into stuart_sandbox_synthetic_test_orders (order_id, restaurant_id, designated_by) values ('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', 'test-operator');"

# 3. Désignée + tout synthétique approuvé (y compris order_delivery_address réellement peuplée par create_order).
run_sql_capture "3. désignée + tout approuvé (y compris order_delivery_address réelle)" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "3. entièrement synthétique (graphe complet réel) -- ACCEPTÉE" "t" "$CAPTURED_OUTPUT"

# 4-9. Chaque champ orders réel individuellement.
run_sql_capture "4. customer_name réel" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', 'Wrong Name', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "4. customer_name réel -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_capture "5. customer_phone réel" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '+33639980002', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "5. customer_phone réel -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_capture "6. customer_email réel" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', 'real@gmail.com', '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "6. customer_email réel -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_capture "7. delivery_address (scalaire orders) réelle" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '12 rue Real, 75001 Paris', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "7. delivery_address scalaire réelle -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_capture "8. delivery_zone incohérente" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '92', null);" "service_role"
assert_eq "8. delivery_zone incohérente -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_capture "9. customer_note réelle" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', 'note client réelle');" "service_role"
assert_eq "9. customer_note réelle -- REJETÉE" "f" "$CAPTURED_OUTPUT"

# ============================================================
# CORRECTIF v2.6.6 -- MATRICE COMPLÈTE DE MUTATION DE L'ADRESSE
# STRUCTURÉE (mandat, 9 champs EXÉCUTÉS individuellement, jamais une
# simple inspection de code source). Chaque mutation est appliquée
# PUIS restaurée avant la mutation suivante -- jamais cumulée.
# ============================================================

# 1. formatted_address
run_sql_fatal "mutation formatted_address (1/9)" "update order_delivery_address set formatted_address = 'adresse formatée réelle injectée' where order_id = '$SYN_ORDER_ID';"
run_sql_capture "1/9. formatted_address réel injecté" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "1/9. formatted_address réel -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_fatal "restauration formatted_address (1/9)" "update order_delivery_address set formatted_address = '$SYN_ADDRESS' where order_id = '$SYN_ORDER_ID';"

# 2. postal_code
run_sql_fatal "mutation postal_code (2/9)" "update order_delivery_address set postal_code = '99999' where order_id = '$SYN_ORDER_ID';"
run_sql_capture "2/9. postal_code réel injecté" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "2/9. postal_code incohérent -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_fatal "restauration postal_code (2/9)" "update order_delivery_address set postal_code = '$SYN_DERIVED_ZONE' where order_id = '$SYN_ORDER_ID';"

# 3. house_number (attendu NULL)
run_sql_fatal "mutation house_number (3/9)" "update order_delivery_address set house_number = '46' where order_id = '$SYN_ORDER_ID';"
run_sql_capture "3/9. house_number non-NULL injecté" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "3/9. house_number non-NULL -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_fatal "restauration house_number (3/9)" "update order_delivery_address set house_number = null where order_id = '$SYN_ORDER_ID';"

# 4. street (attendu NULL)
run_sql_fatal "mutation street (4/9)" "update order_delivery_address set street = 'rue réelle injectée' where order_id = '$SYN_ORDER_ID';"
run_sql_capture "4/9. street non-NULL injecté" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "4/9. street non-NULL -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_fatal "restauration street (4/9)" "update order_delivery_address set street = null where order_id = '$SYN_ORDER_ID';"

# 5. complement (attendu NULL)
run_sql_fatal "mutation complement (5/9)" "update order_delivery_address set complement = 'appartement réel injecté' where order_id = '$SYN_ORDER_ID';"
run_sql_capture "5/9. complement non-NULL injecté" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "5/9. complement non-NULL -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_fatal "restauration complement (5/9)" "update order_delivery_address set complement = null where order_id = '$SYN_ORDER_ID';"

# 6. city (attendu NULL)
run_sql_fatal "mutation city (6/9)" "update order_delivery_address set city = 'Paris réel injecté' where order_id = '$SYN_ORDER_ID';"
run_sql_capture "6/9. city non-NULL injecté" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "6/9. city non-NULL -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_fatal "restauration city (6/9)" "update order_delivery_address set city = null where order_id = '$SYN_ORDER_ID';"

# 7. country (attendu 'FR' exactement)
run_sql_fatal "mutation country (7/9)" "update order_delivery_address set country = 'BE' where order_id = '$SYN_ORDER_ID';"
run_sql_capture "7/9. country incohérent injecté" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "7/9. country incohérent -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_fatal "restauration country (7/9)" "update order_delivery_address set country = 'FR' where order_id = '$SYN_ORDER_ID';"

# 8. latitude (attendu NULL)
run_sql_fatal "mutation latitude (8/9)" "update order_delivery_address set latitude = 48.886700 where order_id = '$SYN_ORDER_ID';"
run_sql_capture "8/9. latitude non-NULL injectée" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "8/9. latitude non-NULL -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_fatal "restauration latitude (8/9)" "update order_delivery_address set latitude = null where order_id = '$SYN_ORDER_ID';"

# 9. longitude (attendu NULL)
run_sql_fatal "mutation longitude (9/9)" "update order_delivery_address set longitude = 2.344500 where order_id = '$SYN_ORDER_ID';"
run_sql_capture "9/9. longitude non-NULL injectée" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "9/9. longitude non-NULL -- REJETÉE" "f" "$CAPTURED_OUTPUT"
run_sql_fatal "restauration longitude (9/9)" "update order_delivery_address set longitude = null where order_id = '$SYN_ORDER_ID';"

# Preuve finale -- état ENTIÈREMENT restauré, ACCEPTÉE de nouveau.
run_sql_capture "revérification -- retour à ACCEPTÉE après restauration COMPLÈTE des 9 champs" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "revérification -- ACCEPTÉE de nouveau après restauration complète (9/9 champs)" "t" "$CAPTURED_OUTPUT"

# 12/13. Contexte de facturation réel.
run_sql_fatal "injection order_billing_context réel (12)" "insert into order_billing_context (order_id, source, address_line_1, city, postal_code, country, customer_name) values ('$SYN_ORDER_ID', 'manual', '1 rue Billing Réelle', 'Paris', '75001', 'FR', 'Real Billing Name');"
run_sql_capture "12. order_billing_context réel présent" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "12. order_billing_context présent (même synthétique) -- REJETÉE (aucune ligne ne doit exister)" "f" "$CAPTURED_OUTPUT"
run_sql_fatal "suppression order_billing_context" "delete from order_billing_context where order_id = '$SYN_ORDER_ID';"
run_sql_capture "16. absence confirmée de order_billing_context -- ACCEPTÉE de nouveau" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "16. absence de billing context -- ACCEPTÉE" "t" "$CAPTURED_OUTPUT"

# 17. Mauvais restaurant.
run_sql_capture "17. mauvais restaurant" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '22222222-2222-2222-2222-222222222222', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "17. mauvais restaurant -- REJETÉE" "f" "$CAPTURED_OUTPUT"

# 18. Corrélation Stuart production incompatible.
run_sql_fatal "corrélation Stuart Production active (18)" "select allocate_stuart_delivery_job('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', 'production', 'PRODTEST01');" "service_role"
run_sql_capture "18. corrélation incompatible (production active)" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "18. corrélation incompatible -- REJETÉE" "f" "$CAPTURED_OUTPUT"

# 19. Ligne synthétique non liée pour une AUTRE commande -- aucun effet.
# Nettoyage préalable de la corrélation Production injectée par le test
# 18 -- sans quoi ce test échouerait pour une raison SANS RAPPORT avec
# son objet réel (bug de séquencement de harnais, pas du garde lui-même).
run_sql_fatal "nettoyage de la corrélation Production du test 18 avant le test 19" "update stuart_delivery_jobs set is_active = false where order_id = '$SYN_ORDER_ID' and environment = 'production';"
run_sql_fatal "commande synthétique 2 non liée (19)" "insert into orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_address, customer_phone, customer_name) values ('99999999-9999-9999-9999-999999999999', '22222222-2222-2222-2222-222222222222', 99, 'delivery', 5.00, 5.00, 'EUR', 'x', '+33639980009', 'Unrelated');"
run_sql_fatal "désignation commande non liée (19)" "insert into stuart_sandbox_synthetic_test_orders (order_id, restaurant_id, designated_by) values ('99999999-9999-9999-9999-999999999999', '22222222-2222-2222-2222-222222222222', 'test-operator');"
run_sql_capture "19. la commande synthétique 1 reste ACCEPTÉE, sans effet de la ligne non liée" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "19. aucun effet croisé -- ACCEPTÉE" "t" "$CAPTURED_OUTPUT"

# 20. Persistance inattendue/malformée -- fail-closed (adresse structurée totalement supprimée).
run_sql_fatal "suppression complète de order_delivery_address (20)" "delete from order_delivery_address where order_id = '$SYN_ORDER_ID';"
run_sql_capture "20. absence totale d'adresse structurée pour une commande delivery -- REJETÉE (fail-closed)" "select verify_stuart_sandbox_synthetic_order('$SYN_ORDER_ID', '11111111-1111-1111-1111-111111111111', '$SYN_PHONE', '$SYN_NAME', null, '$SYN_ADDRESS', '$SYN_DERIVED_ZONE', null);" "service_role"
assert_eq "20. adresse structurée absente -- REJETÉE" "f" "$CAPTURED_OUTPUT"

log "=== [3] RLS + ACL ==="
run_sql_capture "RLS activée" "select relrowsecurity from pg_class where relname='stuart_sandbox_synthetic_test_orders';"
assert_eq "RLS activée" "t" "$CAPTURED_OUTPUT"
for role in public anon authenticated service_role; do
  run_sql_capture "has_table_privilege($role,select)" "select has_table_privilege('$role', 'public.stuart_sandbox_synthetic_test_orders', 'select');"
  assert_eq "has_table_privilege($role, select) = false" "f" "$CAPTURED_OUTPUT"
done
for role in public anon authenticated; do
  run_sql_capture "EXECUTE($role)" "select has_function_privilege('$role', 'public.verify_stuart_sandbox_synthetic_order(uuid,uuid,text,text,text,text,text,text)', 'execute');"
  assert_eq "EXECUTE($role) = false" "f" "$CAPTURED_OUTPUT"
done
run_sql_capture "EXECUTE(service_role)" "select has_function_privilege('service_role', 'public.verify_stuart_sandbox_synthetic_order(uuid,uuid,text,text,text,text,text,text)', 'execute');"
assert_eq "EXECUTE(service_role) = true" "t" "$CAPTURED_OUTPUT"

log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL ==="
if [ "$FAIL_COUNT" -gt 0 ]; then echo "--- ÉCHECS ---"; cat "$FAIL_LOG"; exit 1; fi
exit 0
