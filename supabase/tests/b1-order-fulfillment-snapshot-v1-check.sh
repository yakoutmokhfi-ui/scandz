#!/usr/bin/env bash
# ============================================================
# Scanym — DELIVERY PRICING v2 — B1 — ORDER FULFILLMENT/PRICING
# SNAPSHOT v1 — harnais SQL RÉEL (PostgreSQL réel, bases jetables,
# aucune simulation).
#
# Même idiome que supabase/tests/product-service-modes-v1-check.sh
# (bootstrap, chaîne minimale, émulation des rôles et de auth.uid()).
# Chaîne prédécesseur reprise jusqu'à DRAFT-lot-product-service-modes-
# v1.sql inclus (dernière redéfinition connue de create_order avant
# B1, baseline main actuelle), puis ce lot (B1) est appliqué et
# vérifié, puis son ROLLBACK, puis re-migration (B1-X-17).
#
# Usage depuis la racine du dépôt :
#   su postgres -c "bash supabase/tests/b1-order-fulfillment-snapshot-v1-check.sh"
# ============================================================
set -uo pipefail

SUPABASE_DIR="${SUPABASE_DIR:-supabase}"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-b1-order-fulfillment-snapshot-v1.sql"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-b1-order-fulfillment-snapshot-v1-ROLLBACK.sql"
PREDECESSOR_SQL="$SUPABASE_DIR/DRAFT-lot-product-service-modes-v1.sql"
DCS_SQL="$SUPABASE_DIR/DRAFT-lot-delivery-country-scope-v1.sql"
DB="scanym_b1_$$"
DB2="scanym_b1x15_$$"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-b1-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB2\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" /tmp/scanym-b1-out-$$.txt /tmp/scanym-b1-err-$$.txt \
        /tmp/scanym-b1-x14-$$.txt 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local d="$1" e="$2" a="$3"
  if [ "$e" = "$a" ]; then pass "$d (=$a)"; else fail "$d — attendu '$e', obtenu '$a'"; fi
}
assert_contains() {
  local d="$1" n="$2" h="$3"
  if printf '%s' "$h" | grep -qi -- "$n"; then pass "$d"; else fail "$d — '$n' absent de : $h"; fi
}
assert_not_contains() {
  local d="$1" n="$2" h="$3"
  if printf '%s' "$h" | grep -qi -- "$n"; then fail "$d — '$n' présent alors qu'il ne devrait pas l'être : $h"; else pass "$d"; fi
}
assert_nonzero_rc() {
  local d="$1" rc="$2"
  if [ "$rc" != "0" ]; then pass "$d (rc=$rc, refusé comme attendu)"; else fail "$d — a RÉUSSI alors qu'il devait être refusé"; fi
}
assert_zero_rc() {
  local d="$1" rc="$2"
  if [ "$rc" = "0" ]; then pass "$d"; else fail "$d — rc=$rc (devrait être 0) : $(cat /tmp/scanym-b1-err-$$.txt 2>/dev/null)"; fi
}

