#!/usr/bin/env bash
# ============================================================
# Scanym — PRODUCT SERVICE MODES v1 — harnais SQL RÉEL
# (PostgreSQL réel, base jetable, aucune simulation).
#
# Même idiome que supabase/tests/delivery-country-scope-v1-check.sh
# (bootstrap, chaîne minimale, émulation des rôles et de auth.uid()).
# Chaîne reprise jusqu'à DELIVERY COUNTRY SCOPE v1 (baseline main
# actuelle, dernière redéfinition connue de create_order), puis ce lot
# (PRODUCT SERVICE MODES v1) est appliqué et vérifié, puis son
# ROLLBACK.
#
# Usage depuis la racine du dépôt :
#   su postgres -c "bash supabase/tests/product-service-modes-v1-check.sh"
# ============================================================
set -uo pipefail

SUPABASE_DIR="${SUPABASE_DIR:-supabase}"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-product-service-modes-v1.sql"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-product-service-modes-v1-ROLLBACK.sql"
PREDECESSOR_SQL="$SUPABASE_DIR/DRAFT-lot-delivery-country-scope-v1.sql"
DB="scanym_psm_$$"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-psm-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" /tmp/scanym-psm-out-$$.txt /tmp/scanym-psm-err-$$.txt 2>/dev/null || true
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
assert_nonzero_rc() {
  local d="$1" rc="$2"
  if [ "$rc" != "0" ]; then pass "$d (rc=$rc, refusé comme attendu)"; else fail "$d — a RÉUSSI alors qu'il devait être refusé"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }
sql_rc() {
  psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-psm-out-$$.txt 2>/tmp/scanym-psm-err-$$.txt
  echo $?
}
as_user() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$1'; $2" 2>&1
}
as_user_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$1'; $2" \
    >/tmp/scanym-psm-out-$$.txt 2>/tmp/scanym-psm-err-$$.txt
  echo $?
}
as_anon() { PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" \
    >/tmp/scanym-psm-out-$$.txt 2>/tmp/scanym-psm-err-$$.txt
  echo $?
}
last_err() { cat /tmp/scanym-psm-err-$$.txt 2>/dev/null; }
last_out() { cat /tmp/scanym-psm-out-$$.txt 2>/dev/null; }

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
# supabase/tests/delivery-country-scope-v1-check.sh (harnais du lot
# ayant publié la baseline actuelle de create_order sur main), PLUS
# DRAFT-lot-delivery-country-scope-v1.sql lui-même (devenu prédécesseur
# pour ce lot, puisqu'il est déjà sur main).
# ------------------------------------------------------------------
MINIMAL_CHAIN="schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql"
REST_CHAIN="migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql migration-v72-hardening.sql migration-v73-hardening.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql DRAFT-lot-payment-p1-foundation.sql DRAFT-lot-merchant-delivery-pricing.sql DRAFT-lot-orders-service-role-select-hardening.sql"
CGV_AFTER_N1A_CHAIN="DRAFT-lot-seller-legal-profile-cgv-engine-v1-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-3.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-1.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql"
TRACKING_TAIL="DRAFT-lot-tracking-final-fiscal-summary-v1-1.sql DRAFT-lot-customer-tracking-capability-v3-1.sql DRAFT-lot-customer-contact-live-tracking-v1.sql"