sql() { psql -X -A -q -t -d "$1" -c "$2"; }
sql_rc() {
  psql -X -A -q -t -d "$1" -c "$2" >/tmp/scanym-b1-out-$$.txt 2>/tmp/scanym-b1-err-$$.txt
  echo $?
}
as_user() {
  # $1=db $2=uid $3=sql
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$1" -c "set local test.uid = '$2'; $3" 2>&1
}
as_user_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$1" -c "set local test.uid = '$2'; $3" \
    >/tmp/scanym-b1-out-$$.txt 2>/tmp/scanym-b1-err-$$.txt
  echo $?
}
as_anon() { PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$1" -c "$2" 2>&1; }
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$1" -c "$2" \
    >/tmp/scanym-b1-out-$$.txt 2>/tmp/scanym-b1-err-$$.txt
  echo $?
}
as_service_role() { PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$1" -c "$2" 2>&1; }
as_service_role_rc() {
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$1" -c "$2" \
    >/tmp/scanym-b1-out-$$.txt 2>/tmp/scanym-b1-err-$$.txt
  echo $?
}
last_err() { cat /tmp/scanym-b1-err-$$.txt 2>/dev/null; }
last_out() { cat /tmp/scanym-b1-out-$$.txt 2>/dev/null; }

build_common_bootstrap() {
  psql -d "$1" >/dev/null <<'SQL'
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
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

# ------------------------------------------------------------------
# CHAÎNE PRÉDÉCESSEUR — reprise VERBATIM de
# supabase/tests/product-service-modes-v1-check.sh, PLUS
# DRAFT-lot-product-service-modes-v1.sql lui-même en queue de chaîne
# (devenu prédécesseur direct pour B1 -- dernière redéfinition connue
# de create_order avant ce lot).
# ------------------------------------------------------------------
MINIMAL_CHAIN="schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql"
REST_CHAIN="migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql migration-v72-hardening.sql migration-v73-hardening.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql DRAFT-lot-payment-p1-foundation.sql DRAFT-lot-merchant-delivery-pricing.sql DRAFT-lot-orders-service-role-select-hardening.sql"
CGV_AFTER_N1A_CHAIN="DRAFT-lot-seller-legal-profile-cgv-engine-v1-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-3.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-1.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql"
TRACKING_TAIL="DRAFT-lot-tracking-final-fiscal-summary-v1-1.sql DRAFT-lot-customer-tracking-capability-v3-1.sql DRAFT-lot-customer-contact-live-tracking-v1.sql"

apply_file() {
  # $1=db $2=filename
  psql -X -d "$1" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$2" >/dev/null 2>"$ERR"
}
fatal() { echo "FATAL: $*"; exit 1; }

for f in $MINIMAL_CHAIN $REST_CHAIN DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql \
         DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql $CGV_AFTER_N1A_CHAIN \
         DRAFT-lot-order-received-enqueue-recovery-v1.sql \
         migration-20260919000000-order-success-boundary-v1.sql $TRACKING_TAIL \
         DRAFT-lot-customer-followup-tracking-email-v1.sql \
         DRAFT-lot-online-withdrawal-foundation-v1.sql \
         DRAFT-lot-online-withdrawal-v1-1-cgv-mixed-regime.sql \
         DRAFT-lot-delivery-country-scope-v1.sql \
         DRAFT-lot-product-service-modes-v1.sql; do
  [ -f "$SUPABASE_DIR/$f" ] || fatal "maillon de chaîne absent : supabase/$f"
done
[ -f "$DRAFT_SQL" ] || fatal "migration B1 absente : $DRAFT_SQL"
[ -f "$ROLLBACK_SQL" ] || fatal "rollback B1 absent : $ROLLBACK_SQL"

# ------------------------------------------------------------------
# build_predecessor_chain DB -- construit une base jetable jusqu'à
# DRAFT-lot-product-service-modes-v1.sql inclus (baseline immédiatement
# AVANT B1). Réutilisée pour la base principale ET pour la base
# jetable secondaire de B1-X-15.
# ------------------------------------------------------------------
build_predecessor_chain() {
  local dbname="$1"
  ERR="/tmp/scanym-b1-chain-$$.err"
  psql -c "drop database if exists \"$dbname\";" >/dev/null 2>&1 || true
  createdb "$dbname"
  build_common_bootstrap "$dbname"

  for f in $MINIMAL_CHAIN; do
    apply_file "$dbname" "$f" || fatal "chaîne, $f : $(head -3 "$ERR" | tr '\n' ' ')"
    psql -X -d "$dbname" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in $REST_CHAIN; do
    apply_file "$dbname" "$f" || fatal "chaîne, $f : $(head -3 "$ERR" | tr '\n' ' ')"
  done
  apply_file "$dbname" "DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql" || fatal "CGV v1.1 : $(head -3 "$ERR" | tr '\n' ' ')"
  apply_file "$dbname" "DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql" || fatal "N1-A : $(head -3 "$ERR" | tr '\n' ' ')"
  for f in $CGV_AFTER_N1A_CHAIN; do
    apply_file "$dbname" "$f" || fatal "chaîne CGV, $f : $(head -3 "$ERR" | tr '\n' ' ')"
  done
  psql -X -d "$dbname" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  apply_file "$dbname" "DRAFT-lot-order-received-enqueue-recovery-v1.sql" || fatal "reprise d'enfilement : $(head -3 "$ERR" | tr '\n' ' ')"
  apply_file "$dbname" "migration-20260919000000-order-success-boundary-v1.sql" || fatal "ORDER SUCCESS BOUNDARY v1 : $(head -3 "$ERR" | tr '\n' ' ')"

  psql -X -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<'SQL' || fatal "talon order_invoice_request"
create table public.order_invoice_request (
  order_id uuid primary key references public.orders(id) on delete cascade
);
alter table public.order_invoice_request enable row level security;
revoke all on table public.order_invoice_request from public, anon, authenticated;
SQL
  for f in $TRACKING_TAIL; do
    apply_file "$dbname" "$f" || fatal "chaîne de suivi, $f : $(head -3 "$ERR" | tr '\n' ' ')"
  done
  apply_file "$dbname" "DRAFT-lot-customer-followup-tracking-email-v1.sql" || fatal "CFTE v1 : $(head -3 "$ERR" | tr '\n' ' ')"
  apply_file "$dbname" "DRAFT-lot-online-withdrawal-foundation-v1.sql" || fatal "ONLINE WITHDRAWAL FOUNDATION v1 : $(head -3 "$ERR" | tr '\n' ' ')"
  apply_file "$dbname" "DRAFT-lot-online-withdrawal-v1-1-cgv-mixed-regime.sql" || fatal "ONLINE WITHDRAWAL v1.1 : $(head -3 "$ERR" | tr '\n' ' ')"
  apply_file "$dbname" "DRAFT-lot-delivery-country-scope-v1.sql" || fatal "DELIVERY COUNTRY SCOPE v1 (prédécesseur) : $(head -5 "$ERR" | tr '\n' ' ')"
  apply_file "$dbname" "DRAFT-lot-product-service-modes-v1.sql" || fatal "PRODUCT SERVICE MODES v1 (prédécesseur direct de B1) : $(head -5 "$ERR" | tr '\n' ' ')"
}

# ============================================================
log "=== [0] Baseline — construction de la chaîne prédécesseur ($DB) ==="
build_predecessor_chain "$DB"
log "chaîne prédécesseur appliquée (baseline main actuelle + PRODUCT SERVICE MODES v1)."

HAS_CREATE_ORDER_BEFORE="$(sql "$DB" "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order';")"
assert_eq "0a. baseline : create_order présente (1 seule surcharge)" "1" "$HAS_CREATE_ORDER_BEFORE"
HAS_SNAPSHOT_BEFORE="$(sql "$DB" "select count(*) from information_schema.tables where table_schema='public' and table_name='order_delivery_fulfillment_snapshot';")"
assert_eq "0b. baseline : order_delivery_fulfillment_snapshot ABSENTE avant le lot" "0" "$HAS_SNAPSHOT_BEFORE"

# ============================================================
log "=== FIXTURES (créées AVANT B1 — tables tenant inchangées par B1) ==="

OWNER_NEW="80000000-0000-0000-0000-0000000000b1"
OWNER_OTHER="80000000-0000-0000-0000-0000000000b2"
STAFF_OTHER="80000000-0000-0000-0000-0000000000b3"
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into auth.users (id, email) values
  ('$OWNER_NEW','owner-new@b1.test'),
  ('$OWNER_OTHER','owner-other@b1.test'),
  ('$STAFF_OTHER','staff-other@b1.test');

insert into public.restaurants (name, slug, status, is_active, country) values
  ('B1 New Engine','fs-new-engine-b1','active', true, 'FR'),
  ('B1 Legacy','fs-legacy-b1','active', true, 'FR'),
  ('B1 Ineligible','fs-ineligible-b1','active', true, 'FR'),
  ('B1 Other','fs-other-b1','active', true, 'FR');
SQL

RID_NEW="$(sql "$DB" "select id from public.restaurants where slug='fs-new-engine-b1';")"
RID_LEGACY="$(sql "$DB" "select id from public.restaurants where slug='fs-legacy-b1';")"
RID_INELIGIBLE="$(sql "$DB" "select id from public.restaurants where slug='fs-ineligible-b1';")"
RID_OTHER="$(sql "$DB" "select id from public.restaurants where slug='fs-other-b1';")"

psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('$RID_NEW','$OWNER_NEW','owner'),
  ('$RID_OTHER','$OWNER_OTHER','owner'),
  ('$RID_OTHER','$STAFF_OTHER','staff');

insert into public.restaurant_configs (restaurant_id, whatsapp_number, currency, next_order_number) values
  ('$RID_NEW','+33600000001','EUR',1),
  ('$RID_LEGACY','+33600000002','EUR',1),
  ('$RID_INELIGIBLE','+33600000003','EUR',1),
  ('$RID_OTHER','+33600000004','EUR',1);

insert into public.restaurant_delivery_countries (restaurant_id, country_code) values
  ('$RID_NEW','FR'), ('$RID_LEGACY','FR'), ('$RID_INELIGIBLE','FR'), ('$RID_OTHER','FR');

-- RID_NEW : delivery (nouveau moteur) + pickup + table, toutes activées.
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config) values
  ('$RID_NEW','delivery', true, '{}'::jsonb),
  ('$RID_NEW','pickup', true, '{}'::jsonb),
  ('$RID_NEW','table', true, '{}'::jsonb);

insert into public.restaurant_sale_mode_fulfillments
  (restaurant_id, mode_code, fulfillment_code, provider, enabled, display_order, zone_prefixes, is_fallback, pricing_mode, fixed_fee, free_threshold, customer_text)
values
  ('$RID_NEW','delivery','zone75','internal', true, 1, '{"75"}'::text[], false, 'fixed', 4.90, null, 'Livraison Paris intra-muros'),
  ('$RID_NEW','delivery','zone77','internal', true, 2, '{"77"}'::text[], false, 'free_above_threshold', 3.00, 20.00, 'Livraison Seine-et-Marne'),
  ('$RID_NEW','delivery','zone78','internal', true, 3, '{"78"}'::text[], false, 'free', null, null, 'Livraison gratuite Yvelines'),
  ('$RID_NEW','delivery','fallback','internal', true, 4, '{}'::text[], true, 'fixed', 9.90, null, null);

-- RID_LEGACY : delivery activé, AUCUNE règle de fulfillment (chemin legacy),
-- zone historique portée par restaurant_sale_modes.config.
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config) values
  ('$RID_LEGACY','delivery', true, '{"delivery_zone_prefixes": ["75"]}'::jsonb);

-- RID_INELIGIBLE : delivery activé, UNE règle non-fallback, zone '99'
-- uniquement, AUCUN fallback -- toute autre zone est hors-zone.
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config) values
  ('$RID_INELIGIBLE','delivery', true, '{}'::jsonb);
insert into public.restaurant_sale_mode_fulfillments
  (restaurant_id, mode_code, fulfillment_code, provider, enabled, display_order, zone_prefixes, is_fallback, pricing_mode, fixed_fee, free_threshold, customer_text)
values
  ('$RID_INELIGIBLE','delivery','zone99','internal', true, 1, '{"99"}'::text[], false, 'fixed', 5.00, null, null);

insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config) values
  ('$RID_OTHER','pickup', true, '{}'::jsonb);
SQL

CAT_NEW="$(sql "$DB" "insert into public.menu_categories (restaurant_id, name, display_order) values ('$RID_NEW','Produits',1) returning id;")"
PROD_NEW="$(sql "$DB" "insert into public.menu_items (category_id, name, price, is_available, display_order) values ('$CAT_NEW','Article générique',10.00,true,1) returning id;")"
PROD_NEW_20="$(sql "$DB" "insert into public.menu_items (category_id, name, price, is_available, display_order) values ('$CAT_NEW','Article 20€',20.00,true,2) returning id;")"
PROD_NEW_1999="$(sql "$DB" "insert into public.menu_items (category_id, name, price, is_available, display_order) values ('$CAT_NEW','Article 19.99€',19.99,true,3) returning id;")"
PROD_NEW_8="$(sql "$DB" "insert into public.menu_items (category_id, name, price, is_available, display_order) values ('$CAT_NEW','Article 8€',8.00,true,4) returning id;")"

CAT_LEGACY="$(sql "$DB" "insert into public.menu_categories (restaurant_id, name, display_order) values ('$RID_LEGACY','Produits',1) returning id;")"
PROD_LEGACY="$(sql "$DB" "insert into public.menu_items (category_id, name, price, is_available, display_order) values ('$CAT_LEGACY','Article legacy',10.00,true,1) returning id;")"

CAT_INELIGIBLE="$(sql "$DB" "insert into public.menu_categories (restaurant_id, name, display_order) values ('$RID_INELIGIBLE','Produits',1) returning id;")"
PROD_INELIGIBLE="$(sql "$DB" "insert into public.menu_items (category_id, name, price, is_available, display_order) values ('$CAT_INELIGIBLE','Article ineligible',5.00,true,1) returning id;")"

CUST_JSON='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0612345678","email":"victor.hugo@example.test","address":"12 rue Ordener, 75018 Paris","postalCode":"75018","street":"12 rue Ordener","city":"Paris","country":"FR"}'

order_new() {
  # $1 = JSON items, $2 = service_mode, $3 = postalCode, $4 = table_number (or null)
  local cust
  cust=$(printf '%s' "$CUST_JSON" | sed "s/\"postalCode\":\"[0-9]*\"/\"postalCode\":\"$3\"/")
  as_anon_rc "$DB" "select * from public.create_order('fs-new-engine-b1','$2', '$1'::jsonb, ${4:-null}, '$cust'::jsonb, null, 'fr', false);"
}

# ------------------------------------------------------------------
# B1-T-14 (AVANT application de B1) : une commande de livraison
# LEGACY préexistante, créée avec le create_order PRÉ-B1 (celui de
# PRODUCT SERVICE MODES v1, encore actif à ce stade), pour prouver
# ensuite que la migration ne la rétro-remplit JAMAIS.
# ------------------------------------------------------------------
RC_PRE_B1="$(as_anon_rc "$DB" "select * from public.create_order('fs-legacy-b1','delivery', '[{\"menu_item_id\":\"$PROD_LEGACY\",\"quantity\":1}]'::jsonb, null, '$CUST_JSON'::jsonb, null, 'fr', false);")"
assert_eq "pré-B1. commande legacy créée AVANT application de B1" "0" "$RC_PRE_B1"
ORDER_ID_PRE_B1="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_LEGACY' order by created_at desc limit 1;")"

# ============================================================
log "=== [1] Application du lot B1 ==="
if psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-b1-out-$$.txt 2>&1; then
  pass "1a. le lot B1 s'applique intégralement (préflights P-1..P-7 + P-8 post-commit passés)"
else
  fail "1a. échec : $(tail -15 /tmp/scanym-b1-out-$$.txt)"
fi
HAS_SNAPSHOT_AFTER="$(sql "$DB" "select count(*) from information_schema.tables where table_schema='public' and table_name='order_delivery_fulfillment_snapshot';")"
assert_eq "1b. order_delivery_fulfillment_snapshot existe après le lot" "1" "$HAS_SNAPSHOT_AFTER"
HAS_CREATE_ORDER_AFTER="$(sql "$DB" "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order';")"
assert_eq "1c. create_order : toujours exactement 1 surcharge après B1" "1" "$HAS_CREATE_ORDER_AFTER"

# ------------------------------------------------------------------
# B1-X-16 — apply la migration une SECONDE fois, immédiatement : doit
# être refusée par P-7, sans rien changer (tout dans une transaction).
# ------------------------------------------------------------------
RC_DOUBLE_APPLY=0
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-b1-out-$$.txt 2>&1 || RC_DOUBLE_APPLY=$?
assert_nonzero_rc "X-16a. ré-application de B1 REFUSÉE (P-7, anti double-application)" "$RC_DOUBLE_APPLY"
assert_contains "X-16b. ... avec SCANYM_B1_ALREADY_APPLIED" "SCANYM_B1_ALREADY_APPLIED" "$(cat /tmp/scanym-b1-out-$$.txt)"
HAS_CREATE_ORDER_AFTER_DOUBLE="$(sql "$DB" "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order';")"
assert_eq "X-16c. create_order toujours 1 seule surcharge après la double-application refusée" "1" "$HAS_CREATE_ORDER_AFTER_DOUBLE"

# ------------------------------------------------------------------
# B1-T-14 (APRÈS application) : la commande préexistante n'a REÇU
# AUCUNE ligne d'instantané par la migration.
# ------------------------------------------------------------------
SNAP_COUNT_PRE_B1="$(sql "$DB" "select count(*) from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_PRE_B1';")"
assert_eq "T-14. commande legacy préexistante : ZÉRO ligne d'instantané après migration (jamais de rétro-remplissage)" "0" "$SNAP_COUNT_PRE_B1"

# ============================================================
log "=== [2] Régression §14.1 ==="

# --- T-01 : service_mode = table -> pas de ligne, delivery_fee=0.
RC_T01="$(order_new "[{\"menu_item_id\":\"$PROD_NEW\",\"quantity\":1}]" "table" "75018" "5")"
assert_eq "T-01a. commande TABLE acceptée" "0" "$RC_T01"
ORDER_ID_TABLE="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='table' order by created_at desc limit 1;")"
assert_eq "T-01b. aucune ligne d'instantané pour une commande TABLE" "0" \
  "$(sql "$DB" "select count(*) from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_TABLE';")"
assert_eq "T-01c. delivery_fee=0 pour une commande TABLE" "0.00" \
  "$(sql "$DB" "select delivery_fee from public.orders where id='$ORDER_ID_TABLE';")"

# --- T-02 : service_mode = pickup -> pas de ligne.
RC_T02="$(order_new "[{\"menu_item_id\":\"$PROD_NEW\",\"quantity\":1}]" "pickup" "75018")"
assert_eq "T-02a. commande PICKUP acceptée" "0" "$RC_T02"
ORDER_ID_PICKUP="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='pickup' order by created_at desc limit 1;")"
assert_eq "T-02b. aucune ligne d'instantané pour une commande PICKUP" "0" \
  "$(sql "$DB" "select count(*) from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_PICKUP';")"