ERR="/tmp/scanym-psm-chain-$$.err"
apply_file() { psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$1" >/dev/null 2>"$ERR"; }
fatal() { echo "FATAL: $*"; exit 1; }

for f in $MINIMAL_CHAIN $REST_CHAIN DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql \
         DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql $CGV_AFTER_N1A_CHAIN \
         DRAFT-lot-order-received-enqueue-recovery-v1.sql \
         migration-20260919000000-order-success-boundary-v1.sql $TRACKING_TAIL \
         DRAFT-lot-customer-followup-tracking-email-v1.sql \
         DRAFT-lot-online-withdrawal-foundation-v1.sql \
         DRAFT-lot-online-withdrawal-v1-1-cgv-mixed-regime.sql \
         DRAFT-lot-delivery-country-scope-v1.sql; do
  [ -f "$SUPABASE_DIR/$f" ] || fatal "maillon de chaîne absent : supabase/$f"
done

# ============================================================
log "=== [0] Baseline ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_common_bootstrap "$DB"

for f in $MINIMAL_CHAIN; do
  apply_file "$f" || fatal "chaîne, $f : $(head -3 "$ERR" | tr '\n' ' ')"
  psql -X -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in $REST_CHAIN; do
  apply_file "$f" || fatal "chaîne, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
apply_file "DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql" || fatal "CGV v1.1 : $(head -3 "$ERR" | tr '\n' ' ')"
apply_file "DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql" || fatal "N1-A : $(head -3 "$ERR" | tr '\n' ' ')"
for f in $CGV_AFTER_N1A_CHAIN; do
  apply_file "$f" || fatal "chaîne CGV, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
psql -X -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
apply_file "DRAFT-lot-order-received-enqueue-recovery-v1.sql" || fatal "reprise d'enfilement : $(head -3 "$ERR" | tr '\n' ' ')"
apply_file "migration-20260919000000-order-success-boundary-v1.sql" || fatal "ORDER SUCCESS BOUNDARY v1 : $(head -3 "$ERR" | tr '\n' ' ')"

psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<'SQL' || fatal "talon order_invoice_request"
create table public.order_invoice_request (
  order_id uuid primary key references public.orders(id) on delete cascade
);
alter table public.order_invoice_request enable row level security;
revoke all on table public.order_invoice_request from public, anon, authenticated;
SQL
for f in $TRACKING_TAIL; do
  apply_file "$f" || fatal "chaîne de suivi, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
apply_file "DRAFT-lot-customer-followup-tracking-email-v1.sql" || fatal "CFTE v1 : $(head -3 "$ERR" | tr '\n' ' ')"
apply_file "DRAFT-lot-online-withdrawal-foundation-v1.sql" || fatal "ONLINE WITHDRAWAL FOUNDATION v1 : $(head -3 "$ERR" | tr '\n' ' ')"
apply_file "DRAFT-lot-online-withdrawal-v1-1-cgv-mixed-regime.sql" || fatal "ONLINE WITHDRAWAL v1.1 : $(head -3 "$ERR" | tr '\n' ' ')"
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$PREDECESSOR_SQL" >/dev/null 2>"$ERR" || fatal "DELIVERY COUNTRY SCOPE v1 (prédécesseur) : $(head -5 "$ERR" | tr '\n' ' ')"
log "chaîne prédécesseur appliquée (baseline main actuelle)."

HAS_CREATE_ORDER_BEFORE="$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order';")"
assert_eq "0a. baseline : create_order présente" "1" "$HAS_CREATE_ORDER_BEFORE"
HAS_MISM_BEFORE="$(sql "select count(*) from information_schema.tables where table_schema='public' and table_name='menu_item_sale_modes';")"
assert_eq "0b. baseline : menu_item_sale_modes ABSENTE avant le lot" "0" "$HAS_MISM_BEFORE"

# ============================================================
log "=== [1] Application du lot ==="
if psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-psm-out-$$.txt 2>&1; then
  pass "1a. le lot s'applique intégralement (contrôles post-application passés)"
else
  fail "1a. échec : $(tail -8 /tmp/scanym-psm-out-$$.txt)"
fi

# ============================================================
log "=== FIXTURES ==="
OWNER_ALC="80000000-0000-0000-0000-0000000000b1"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values ('$OWNER_ALC','owner@aulaitcru.test');
insert into public.restaurants (name, slug, status, is_active, country) values
  ('Au lait cru','au-lait-cru-psm','active', true, 'FR');
SQL
RID_ALC="$(sql "select id from public.restaurants where slug='au-lait-cru-psm';")"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into public.restaurant_users (restaurant_id, user_id, role) values ('$RID_ALC','$OWNER_ALC','owner');
insert into public.restaurant_configs (restaurant_id, whatsapp_number, currency, next_order_number)
  values ('$RID_ALC','+33600000000','EUR',1);
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config) values
  ('$RID_ALC','delivery', true, '{}'::jsonb), ('$RID_ALC','pickup', true, '{}'::jsonb);
insert into public.restaurant_sale_mode_fulfillments
  (restaurant_id, mode_code, fulfillment_code, provider, enabled, display_order, zone_prefixes, pricing_mode, fixed_fee, customer_text)