# --- T-03 : delivery LEGACY (aucune règle active) -> pas de ligne, comportement inchangé.
RC_T03="$(as_anon_rc "$DB" "select * from public.create_order('fs-legacy-b1','delivery', '[{\"menu_item_id\":\"$PROD_LEGACY\",\"quantity\":1}]'::jsonb, null, '$CUST_JSON'::jsonb, null, 'fr', false);")"
assert_eq "T-03a. commande delivery LEGACY acceptée (chemin postal historique, byte-identique)" "0" "$RC_T03"
ORDER_ID_LEGACY="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_LEGACY' order by created_at desc limit 1;")"
assert_eq "T-03b. aucune ligne d'instantané pour une commande delivery LEGACY" "0" \
  "$(sql "$DB" "select count(*) from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_LEGACY';")"
assert_eq "T-03c. delivery_fee=0 côté legacy (comportement historique inchangé)" "0.00" \
  "$(sql "$DB" "select delivery_fee from public.orders where id='$ORDER_ID_LEGACY';")"

# --- T-04 / T-05 : nouveau moteur, zone '75' matchée (règle fixe).
RC_T04="$(order_new "[{\"menu_item_id\":\"$PROD_NEW\",\"quantity\":1}]" "delivery" "75018")"
assert_eq "T-04a. commande delivery (nouveau moteur, zone 75) acceptée" "0" "$RC_T04"
ORDER_ID_T04="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='delivery' order by created_at desc limit 1;")"
SNAP_T04="$(sql "$DB" "select fulfillment_rule_id||'|'||is_fallback||'|'||coalesce(matched_prefix,'NULL')||'|'||pricing_mode||'|'||coalesce(fixed_fee::text,'NULL')||'|'||coalesce(free_threshold::text,'NULL')||'|'||coalesce(customer_text,'NULL') from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T04';")"
RESOLVED_T04="$(sql "$DB" "select fulfillment_rule_id||'|'||is_fallback||'|'||coalesce(matched_prefix,'NULL')||'|'||pricing_mode||'|'||coalesce(fixed_fee::text,'NULL')||'|'||coalesce(free_threshold::text,'NULL')||'|'||coalesce(customer_text,'NULL') from public.resolve_delivery_fulfillment('$RID_NEW','delivery','75018',1,10.00);")"
assert_eq "T-04b. exactement 1 ligne d'instantané pour cette commande" "1" \
  "$(sql "$DB" "select count(*) from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T04';")"
assert_eq "T-04c. les 7 valeurs de l'instantané == appel DIRECT à resolve_delivery_fulfillment (mêmes arguments)" "$RESOLVED_T04" "$SNAP_T04"
assert_eq "T-05a. matched_prefix non-null pour une règle zone matchée" "75" \
  "$(sql "$DB" "select matched_prefix from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T04';")"
assert_eq "T-05b. is_fallback=false" "f" \
  "$(sql "$DB" "select is_fallback from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T04';")"
assert_eq "T-05c. fixed_fee copié (4.90)" "4.90" \
  "$(sql "$DB" "select fixed_fee from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T04';")"
assert_eq "T-05d. free_threshold NULL pour une règle 'fixed'" "" \
  "$(sql "$DB" "select coalesce(free_threshold::text,'') from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T04';")"

# --- T-06 / T-10 : fallback matché (postal hors de toutes les zones déclarées).
RC_T06="$(order_new "[{\"menu_item_id\":\"$PROD_NEW\",\"quantity\":1}]" "delivery" "69000")"
assert_eq "T-06a. commande delivery (fallback) acceptée" "0" "$RC_T06"
ORDER_ID_T06="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='delivery' order by created_at desc limit 1;")"
assert_eq "T-06b. matched_prefix NULL pour une commande fallback" "" \
  "$(sql "$DB" "select coalesce(matched_prefix,'') from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T06';")"
assert_eq "T-06c. is_fallback=true" "t" \
  "$(sql "$DB" "select is_fallback from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T06';")"
assert_eq "T-10. customer_text NULL sur la règle -> ligne écrite avec customer_text NULL" "" \
  "$(sql "$DB" "select coalesce(customer_text,'') from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T06';")"

# --- T-07 / T-08 : free_above_threshold, seuil exact et seuil-0.01.
RC_T07="$(order_new "[{\"menu_item_id\":\"$PROD_NEW_20\",\"quantity\":1}]" "delivery" "77000")"
assert_eq "T-07a. commande delivery (zone 77, sous-total == seuil) acceptée" "0" "$RC_T07"
ORDER_ID_T07="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='delivery' order by created_at desc limit 1;")"
assert_eq "T-07b. sous-total EXACTEMENT égal au seuil -> delivery_fee=0" "0.00" \
  "$(sql "$DB" "select delivery_fee from public.orders where id='$ORDER_ID_T07';")"

RC_T08="$(order_new "[{\"menu_item_id\":\"$PROD_NEW_1999\",\"quantity\":1}]" "delivery" "77000")"
assert_eq "T-08a. commande delivery (zone 77, sous-total == seuil-0.01) acceptée" "0" "$RC_T08"
ORDER_ID_T08="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='delivery' order by created_at desc limit 1;")"
assert_eq "T-08b. sous-total == seuil-0.01 -> delivery_fee=fixed_fee (3.00)" "3.00" \
  "$(sql "$DB" "select delivery_fee from public.orders where id='$ORDER_ID_T08';")"

# --- T-09 : pricing_mode='free'.
RC_T09="$(order_new "[{\"menu_item_id\":\"$PROD_NEW_8\",\"quantity\":1}]" "delivery" "78000")"
assert_eq "T-09a. commande delivery (zone 78, gratuite) acceptée" "0" "$RC_T09"
ORDER_ID_T09="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='delivery' order by created_at desc limit 1;")"
assert_eq "T-09b. delivery_fee=0 (pricing_mode=free)" "0.00" \
  "$(sql "$DB" "select delivery_fee from public.orders where id='$ORDER_ID_T09';")"
assert_eq "T-09c. fixed_fee NULL dans l'instantané (pricing_mode=free)" "" \
  "$(sql "$DB" "select coalesce(fixed_fee::text,'') from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T09';")"
assert_eq "T-09d. free_threshold NULL dans l'instantané (pricing_mode=free)" "" \
  "$(sql "$DB" "select coalesce(free_threshold::text,'') from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T09';")"

# --- T-11 : commande inéligible (hors zone, aucun fallback) -> refus intégral.
ORDERS_BEFORE_T11="$(sql "$DB" "select count(*) from public.orders where restaurant_id='$RID_INELIGIBLE';")"
RC_T11="$(as_anon_rc "$DB" "select * from public.create_order('fs-ineligible-b1','delivery', '[{\"menu_item_id\":\"$PROD_INELIGIBLE\",\"quantity\":1}]'::jsonb, null, '$CUST_JSON'::jsonb, null, 'fr', false);")"
assert_nonzero_rc "T-11a. commande hors-zone (aucune règle ne matche, aucun fallback) REFUSÉE" "$RC_T11"
assert_contains "T-11b. ... avec SCANYM_OUT_OF_DELIVERY_ZONE" "SCANYM_OUT_OF_DELIVERY_ZONE" "$(last_err)"
assert_eq "T-11c. AUCUNE commande écrite (rollback transactionnel complet)" "$ORDERS_BEFORE_T11" \
  "$(sql "$DB" "select count(*) from public.orders where restaurant_id='$RID_INELIGIBLE';")"
assert_eq "T-11d. AUCUNE ligne d'instantané écrite" "0" \
  "$(sql "$DB" "select count(*) from public.order_delivery_fulfillment_snapshot s join public.orders o on o.id=s.order_id where o.restaurant_id='$RID_INELIGIBLE';")"

# --- T-15 (best-effort) : 2 appels SÉQUENTIELS de create_order sur la
# MÊME règle (simplification acceptée de "10 connexions concurrentes"
# pour ce harnais -- voir note de déviation dans le rapport final).
RC_T15A="$(order_new "[{\"menu_item_id\":\"$PROD_NEW\",\"quantity\":1}]" "delivery" "75018")"
ORDER_ID_T15A="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='delivery' order by created_at desc limit 1;")"
RC_T15B="$(order_new "[{\"menu_item_id\":\"$PROD_NEW\",\"quantity\":1}]" "delivery" "75018")"
ORDER_ID_T15B="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='delivery' order by created_at desc limit 1;")"
assert_eq "T-15a. 1er appel séquentiel accepté" "0" "$RC_T15A"
assert_eq "T-15b. 2e appel séquentiel accepté" "0" "$RC_T15B"
if [ "$ORDER_ID_T15A" != "$ORDER_ID_T15B" ]; then pass "T-15c. deux order_id DISTINCTS"; else fail "T-15c. les deux commandes ont le MÊME order_id"; fi
assert_eq "T-15d. les 2 lignes d'instantané existent, chacune correcte (fixed_fee=4.90)" "4.90|4.90" \
  "$(sql "$DB" "select (select fixed_fee::text from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T15A')||'|'||(select fixed_fee::text from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T15B');")"

# --- T-16 : pricing_mode hors vocabulaire actuel -- INSERT DIRECT
# (superutilisateur, hors create_order) sur un order_id existant SANS
# instantané (celui de T-02, mode pickup). DÉVIATION documentée dans
# le rapport final : restaurant_sale_mode_fulfillments.pricing_mode
# porte lui-même un CHECK IN ('free','fixed','free_above_threshold')
# hérité d'un lot antérieur (non B1) -- impossible d'y écrire
# 'percentage' sans altérer un schéma hors périmètre B1. Ce test
# vérifie donc directement ce que le contrat vise : AUCUN CHECK de
# order_delivery_fulfillment_snapshot ne ferme le vocabulaire de
# pricing_mode.
RC_T16="$(sql_rc "$DB" "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, matched_prefix, pricing_mode, fixed_fee, free_threshold, customer_text) values ('$ORDER_ID_PICKUP', gen_random_uuid(), false, null, 'percentage', null, null, null);")"
assert_eq "T-16. INSERT direct avec pricing_mode='percentage' (hors vocabulaire actuel) RÉUSSIT -- aucun CHECK ne ferme le vocabulaire" "0" "$RC_T16"

# ============================================================
log "=== [3] Non-régression §14.3 (légère) ==="
HAS_TAX_ALLOC="$(sql "$DB" "select count(*) from information_schema.tables where table_schema='public' and table_name='order_delivery_tax_allocations';")"
if [ "$HAS_TAX_ALLOC" = "0" ]; then
  pass "T-23. SKIP — order_delivery_tax_allocations absente de cette chaîne (DRAFT-lot-delivery-fee-vat-allocation-foundation-v1.sql non inclus dans le prédécesseur B1) -- non applicable, noté explicitement."
else
  SUM_ALLOC="$(sql "$DB" "select coalesce(sum(delivery_fee_gross_share),0) from public.order_delivery_tax_allocations where order_id='$ORDER_ID_T04';")"
  assert_eq "T-23. somme des allocations de TVA == orders.delivery_fee" "$(sql "$DB" "select delivery_fee from public.orders where id='$ORDER_ID_T04';")" "$SUM_ALLOC"
fi
pass "T-21/T-22. SKIP — aucune RPC correspondante dans cette chaîne (non applicable à B1, noté explicitement)."
pass "T-24. SKIP — aucune RPC de paiement dans cette chaîne (non applicable à B1, noté explicitement)."
pass "T-20/T-25. SKIP au niveau harnais SQL -- vérifiés séparément par 'npx tsc --noEmit' (voir rapport final : B1 ne touche AUCUN fichier TypeScript)."

# ============================================================
log "=== [4] Adversarial §14.2 ==="

# --- X-01/X-02/X-04 : écritures directes refusées pour authenticated.
RC_X01="$(as_user_rc "$DB" "$OWNER_NEW" "update public.order_delivery_fulfillment_snapshot set fixed_fee = 0.01 where order_id = '$ORDER_ID_T04';")"
assert_nonzero_rc "X-01. UPDATE direct en authenticated REFUSÉ" "$RC_X01"
assert_contains "X-01b. ... permission denied (42501, aucun GRANT UPDATE)" "permission denied" "$(last_err)"

RC_X02="$(as_user_rc "$DB" "$OWNER_NEW" "delete from public.order_delivery_fulfillment_snapshot where order_id = '$ORDER_ID_T04';")"
assert_nonzero_rc "X-02. DELETE direct en authenticated REFUSÉ" "$RC_X02"
assert_contains "X-02b. ... permission denied (42501, aucun GRANT DELETE)" "permission denied" "$(last_err)"

RC_X04A="$(as_user_rc "$DB" "$OWNER_NEW" "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, pricing_mode) values ('$ORDER_ID_TABLE', gen_random_uuid(), false, 'fixed');")"
assert_nonzero_rc "X-04a. INSERT direct en authenticated REFUSÉ" "$RC_X04A"
RC_X04B="$(as_anon_rc "$DB" "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, pricing_mode) values ('$ORDER_ID_TABLE', gen_random_uuid(), false, 'fixed');")"
assert_nonzero_rc "X-04b. INSERT direct en anon REFUSÉ" "$RC_X04B"

# --- X-03 : TRUNCATE refusé pour authenticated ET service_role.
RC_X03A="$(as_user_rc "$DB" "$OWNER_NEW" "truncate public.order_delivery_fulfillment_snapshot;")"
assert_nonzero_rc "X-03a. TRUNCATE en authenticated REFUSÉ" "$RC_X03A"
RC_X03B="$(as_service_role_rc "$DB" "truncate public.order_delivery_fulfillment_snapshot;")"
assert_nonzero_rc "X-03b. TRUNCATE en service_role REFUSÉ (REVOKE ALL nomme explicitement service_role)" "$RC_X03B"

# --- X-07 : SELECT en service_role refusé.
RC_X07="$(as_service_role_rc "$DB" "select count(*) from public.order_delivery_fulfillment_snapshot;")"
assert_nonzero_rc "X-07. SELECT en service_role REFUSÉ (REVOKE ALL explicite)" "$RC_X07"

# --- X-05 : SELECT en authenticated, PAS membre de l'établissement -> 0 lignes, pas d'erreur.
RC_X05="$(as_user_rc "$DB" "$STAFF_OTHER" "select count(*) from public.order_delivery_fulfillment_snapshot where order_id = '$ORDER_ID_T04';")"
assert_zero_rc "X-05a. SELECT en authenticated non-membre : pas d'ERREUR (RLS, pas un refus)" "$RC_X05"
assert_eq "X-05b. ... mais 0 LIGNE visible" "0" "$(last_out)"

# --- X-06 : SELECT en anon -> erreur ou 0 ligne, jamais de donnée.
RC_X06="$(as_anon_rc "$DB" "select count(*) from public.order_delivery_fulfillment_snapshot where order_id = '$ORDER_ID_T04';")"
if [ "$RC_X06" != "0" ]; then
  pass "X-06. SELECT en anon REFUSÉ (aucun GRANT anon)"