values ('$RID_ALC','delivery','local_delivery','internal', true, 1, '{"75"}'::text[], 'fixed', 4.90, 'Livraison');
insert into public.restaurant_delivery_countries (restaurant_id, country_code) values ('$RID_ALC','FR');
SQL
CAT_ALC="$(sql "insert into public.menu_categories (restaurant_id, name, display_order) values ('$RID_ALC','Produits',1) returning id;")"

# ============================================================
log "=== [2] create_product / update_product — validation p_allowed_sale_modes ==="

# 2a. NULL (défaut) => ALL, aucune ligne.
PROD_ALL="$(as_user "$OWNER_ALC" "select public.create_product('$CAT_ALC','Comte',null,10.00);")"
assert_eq "2a. produit créé sans p_allowed_sale_modes : aucune ligne de restriction" "0" \
  "$(sql "select count(*) from public.menu_item_sale_modes where menu_item_id='$PROD_ALL';")"

# 2b. Tableau non-NULL VIDE => erreur explicite, jamais un repli ALL.
RC_EMPTY="$(as_user_rc "$OWNER_ALC" "select public.create_product('$CAT_ALC','Oeufs vides',null,3.00,null,null,null,false,null,false,array[]::text[]);")"
assert_nonzero_rc "2b. tableau non-NULL VIDE refusé (jamais un repli silencieux sur ALL)" "$RC_EMPTY"
assert_contains "2c. ... avec SCANYM_SERVICE_MODES_EMPTY_RESTRICTION" "SCANYM_SERVICE_MODES_EMPTY_RESTRICTION" "$(last_err)"

# 2d. Mode NON activé pour l'établissement (room_service existe au
#     catalogue mais n'est PAS dans restaurant_sale_modes pour ALC) => refusé.
RC_FOREIGN="$(as_user_rc "$OWNER_ALC" "select public.create_product('$CAT_ALC','Oeufs invalides',null,3.00,null,null,null,false,null,false,array['room_service']);")"
assert_nonzero_rc "2d. mode non-activé pour l'établissement refusé" "$RC_FOREIGN"
assert_contains "2e. ... avec SCANYM_INVALID_SALE_MODE_FOR_ESTABLISHMENT" "SCANYM_INVALID_SALE_MODE_FOR_ESTABLISHMENT" "$(last_err)"

# 2f. Restriction valide (pickup uniquement) => 1 ligne.
PROD_PICKUP_ONLY="$(as_user "$OWNER_ALC" "select public.create_product('$CAT_ALC','Oeufs',null,3.00,null,null,null,false,null,false,array['pickup']);")"
assert_eq "2f. produit restreint à pickup : 1 ligne de restriction" "pickup" \
  "$(sql "select mode_code from public.menu_item_sale_modes where menu_item_id='$PROD_PICKUP_ONLY';")"

# 2g. Doublons dédoublonnés silencieusement (jamais une erreur de contrainte).
PROD_DUP="$(as_user "$OWNER_ALC" "select public.create_product('$CAT_ALC','Lait cru',null,4.00,null,null,null,false,null,false,array['pickup','pickup']);")"
assert_eq "2g. doublons dans p_allowed_sale_modes dédoublonnés (1 ligne, pas d'erreur)" "1" \
  "$(sql "select count(*) from public.menu_item_sale_modes where menu_item_id='$PROD_DUP';")"

# 2h. update_product : ajouter une restriction à un produit ALL.
as_user "$OWNER_ALC" "select public.update_product('$PROD_ALL','Comte',null,10.00,null,null,null,false,null,false,array['pickup']);" >/dev/null
assert_eq "2h. update_product AJOUTE une restriction (ALL -> pickup)" "pickup" \
  "$(sql "select mode_code from public.menu_item_sale_modes where menu_item_id='$PROD_ALL';")"

# 2i. update_product : clear (NULL) retire toute restriction -> ALL.
as_user "$OWNER_ALC" "select public.update_product('$PROD_ALL','Comte',null,10.00,null,null,null,false,null,false,null);" >/dev/null
assert_eq "2i. update_product avec NULL retire les lignes (retour à ALL)" "0" \
  "$(sql "select count(*) from public.menu_item_sale_modes where menu_item_id='$PROD_ALL';")"