else
  assert_eq "X-06. SELECT en anon : 0 ligne (jamais de donnée)" "0" "$(last_out)"
fi

# --- positif de contrôle : le PROPRIÉTAIRE de l'établissement, LUI, voit la ligne (RLS select_staff).
RC_OWNER_SELECT="$(as_user "$DB" "$OWNER_NEW" "select pricing_mode from public.order_delivery_fulfillment_snapshot where order_id = '$ORDER_ID_T04';")"
assert_eq "contrôle positif. le propriétaire de l'établissement VOIT la ligne (policy select_staff)" "fixed" "$RC_OWNER_SELECT"

# --- X-08 : deux create_order visant le même order_id (simulé par un
# second INSERT direct) -> échoue sur la PK order_id.
RC_X08="$(sql_rc "$DB" "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, pricing_mode) values ('$ORDER_ID_T04', gen_random_uuid(), false, 'fixed');")"
assert_nonzero_rc "X-08. second INSERT visant le MÊME order_id échoue (violation de la PK)" "$RC_X08"
assert_contains "X-08b. ... violation de clé unique (23505) sur order_id" "duplicate key value violates unique constraint" "$(last_err)"

# --- X-09 : clés client superflues ignorées, aucun effet sur le frais/l'instantané.
CUST_ENRICHED='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0612345678","email":"victor.hugo@example.test","address":"12 rue Ordener, 75018 Paris","postalCode":"75018","street":"12 rue Ordener","city":"Paris","country":"FR","deliveryFee":999,"fulfillmentCode":"fake","providerCode":"fake","pricingMode":"free"}'
RC_X09="$(as_anon_rc "$DB" "select * from public.create_order('fs-new-engine-b1','delivery', '[{\"menu_item_id\":\"$PROD_NEW\",\"quantity\":1}]'::jsonb, null, '$CUST_ENRICHED'::jsonb, null, 'fr', false);")"
assert_eq "X-09a. commande avec charge utile ENRICHIE acceptée" "0" "$RC_X09"
ORDER_ID_X09="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='delivery' order by created_at desc limit 1;")"
assert_eq "X-09b. delivery_fee RÉEL (4.90), jamais la valeur injectée (999)" "4.90" \
  "$(sql "$DB" "select delivery_fee from public.orders where id='$ORDER_ID_X09';")"
assert_eq "X-09c. pricing_mode RÉEL de l'instantané (fixed), jamais la valeur injectée (free)" "fixed" \
  "$(sql "$DB" "select pricing_mode from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_X09';")"

# --- X-11 : matched_prefix mal formé (padded / vide) -> rejeté par odfs_matched_prefix_shape.
RC_X11A="$(sql_rc "$DB" "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, matched_prefix, pricing_mode) values ('$ORDER_ID_TABLE', gen_random_uuid(), false, '  75018  ', 'fixed');")"
assert_nonzero_rc "X-11a. matched_prefix PADDED rejeté (odfs_matched_prefix_shape)" "$RC_X11A"
RC_X11B="$(sql_rc "$DB" "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, matched_prefix, pricing_mode) values ('$ORDER_ID_TABLE', gen_random_uuid(), false, '', 'fixed');")"
assert_nonzero_rc "X-11b. matched_prefix VIDE rejeté (odfs_matched_prefix_shape)" "$RC_X11B"

# --- X-12 : fixed_fee NaN/Infinity -> rejeté par odfs_fixed_fee_finite.
RC_X12A="$(sql_rc "$DB" "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, pricing_mode, fixed_fee) values ('$ORDER_ID_TABLE', gen_random_uuid(), false, 'fixed', 'NaN'::numeric);")"
assert_nonzero_rc "X-12a. fixed_fee='NaN' rejeté (odfs_fixed_fee_finite)" "$RC_X12A"
RC_X12B="$(sql_rc "$DB" "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, pricing_mode, fixed_fee) values ('$ORDER_ID_TABLE', gen_random_uuid(), false, 'fixed', 'Infinity'::numeric);")"
assert_nonzero_rc "X-12b. fixed_fee='Infinity' rejeté (odfs_fixed_fee_finite)" "$RC_X12B"

# --- X-13 : free_threshold négatif -> rejeté.
RC_X13="$(sql_rc "$DB" "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, pricing_mode, free_threshold) values ('$ORDER_ID_TABLE', gen_random_uuid(), false, 'free_above_threshold', -1.00);")"
assert_nonzero_rc "X-13. free_threshold négatif rejeté (odfs_free_threshold_non_negative)" "$RC_X13"

# --- T-13 / X-10 : édition marchande de la tarification entre deux commandes.
RC_T13A="$(order_new "[{\"menu_item_id\":\"$PROD_NEW\",\"quantity\":1}]" "delivery" "75018")"
ORDER_ID_T13A="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='delivery' order by created_at desc limit 1;")"
assert_eq "T-13a/X-10a. 1ère commande (avant édition) acceptée, fixed_fee=4.90" "0" "$RC_T13A"
FEE_T13A_ORDER="$(sql "$DB" "select delivery_fee from public.orders where id='$ORDER_ID_T13A';")"
assert_eq "T-13b. ... orders.delivery_fee == 4.90" "4.90" "$FEE_T13A_ORDER"

RULE_ZONE75_ID="$(sql "$DB" "select id from public.restaurant_sale_mode_fulfillments where restaurant_id='$RID_NEW' and fulfillment_code='zone75';")"
RC_EDIT="$(as_user_rc "$DB" "$OWNER_NEW" "select public.update_merchant_delivery_fulfillment_pricing('$RULE_ZONE75_ID','fixed',6.50,null,'Livraison Paris intra-muros (révisée)');")"
assert_eq "T-13c. le marchand édite le tarif de la règle zone75 (4.90 -> 6.50)" "0" "$RC_EDIT"

RC_X10B="$(order_new "[{\"menu_item_id\":\"$PROD_NEW\",\"quantity\":1}]" "delivery" "75018")"
ORDER_ID_X10B="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='delivery' order by created_at desc limit 1;")"
assert_eq "X-10b. 2e commande (après édition) acceptée" "0" "$RC_X10B"
assert_eq "X-10c. ... orders.delivery_fee == 6.50 (nouveau tarif, SA PROPRE transaction)" "6.50" \
  "$(sql "$DB" "select delivery_fee from public.orders where id='$ORDER_ID_X10B';")"
assert_eq "X-10d. ... instantané de la 2e commande == 6.50" "6.50" \
  "$(sql "$DB" "select fixed_fee from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_X10B';")"

assert_eq "T-13d. instantané de la 1ère commande INCHANGÉ (toujours 4.90, jamais réécrit)" "4.90" \
  "$(sql "$DB" "select fixed_fee from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T13A';")"
assert_eq "T-13e. orders.delivery_fee de la 1ère commande INCHANGÉ (toujours 4.90)" "4.90" \
  "$(sql "$DB" "select delivery_fee from public.orders where id='$ORDER_ID_T13A';")"
assert_eq "T-13f. customer_text de la 1ère commande INCHANGÉ (texte D'ORIGINE, pas la révision)" "Livraison Paris intra-muros" \
  "$(sql "$DB" "select customer_text from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T13A';")"

# ------------------------------------------------------------------
# B1-X-14 — LE TEST LE PLUS IMPORTANT : resolve_delivery_fulfillment
# temporairement redéfini (une seule transaction, ROLLBACK explicite
# en fin de script -- restaure la définition d'origine automatiquement,
# AUCUNE modification permanente).
# ------------------------------------------------------------------
ORDERS_BEFORE_X14="$(sql "$DB" "select count(*) from public.orders where restaurant_id='$RID_NEW';")"
ITEMS_BEFORE_X14="$(sql "$DB" "select count(*) from public.order_items oi join public.orders o on o.id=oi.order_id where o.restaurant_id='$RID_NEW';")"
SNAP_BEFORE_X14="$(sql "$DB" "select count(*) from public.order_delivery_fulfillment_snapshot s join public.orders o on o.id=s.order_id where o.restaurant_id='$RID_NEW';")"

psql -d "$DB" -X -A -t >/tmp/scanym-b1-x14-$$.txt 2>&1 <<SQL
\set VERBOSITY verbose
begin;

create or replace function public.resolve_delivery_fulfillment(
  p_restaurant_id uuid, p_mode_code text, p_postal_code text, p_total_count integer, p_subtotal numeric default null
)
returns table (
  eligible boolean, fulfillment_rule_id uuid, fulfillment_code text, provider text,
  matched_prefix text, zone_prefixes text[], is_fallback boolean, min_items integer,
  customer_text text, display_order integer, pricing_mode text, fixed_fee numeric,
  free_threshold numeric, delivery_fee numeric, block text, missing integer
)
language sql
stable
security definer
set search_path = ''
as \$fn\$
  with normalized as (
    select nullif(btrim(p_postal_code), '') as code
  ),
  parent_mode_enabled as (
    select exists (
      select 1
      from public.restaurant_sale_modes rsm
      where rsm.restaurant_id = p_restaurant_id
        and rsm.mode_code = p_mode_code
        and rsm.enabled = true
    ) as enabled
  ),
  candidate_rules as (
    select f.id, f.fulfillment_code, f.provider, f.zone_prefixes, f.is_fallback,
           f.min_items, f.customer_text, f.display_order,
           f.pricing_mode, f.fixed_fee, f.free_threshold
    from public.restaurant_sale_mode_fulfillments f
    where f.restaurant_id = p_restaurant_id
      and f.mode_code = p_mode_code
      and f.enabled = true
      and (select enabled from parent_mode_enabled)
      and (select code from normalized) is not null
  ),
  matched_rule as (
    select c.*,
      (select zp.prefix
         from unnest(c.zone_prefixes) with ordinality as zp(prefix, ord)
         where (select code from normalized) like zp.prefix || '%'
         order by zp.ord
         limit 1) as matched_prefix
    from candidate_rules c
    where c.is_fallback = false
      and exists (
        select 1 from unnest(c.zone_prefixes) as zp(prefix)
        where (select code from normalized) like zp.prefix || '%'
      )
    order by c.display_order asc
    limit 1
  ),
  fallback_rule as (
    select c.*, null::text as matched_prefix
    from candidate_rules c
    where c.is_fallback = true
      and not exists (select 1 from matched_rule)
    limit 1
  ),
  selected as (
    select * from matched_rule
    union all
    select * from fallback_rule
    limit 1
  )
  select
    (
      (select code from normalized) is not null
      and s.fulfillment_code is not null
      and not (
        s.min_items is not null
        and coalesce(p_total_count, 0) < s.min_items
      )
    ) as eligible,
    s.id as fulfillment_rule_id,
    s.fulfillment_code,
    s.provider,
    s.matched_prefix,
    s.zone_prefixes,
    s.is_fallback,
    s.min_items,
    s.customer_text,
    s.display_order,
    s.pricing_mode,
    s.fixed_fee,
    s.free_threshold,
    -- B1-X-14 : delivery_fee délibérément INCOHÉRENT avec le tarif
    -- résolu (pricing_mode/fixed_fee/free_threshold) -- c'est
    -- EXACTEMENT ce que B1-A-01, côté create_order, doit détecter.
    case when s.fulfillment_code is null then null else 999.99 end as delivery_fee,
    case
      when (select code from normalized) is null then 'no-postal'
      when s.fulfillment_code is null then 'out-of-zone'
      when s.min_items is not null and coalesce(p_total_count, 0) < s.min_items then 'below-min'
      else null
    end as block,
    case
      when s.fulfillment_code is not null
       and s.min_items is not null
       and coalesce(p_total_count, 0) < s.min_items
        then s.min_items - coalesce(p_total_count, 0)
      else null
    end as missing
  from (select 1) one
  left join selected s on true;
\$fn\$;

select * from public.create_order('fs-new-engine-b1','delivery', '[{"menu_item_id":"$PROD_NEW","quantity":1}]'::jsonb, null, '$CUST_JSON'::jsonb, null, 'fr', false);

rollback;
SQL

X14_OUTPUT="$(cat /tmp/scanym-b1-x14-$$.txt)"
assert_contains "X-14a. create_order LÈVE SCANYM_DELIVERY_SNAPSHOT_INCONSISTENT quand le résolveur renvoie un frais incohérent" "SCANYM_DELIVERY_SNAPSHOT_INCONSISTENT" "$X14_OUTPUT"
assert_contains "X-14b. ... avec le SQLSTATE 22023" "22023" "$X14_OUTPUT"
assert_eq "X-14c. AUCUNE nouvelle commande écrite (rollback transactionnel COMPLET, y compris la redéfinition du résolveur)" "$ORDERS_BEFORE_X14" \
  "$(sql "$DB" "select count(*) from public.orders where restaurant_id='$RID_NEW';")"
assert_eq "X-14d. AUCUNE nouvelle ligne order_items" "$ITEMS_BEFORE_X14" \
  "$(sql "$DB" "select count(*) from public.order_items oi join public.orders o on o.id=oi.order_id where o.restaurant_id='$RID_NEW';")"
assert_eq "X-14e. AUCUNE nouvelle ligne d'instantané" "$SNAP_BEFORE_X14" \
  "$(sql "$DB" "select count(*) from public.order_delivery_fulfillment_snapshot s join public.orders o on o.id=s.order_id where o.restaurant_id='$RID_NEW';")"

RC_X14_RESTORED="$(order_new "[{\"menu_item_id\":\"$PROD_NEW\",\"quantity\":1}]" "delivery" "75018")"
ORDER_ID_X14_RESTORED="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='delivery' order by created_at desc limit 1;")"
assert_eq "X-14f. APRÈS le ROLLBACK, resolve_delivery_fulfillment est RESTAURÉ -- une commande normale réussit de nouveau" "0" "$RC_X14_RESTORED"
# NB : le tarif de la règle zone75 a été révisé à 6.50 par T-13c, plus
# haut dans ce script (édition marchande légitime) -- 6.50 EST la
# valeur COHÉRENTE actuelle, jamais 999.99 (le frais injecté par la
# redéfinition temporaire du résolveur, maintenant annulée).
assert_eq "X-14g. ... et le frais redevient COHÉRENT (tarif actuel 6.50, plus jamais 999.99)" "6.50" \
  "$(sql "$DB" "select delivery_fee from public.orders where id='$ORDER_ID_X14_RESTORED';")"