# 2j. update_product : remplacement intégral (pickup -> delivery), jamais un delta partiel.
as_user "$OWNER_ALC" "select public.update_product('$PROD_PICKUP_ONLY','Oeufs',null,3.00,null,null,null,false,null,false,array['delivery']);" >/dev/null
assert_eq "2j. update_product REMPLACE (pickup -> delivery, jamais un cumul)" "delivery" \
  "$(sql "select mode_code from public.menu_item_sale_modes where menu_item_id='$PROD_PICKUP_ONLY';")"
# Remise en configuration pickup-only pour la suite.
as_user "$OWNER_ALC" "select public.update_product('$PROD_PICKUP_ONLY','Oeufs',null,3.00,null,null,null,false,null,false,array['pickup']);" >/dev/null

# ============================================================
log "=== [3] get_merchant_catalogue — allowed_sale_modes exposé ==="
CATALOGUE_ROW="$(as_user "$OWNER_ALC" "select allowed_sale_modes from public.get_merchant_catalogue('$RID_ALC') where product_id='$PROD_PICKUP_ONLY';")"
assert_eq "3a. get_merchant_catalogue expose {pickup} pour le produit restreint" "{pickup}" "$CATALOGUE_ROW"
CATALOGUE_ROW_ALL="$(as_user "$OWNER_ALC" "select coalesce(allowed_sale_modes::text,'NULL') from public.get_merchant_catalogue('$RID_ALC') where product_id='$PROD_ALL';")"
assert_eq "3b. get_merchant_catalogue expose NULL (ALL) pour le produit non restreint" "NULL" "$CATALOGUE_ROW_ALL"

# ============================================================
log "=== [4] RLS — lecture publique, aucune écriture directe ==="
PUB_READ="$(as_anon "select mode_code from public.menu_item_sale_modes where menu_item_id='$PROD_PICKUP_ONLY';")"
assert_eq "4a. anon peut LIRE la restriction (établissement actif) — aussi public que is_available" "pickup" "$PUB_READ"
RC_DIRECT_WRITE="$(as_user_rc "$OWNER_ALC" "insert into public.menu_item_sale_modes (menu_item_id, mode_code) values ('$PROD_ALL','delivery');")"
assert_nonzero_rc "4b. écriture DIRECTE refusée même pour le propriétaire (RPC uniquement)" "$RC_DIRECT_WRITE"
RC_ANON_WRITE="$(as_anon_rc "insert into public.menu_item_sale_modes (menu_item_id, mode_code) values ('$PROD_ALL','delivery');")"
assert_nonzero_rc "4c. écriture DIRECTE anon refusée" "$RC_ANON_WRITE"

# ============================================================
log "=== [5] create_order — enforcement par ligne + snapshot ==="

order_alc() {
  # $1 = JSON items, $2 = service_mode
  as_anon_rc "select * from public.create_order('au-lait-cru-psm','$2', '$1'::jsonb, null, '{\"first_name\":\"Victor\",\"last_name\":\"Hugo\",\"name\":\"Victor Hugo\",\"phone\":\"0612345678\",\"email\":\"victor.hugo@example.test\",\"address\":\"12 rue Ordener, 75018 Paris\",\"postalCode\":\"75018\",\"street\":\"12 rue Ordener\",\"city\":\"Paris\",\"country\":\"FR\"}'::jsonb, null, 'fr', false);"
}

# 5a. produit ALL, mode delivery : accepté.
ITEMS_ALL="[{\"menu_item_id\":\"$PROD_ALL\",\"quantity\":1}]"
RC_ALL_DELIVERY="$(order_alc "$ITEMS_ALL" "delivery")"
assert_eq "5a. produit ALL + delivery : commande ACCEPTÉE" "0" "$RC_ALL_DELIVERY"
assert_eq "5b. snapshot service_mode_eligible_at_order_time = true" "t" \
  "$(sql "select oi.service_mode_eligible_at_order_time from public.order_items oi join public.orders o on o.id=oi.order_id where o.restaurant_id='$RID_ALC' order by o.created_at desc limit 1;")"