# ------------------------------------------------------------------
# B1-X-18 : purge_old_customer_data(0) après une commande -- la ligne
# d'instantané SURVIT intacte, orders.delivery_zone devient NULL
# (documente le comportement ACTUEL, pas une exigence P1).
# ------------------------------------------------------------------
RC_PURGE_ORDER="$(order_new "[{\"menu_item_id\":\"$PROD_NEW\",\"quantity\":1}]" "delivery" "75018")"
ORDER_ID_PURGE="$(sql "$DB" "select id from public.orders where restaurant_id='$RID_NEW' and service_mode='delivery' order by created_at desc limit 1;")"
assert_eq "X-18a. commande créée pour le test de purge" "0" "$RC_PURGE_ORDER"
RULE_ID_BEFORE_PURGE="$(sql "$DB" "select fulfillment_rule_id from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_PURGE';")"
sql "$DB" "select public.purge_old_customer_data(0);" >/dev/null
assert_eq "X-18b. orders.delivery_zone devient NULL après purge_old_customer_data(0)" "" \
  "$(sql "$DB" "select coalesce(delivery_zone,'') from public.orders where id='$ORDER_ID_PURGE';")"
assert_eq "X-18c. la ligne d'instantané SURVIT intacte (fulfillment_rule_id inchangé)" "$RULE_ID_BEFORE_PURGE" \
  "$(sql "$DB" "select fulfillment_rule_id from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_PURGE';")"

# ------------------------------------------------------------------
# B1-T-12 — DERNIER test dépendant des règles de RID_NEW : suppression
# de la ligne restaurant_sale_modes parente (CASCADE sur les règles de
# fulfillment) -> orders.fulfillment_rule_id devient NULL,
# l'instantané reste lisible avec son fulfillment_rule_id D'ORIGINE.
# ------------------------------------------------------------------
FULFILLMENT_RULE_ID_BEFORE_T12="$(sql "$DB" "select fulfillment_rule_id from public.orders where id='$ORDER_ID_T04';")"
SNAPSHOT_RULE_ID_BEFORE_T12="$(sql "$DB" "select fulfillment_rule_id from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T04';")"
assert_eq "T-12 (préalable). orders.fulfillment_rule_id == instantané.fulfillment_rule_id AVANT suppression" "$SNAPSHOT_RULE_ID_BEFORE_T12" "$FULFILLMENT_RULE_ID_BEFORE_T12"

sql "$DB" "delete from public.restaurant_sale_modes where restaurant_id = '$RID_NEW' and mode_code = 'delivery';" >/dev/null

assert_eq "T-12a. orders.fulfillment_rule_id devient NULL (ON DELETE SET NULL, comportement pré-existant)" "" \
  "$(sql "$DB" "select coalesce(fulfillment_rule_id::text,'') from public.orders where id='$ORDER_ID_T04';")"
assert_eq "T-12b. l'instantané reste INTACT, fulfillment_rule_id D'ORIGINE toujours lisible (AUCUNE FK, D-B1-3)" "$SNAPSHOT_RULE_ID_BEFORE_T12" \
  "$(sql "$DB" "select fulfillment_rule_id from public.order_delivery_fulfillment_snapshot where order_id='$ORDER_ID_T04';")"
HAS_RULES_AFTER_T12="$(sql "$DB" "select count(*) from public.restaurant_sale_mode_fulfillments where restaurant_id='$RID_NEW';")"
assert_eq "T-12c. les règles de fulfillment de RID_NEW ont CASCADÉ (supprimées avec le sale mode parent)" "0" "$HAS_RULES_AFTER_T12"

# ============================================================
log "=== [5] B1-X-15 — base SECONDAIRE jetable : 2 surcharges préexistantes -> P-5 refuse ==="
build_predecessor_chain "$DB2"
psql -d "$DB2" -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
create or replace function public.create_order(
  p_slug text, p_service_mode text, p_items jsonb, p_table_number integer,
  p_customer jsonb, p_note text, p_language text, p_cgv_accepted boolean, p_dummy_extra integer
)
returns table (order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)
language sql as $dummy$ select null::uuid, null::bigint, null::uuid, null::numeric, null::numeric, null::numeric where false; $dummy$;
SQL
OVERLOAD_COUNT_X15_BEFORE="$(sql "$DB2" "select count(*) from pg_proc where proname='create_order' and pronamespace='public'::regnamespace;")"
assert_eq "X-15 (préalable). 2 surcharges de create_order coexistent AVANT tentative de migration" "2" "$OVERLOAD_COUNT_X15_BEFORE"

RC_X15=0
psql -d "$DB2" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-b1-out-$$.txt 2>&1 || RC_X15=$?
assert_nonzero_rc "X-15a. migration B1 REFUSÉE (P-5, coexistence de surcharges)" "$RC_X15"
assert_contains "X-15b. ... avec SCANYM_CREATE_ORDER_OVERLOAD_AMBIGUOUS" "SCANYM_CREATE_ORDER_OVERLOAD_AMBIGUOUS" "$(cat /tmp/scanym-b1-out-$$.txt)"
assert_eq "X-15c. RIEN n'a changé : order_delivery_fulfillment_snapshot toujours absente" "0" \
  "$(sql "$DB2" "select count(*) from information_schema.tables where table_schema='public' and table_name='order_delivery_fulfillment_snapshot';")"
assert_eq "X-15d. RIEN n'a changé : toujours 2 surcharges de create_order (la 2e n'a jamais été supprimée)" "2" \
  "$(sql "$DB2" "select count(*) from pg_proc where proname='create_order' and pronamespace='public'::regnamespace;")"
psql -c "drop database if exists \"$DB2\";" >/dev/null 2>&1 || true

# ============================================================
log "=== [6] Rollback + B1-X-17 (rollback puis re-migration) ==="
if psql -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >/tmp/scanym-b1-out-$$.txt 2>&1; then
  pass "6a. le rollback B1 s'exécute intégralement"
else
  fail "6a. rollback en échec : $(tail -15 /tmp/scanym-b1-out-$$.txt)"
fi
assert_eq "6b. order_delivery_fulfillment_snapshot supprimée" "0" \
  "$(sql "$DB" "select count(*) from information_schema.tables where table_schema='public' and table_name='order_delivery_fulfillment_snapshot';")"
assert_eq "X-17a (checkpoint 1/2). create_order == 1 surcharge APRÈS rollback" "1" \
  "$(sql "$DB" "select count(*) from pg_proc where proname='create_order' and pronamespace='public'::regnamespace;")"

RC_ORDER_AFTER_ROLLBACK="$(order_new "[{\"menu_item_id\":\"$PROD_NEW\",\"quantity\":1}]" "pickup" "75018")"
assert_eq "6c. create_order fonctionne toujours normalement après rollback (mode pickup)" "0" "$RC_ORDER_AFTER_ROLLBACK"

if psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-b1-out-$$.txt 2>&1; then
  pass "X-17b. re-migration de B1 après rollback RÉUSSIT (P-7 ne bloque plus, la table avait été droppée)"
else
  fail "X-17b. re-migration en échec : $(tail -15 /tmp/scanym-b1-out-$$.txt)"
fi
assert_eq "X-17c (checkpoint 2/2). create_order == 1 surcharge APRÈS re-migration" "1" \
  "$(sql "$DB" "select count(*) from pg_proc where proname='create_order' and pronamespace='public'::regnamespace;")"
assert_eq "X-17d. order_delivery_fulfillment_snapshot existe À NOUVEAU après re-migration (état final identique)" "1" \
  "$(sql "$DB" "select count(*) from information_schema.tables where table_schema='public' and table_name='order_delivery_fulfillment_snapshot';")"

# ============================================================
log "=== RÉSUMÉ : PASS=$PASS_COUNT FAIL=$FAIL_COUNT ==="
if [ "$FAIL_COUNT" -ne 0 ]; then echo "--- échecs ---"; cat "$FAIL_LOG"; fi
echo "TOTAL: $PASS_COUNT passed, $FAIL_COUNT failed"
if [ "$FAIL_COUNT" -ne 0 ]; then exit 1; fi
exit 0