# 5c. produit pickup-only, mode delivery : REFUSÉ.
ITEMS_PICKUP_ONLY="[{\"menu_item_id\":\"$PROD_PICKUP_ONLY\",\"quantity\":1}]"
ORDERS_BEFORE_5C="$(sql "select count(*) from public.orders where restaurant_id='$RID_ALC';")"
RC_PICKUP_DELIVERY="$(order_alc "$ITEMS_PICKUP_ONLY" "delivery")"
assert_nonzero_rc "5c. produit pickup-only + delivery : commande REFUSÉE" "$RC_PICKUP_DELIVERY"
assert_contains "5d. ... avec SCANYM_PRODUCT_NOT_AVAILABLE_FOR_SERVICE_MODE" "SCANYM_PRODUCT_NOT_AVAILABLE_FOR_SERVICE_MODE" "$(last_err)"
assert_eq "5e. AUCUNE commande écrite par le refus (rollback transactionnel complet)" "$ORDERS_BEFORE_5C" \
  "$(sql "select count(*) from public.orders where restaurant_id='$RID_ALC';")"

# 5f. produit pickup-only, mode pickup : accepté.
RC_PICKUP_PICKUP="$(order_alc "$ITEMS_PICKUP_ONLY" "pickup")"
assert_eq "5f. produit pickup-only + pickup : commande ACCEPTÉE" "0" "$RC_PICKUP_PICKUP"

# 5g. panier MIXTE (1 produit ALL + 1 pickup-only), mode delivery : le
#     produit ALL ne sauve pas la commande -- refus intégral.
ITEMS_MIXED="[{\"menu_item_id\":\"$PROD_ALL\",\"quantity\":1},{\"menu_item_id\":\"$PROD_PICKUP_ONLY\",\"quantity\":1}]"
ORDERS_BEFORE_5G="$(sql "select count(*) from public.orders where restaurant_id='$RID_ALC';")"
RC_MIXED="$(order_alc "$ITEMS_MIXED" "delivery")"
assert_nonzero_rc "5g. panier mixte (ALL + pickup-only) + delivery : REFUSÉ intégralement" "$RC_MIXED"
assert_eq "5h. AUCUNE commande ni ligne partielle écrite (atomicité)" "$ORDERS_BEFORE_5G" \
  "$(sql "select count(*) from public.orders where restaurant_id='$RID_ALC';")"

# 5i. indépendance de withdrawal_eligible : un produit withdrawal_eligible=true
#     et sans restriction de mode n'est jamais bloqué par ce lot.
PROD_WD="$(as_user "$OWNER_ALC" "select public.create_product('$CAT_ALC','Plateau reutilisable',null,5.00,null,null,null,false,null,true);")"
ITEMS_WD="[{\"menu_item_id\":\"$PROD_WD\",\"quantity\":1}]"
RC_WD="$(order_alc "$ITEMS_WD" "delivery")"
assert_eq "5i. produit withdrawal_eligible=true, aucune restriction de mode : ACCEPTÉ (attributs indépendants)" "0" "$RC_WD"
assert_eq "5j. withdrawal_eligible du produit inchangé par ce lot" "t" \
  "$(sql "select withdrawal_eligible from public.menu_items where id='$PROD_WD';")"

# ============================================================
log "=== [6] Rollback ==="
if psql -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >/tmp/scanym-psm-out-$$.txt 2>&1; then
  pass "6a. le rollback s'exécute intégralement"
else
  fail "6a. rollback en échec : $(tail -8 /tmp/scanym-psm-out-$$.txt)"
fi
assert_eq "6b. menu_item_sale_modes supprimée" "0" \
  "$(sql "select count(*) from information_schema.tables where table_schema='public' and table_name='menu_item_sale_modes';")"
assert_eq "6c. order_items.service_mode_eligible_at_order_time supprimée" "0" \
  "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='order_items' and column_name='service_mode_eligible_at_order_time';")"
assert_eq "6d. create_product ne porte plus p_allowed_sale_modes" "0" \
  "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_product' and pg_get_function_identity_arguments(p.oid) like '%p_allowed_sale_modes%';")"

# ============================================================
log "=== RÉSUMÉ : PASS=$PASS_COUNT FAIL=$FAIL_COUNT ==="
if [ "$FAIL_COUNT" -ne 0 ]; then echo "--- échecs ---"; cat "$FAIL_LOG"; exit 1; fi
exit 0
