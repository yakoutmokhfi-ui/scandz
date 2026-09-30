#!/usr/bin/env bash
# ============================================================
# Scanym — DELIVERY PRICING v2 — B1 — ORDER DELIVERY FULFILLMENT
# SNAPSHOT v1 — harnais SQL RÉEL (PostgreSQL réel, base jetable,
# aucune simulation, aucune Production, aucune PREPROD).
#
# Contrat : Debussy, CONTRACT_SHA256
#   aac856732ff48aef5b69bcf6c65fb91a88754e95756587512ed0b453e28ec517
# Mandat  : yakoutmokhfi-ui/scanym-orchestrator issue #17.
#
# Chaîne reprise VERBATIM de supabase/tests/product-service-modes-v1-check.sh
# (bootstrap, rôles, auth.uid()), jusqu'à DRAFT-lot-product-service-modes-v1.sql
# inclus — définition de create_order dont md5(pg_get_functiondef) égale
# la valeur relevée sur Production (G-1, issue #17) ; le harnais la
# re-mesure et l'affiche. Puis : commandes ANTÉRIEURES (K5), migration
# B1, matrice B1-T-01..16, B1-X-01..18, non-régression B1-T-21/23/24,
# rollback et re-migration.
#
# Usage depuis la racine du dépôt :
#   su postgres -c "bash supabase/tests/delivery-pricing-v2-b1-order-snapshot-v1-check.sh"
# ============================================================
set -uo pipefail

SUPABASE_DIR="${SUPABASE_DIR:-supabase}"
B1_SQL="$SUPABASE_DIR/DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1.sql"
B1_ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1-ROLLBACK.sql"
PSM_SQL="$SUPABASE_DIR/DRAFT-lot-product-service-modes-v1.sql"
VAT_SQL="$SUPABASE_DIR/DRAFT-lot-delivery-fee-vat-allocation-foundation-v1.sql"
PREDECESSOR_SQL="$SUPABASE_DIR/DRAFT-lot-delivery-country-scope-v1.sql"
DB="scanym_b1_$$"
DB_PRE="scanym_b1_pre_$$"
DB_AUX="scanym_b1_aux_$$"
LIVE_CREATE_ORDER_MD5="cb49eebb3b3119d3d76473af480e78d8"
LIVE_RESOLVER_MD5="0277502f9f1647d6866b2b1d5fd2a994"

# Cible LOCALE uniquement : jamais une base distante.
if [ -n "${DATABASE_URL:-}${PGHOSTADDR:-}${PGSERVICE:-}" ]; then
  echo "FATAL: DATABASE_URL/PGHOSTADDR/PGSERVICE définis — harnais réservé à une base LOCALE jetable."; exit 1
fi
case "${PGHOST:-}" in
  ""|/*|localhost|127.0.0.1|::1) ;;
  *) echo "FATAL: PGHOST=$PGHOST n'est ni un socket local ni loopback — refus."; exit 1 ;;
esac

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-b1-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }

cleanup() {
  for d in "$DB" "$DB_PRE" "$DB_AUX" "${DB_AUX}_x15" "${DB_AUX}_vat" "${DB_AUX}_vatb1" "${DB_AUX}_b5"; do
    psql -c "drop database if exists \"$d\";" >/dev/null 2>&1 || true
  done
  rm -f "${FAIL_LOG:-}" /tmp/scanym-b1-out-$$.txt /tmp/scanym-b1-err-$$.txt /tmp/scanym-b1-chain-$$.err /tmp/scanym-b1-par-$$-* 2>/dev/null || true
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
  psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-b1-out-$$.txt 2>/tmp/scanym-b1-err-$$.txt
  echo $?
}
as_user() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$1'; $2" 2>&1
}
as_user_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$1'; $2" \
    >/tmp/scanym-b1-out-$$.txt 2>/tmp/scanym-b1-err-$$.txt
  echo $?
}
as_anon() { PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" \
    >/tmp/scanym-b1-out-$$.txt 2>/tmp/scanym-b1-err-$$.txt
  echo $?
}
as_service_rc() {
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$1" \
    >/tmp/scanym-b1-out-$$.txt 2>/tmp/scanym-b1-err-$$.txt
  echo $?
}
last_err() { cat /tmp/scanym-b1-err-$$.txt 2>/dev/null; }
last_out() { cat /tmp/scanym-b1-out-$$.txt 2>/dev/null; }

# Empreintes : fonction (md5 de pg_get_functiondef), toutes les autres
# fonctions publiques, structure de orders.
fn_md5() { psql -X -A -q -t -d "${2:-$DB}" -c "select md5(pg_get_functiondef('$1'::regprocedure));"; }
CO_SIG="public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)"
RES_SIG="public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)"
other_fns_md5() {
  psql -X -A -q -t -d "${1:-$DB}" -c "select md5(string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)), '|' order by p.oid::regprocedure::text)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname <> 'create_order';"
}
orders_shape_md5() {
  psql -X -A -q -t -d "${1:-$DB}" -c "select md5(coalesce((select string_agg(column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,''), '|' order by column_name) from information_schema.columns where table_schema='public' and table_name='orders'),'') || coalesce((select string_agg(conname||':'||pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid='public.orders'::regclass),'') || coalesce((select string_agg(tgname, '|' order by tgname) from pg_trigger where tgrelid='public.orders'::regclass and not tgisinternal),''));"
}
co_count() { psql -X -A -q -t -d "${1:-$DB}" -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order';"; }
snap_count() { sql "select count(*) from public.order_delivery_fulfillment_snapshot;"; }
order_count() { sql "select count(*) from public.orders;"; }

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

ERR="/tmp/scanym-b1-chain-$$.err"
apply_file() { psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$1" >/dev/null 2>"$ERR"; }
fatal() { echo "FATAL: $*"; exit 1; }

for f in $MINIMAL_CHAIN $REST_CHAIN DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql \
         DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql $CGV_AFTER_N1A_CHAIN \
         DRAFT-lot-order-received-enqueue-recovery-v1.sql \
         migration-20260919000000-order-success-boundary-v1.sql $TRACKING_TAIL \
         DRAFT-lot-customer-followup-tracking-email-v1.sql \
         DRAFT-lot-online-withdrawal-foundation-v1.sql \
         DRAFT-lot-online-withdrawal-v1-1-cgv-mixed-regime.sql \
         DRAFT-lot-delivery-country-scope-v1.sql DRAFT-lot-product-service-modes-v1.sql \
         DRAFT-lot-delivery-fee-vat-allocation-foundation-v1.sql \
         DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1.sql \
         DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1-ROLLBACK.sql; do
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

# ------------------------------------------------------------------
# Prédécesseur immédiat : PRODUCT SERVICE MODES v1 (définition live).
# ------------------------------------------------------------------
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$PSM_SQL" >/dev/null 2>"$ERR" || fatal "PRODUCT SERVICE MODES v1 : $(head -5 "$ERR" | tr '\n' ' ')"
log "chaîne jusqu'à PRODUCT SERVICE MODES v1 appliquée (définition live de create_order)."

# ============================================================
log "=== [G-1] Ancrage sur la définition constatée en Production ==="
PRE_CO_MD5="$(fn_md5 "$CO_SIG")"
PRE_RES_MD5="$(fn_md5 "$RES_SIG")"
log "md5(pg_get_functiondef(create_order)) harnais = $PRE_CO_MD5 (Production G-1 : $LIVE_CREATE_ORDER_MD5)"
log "md5(pg_get_functiondef(resolve_delivery_fulfillment)) harnais = $PRE_RES_MD5 (Production G-1 : $LIVE_RESOLVER_MD5)"
assert_eq "G1a. create_order de base = définition Production (md5 pg_get_functiondef)" "$LIVE_CREATE_ORDER_MD5" "$PRE_CO_MD5"
assert_eq "G1b. resolve_delivery_fulfillment de base = définition Production" "$LIVE_RESOLVER_MD5" "$PRE_RES_MD5"
assert_eq "G1c. create_order : une seule surcharge avant B1" "1" "$(co_count)"
PRE_CO_SRC_MD5="$(sql "select md5(prosrc) from pg_proc where oid='$CO_SIG'::regprocedure;")"
PRE_CO_ACL="$(sql "select proacl::text from pg_proc where oid='$CO_SIG'::regprocedure;")"
PRE_CO_RESULT="$(sql "select pg_get_function_result('$CO_SIG'::regprocedure);")"
PRE_CO_ARGS="$(sql "select pg_get_function_arguments('$CO_SIG'::regprocedure);")"
PRE_OTHER_FNS="$(other_fns_md5)"
PRE_ORDERS_SHAPE="$(orders_shape_md5)"
PRE_TRACK_RESULT="$(sql "select pg_get_function_result('public.get_order_tracking_by_capability(uuid,uuid,text)'::regprocedure);")"

# ============================================================
log "=== FIXTURES ==="
OWNER_A="b1000000-0000-0000-0000-0000000000a1"
OWNER_C="b1000000-0000-0000-0000-0000000000c1"
STRANGER="b1000000-0000-0000-0000-0000000000ff"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values
  ('$OWNER_A','owner-a@b1.test'), ('$OWNER_C','owner-c@b1.test'), ('$STRANGER','stranger@b1.test');
insert into public.restaurants (name, slug, status, is_active, country) values
  ('B1 Zone','b1-zone','active', true, 'FR'),
  ('B1 Sans repli','b1-nofb','active', true, 'FR'),
  ('B1 Suppression','b1-del','active', true, 'FR'),
  ('B1 Legacy','b1-legacy','active', true, 'FR'),
  ('B1 Etranger','b1-other','active', true, 'FR');
SQL
RID_A="$(sql "select id from public.restaurants where slug='b1-zone';")"
RID_B="$(sql "select id from public.restaurants where slug='b1-nofb';")"
RID_C="$(sql "select id from public.restaurants where slug='b1-del';")"
RID_L="$(sql "select id from public.restaurants where slug='b1-legacy';")"
RID_O="$(sql "select id from public.restaurants where slug='b1-other';")"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('$RID_A','$OWNER_A','owner'), ('$RID_B','$OWNER_A','owner'), ('$RID_L','$OWNER_A','owner'),
  ('$RID_C','$OWNER_C','owner'), ('$RID_O','$STRANGER','owner');
insert into public.restaurant_configs (restaurant_id, whatsapp_number, currency, next_order_number)
select id, '+33600000000', 'EUR', 1 from public.restaurants where slug like 'b1-%';
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config) values
  ('$RID_A','delivery', true, '{}'::jsonb), ('$RID_A','pickup', true, '{}'::jsonb), ('$RID_A','table', true, '{}'::jsonb),
  ('$RID_B','delivery', true, '{}'::jsonb),
  ('$RID_C','delivery', true, '{}'::jsonb),
  ('$RID_L','delivery', true, '{"delivery_zone_prefixes":["75"]}'::jsonb);
insert into public.restaurant_delivery_countries (restaurant_id, country_code)
select id, 'FR' from public.restaurants where slug like 'b1-%';
-- RID_A : 3 règles de zone + 1 repli.
insert into public.restaurant_sale_mode_fulfillments
  (restaurant_id, mode_code, fulfillment_code, provider, enabled, display_order,
   zone_prefixes, is_fallback, min_items, pricing_mode, fixed_fee, free_threshold, customer_text)
values
  ('$RID_A','delivery','paris_fixed','internal', true, 1, '{"75","92"}'::text[], false, null, 'fixed', 4.90, null, 'Livraison Paris et 92'),
  ('$RID_A','delivery','lyon_threshold','internal', true, 2, '{"69"}'::text[], false, null, 'free_above_threshold', 5.00, 20.00, null),
  ('$RID_A','delivery','marseille_free','stuart', true, 3, '{"13"}'::text[], false, 3, 'free', null, null, 'Livraison offerte (3 articles min.)'),
  ('$RID_A','delivery','france_fallback','other_external', true, 9, '{}'::text[], true, null, 'fixed', 7.50, null, 'Livraison France (repli)'),
  ('$RID_B','delivery','paris_only','internal', true, 1, '{"75"}'::text[], false, null, 'fixed', 3.00, null, 'Paris uniquement'),
  ('$RID_C','delivery','del_rule','internal', true, 1, '{"75"}'::text[], false, null, 'fixed', 2.00, null, 'Règle à supprimer');
SQL
RULE_PARIS="$(sql "select id from public.restaurant_sale_mode_fulfillments where restaurant_id='$RID_A' and fulfillment_code='paris_fixed';")"
RULE_LYON="$(sql "select id from public.restaurant_sale_mode_fulfillments where restaurant_id='$RID_A' and fulfillment_code='lyon_threshold';")"
RULE_FB="$(sql "select id from public.restaurant_sale_mode_fulfillments where restaurant_id='$RID_A' and fulfillment_code='france_fallback';")"
RULE_DEL="$(sql "select id from public.restaurant_sale_mode_fulfillments where restaurant_id='$RID_C' and fulfillment_code='del_rule';")"

mk_item() { # $1 restaurant id, $2 nom, $3 prix
  local cat
  cat="$(sql "insert into public.menu_categories (restaurant_id, name, display_order) values ('$1','Cat $2',1) returning id;")"
  sql "insert into public.menu_items (category_id, name, price, is_available, display_order) values ('$cat','$2',$3,true,1) returning id;"
}
ITEM_A="$(mk_item "$RID_A" 'Plat A' 10.00)"
ITEM_A1999="$(mk_item "$RID_A" 'Plat A 19.99' 19.99)"
ITEM_B="$(mk_item "$RID_B" 'Plat B' 10.00)"
ITEM_C="$(mk_item "$RID_C" 'Plat C' 10.00)"
ITEM_L="$(mk_item "$RID_L" 'Plat L' 10.00)"

cust() { # $1 code postal (vide = absent), $2 ville
  printf '{"first_name":"Ada","last_name":"Lovelace","name":"Ada Lovelace","phone":"0612345678","email":"ada@example.test","address":"1 rue Test, %s %s","postalCode":"%s","street":"1 rue Test","city":"%s","country":"FR"}' "$1" "$2" "$1" "$2"
}
items() { printf '[{"menu_item_id":"%s","quantity":%s}]' "$1" "$2"; }

# create_order en anon ; sortie « order_id|subtotal|delivery_fee|total » dans last_out.
co() { # $1 slug, $2 mode, $3 items json, $4 table_number|null, $5 customer json
  as_anon_rc "select order_id||'|'||subtotal||'|'||delivery_fee||'|'||total from public.create_order('$1','$2','$3'::jsonb, $4, '$5'::jsonb, null, 'fr', false);"
}
oid_of() { printf '%s' "$(last_out)" | head -1 | cut -d'|' -f1; }
snap_of() { # $1 order id -> 7 faits instantanés
  sql "select fulfillment_rule_id||'|'||is_fallback||'|'||coalesce(matched_prefix,'<null>')||'|'||pricing_mode||'|'||coalesce(fixed_fee::text,'<null>')||'|'||coalesce(free_threshold::text,'<null>')||'|'||coalesce(customer_text,'<null>') from public.order_delivery_fulfillment_snapshot where order_id='$1';"
}
res_of() { # $1 rid, $2 code postal, $3 qty, $4 sous-total -> mêmes 7 faits via le résolveur appelé séparément
  sql "select fulfillment_rule_id||'|'||is_fallback||'|'||coalesce(matched_prefix,'<null>')||'|'||pricing_mode||'|'||coalesce(fixed_fee::text,'<null>')||'|'||coalesce(free_threshold::text,'<null>')||'|'||coalesce(customer_text,'<null>') from public.resolve_delivery_fulfillment('$1','delivery','$2',$3,$4);"
}

# ============================================================
log "=== [K5] Commandes ANTÉRIEURES à la migration ==="
RC="$(co b1-zone delivery "$(items "$ITEM_A" 1)" null "$(cust 75018 Paris)")"
assert_eq "K5a. commande de livraison (nouveau moteur) créée AVANT B1" "0" "$RC"
PRE_ORDER_NEW="$(oid_of)"
RC="$(co b1-legacy delivery "$(items "$ITEM_L" 1)" null "$(cust 75011 Paris)")"
assert_eq "K5b. commande de livraison (legacy) créée AVANT B1" "0" "$RC"
PRE_ORDER_LEGACY="$(oid_of)"
PRE_LEGACY_ROW="$(sql "select service_mode||'|'||subtotal||'|'||delivery_fee||'|'||total||'|'||coalesce(delivery_zone,'<null>')||'|'||coalesce(fulfillment_rule_id::text,'<null>')||'|'||coalesce(fulfillment_code,'<null>')||'|'||coalesce(provider_code,'<null>')||'|'||coalesce(delivery_address,'<null>')||'|'||coalesce(customer_name,'<null>') from public.orders where id='$PRE_ORDER_LEGACY';")"
PRE_ORDERS_TOTAL="$(order_count)"

# Gabarit pré-B1 (pour X-15 et B1-T-23), avant toute modification.
psql -c "create database \"$DB_PRE\" template \"$DB\";" >/dev/null 2>"$ERR" || fatal "gabarit pré-B1 : $(cat "$ERR")"

# ============================================================
log "=== [M] Application de la migration B1 ==="
if psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$B1_SQL" >/tmp/scanym-b1-out-$$.txt 2>&1; then
  pass "M1. la migration B1 s'applique intégralement (préflight P-1..P-7 et contrôles P-8 passés)"
else
  fail "M1. échec migration : $(tail -8 /tmp/scanym-b1-out-$$.txt)"; echo "FATAL"; exit 1
fi
POST_CO_SRC="$(sql "select md5(prosrc) from pg_proc where oid='$CO_SIG'::regprocedure;")"

log "=== [Preuves 8/9] create_order : surcharge unique, signature et retour inchangés ==="
assert_eq "P8a. create_order : exactement 1 surcharge après B1" "1" "$(co_count)"
assert_eq "P9a. arguments de create_order inchangés" "$PRE_CO_ARGS" "$(sql "select pg_get_function_arguments('$CO_SIG'::regprocedure);")"
assert_eq "P9b. table de retour de create_order inchangée" "$PRE_CO_RESULT" "$(sql "select pg_get_function_result('$CO_SIG'::regprocedure);")"
assert_eq "P9c. ACL de create_order inchangée (create or replace)" "$PRE_CO_ACL" "$(sql "select proacl::text from pg_proc where oid='$CO_SIG'::regprocedure;")"
assert_eq "P9d. security definer + search_path '' conservés" "true|search_path=\"\"" \
  "$(sql "select prosecdef||'|'||array_to_string(proconfig,',') from pg_proc where oid='$CO_SIG'::regprocedure;")"

log "=== [Corps inchangé à l'octet près hors delta §7.2] ==="
DELTA_CHECK="$(psql -X -A -q -t -d "$DB" -v pre="$DB_PRE" <<'SQL'
with post as (select prosrc as s from pg_proc where oid='public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)'::regprocedure),
b as (
  select s,
         position(E'\n\n  -- B1 — INSTANTANÉ IMMUABLE' in s) as a,
         position(E'      v_resolved.customer_text\n    );\n  end if;\n' in s) as z
  from post
)
select md5(substr(s, 1, a) || substr(s, z + length(E'      v_resolved.customer_text\n    );\n  end if;\n'))) from b;
SQL
)"
assert_eq "C1. prosrc(create_order après B1) privé du SEUL bloc §7.2 = prosrc(avant B1), octet pour octet" "$PRE_CO_SRC_MD5" "$DELTA_CHECK"
assert_eq "C2. resolve_delivery_fulfillment NON modifié" "$PRE_RES_MD5" "$(fn_md5 "$RES_SIG")"
assert_eq "C3. aucune autre fonction publique modifiée (empreinte globale)" "$PRE_OTHER_FNS" "$(other_fns_md5)"
assert_eq "C4. structure de public.orders (colonnes, contraintes, déclencheurs) inchangée" "$PRE_ORDERS_SHAPE" "$(orders_shape_md5)"
assert_eq "C5. aucune FK de l'instantané vers restaurant_sale_mode_fulfillments" "0" \
  "$(sql "select count(*) from pg_constraint where conrelid='public.order_delivery_fulfillment_snapshot'::regclass and contype='f' and confrelid='public.restaurant_sale_mode_fulfillments'::regclass;")"
assert_eq "C6. seule FK : order_id -> orders(id) on delete cascade" "orders|c" \
  "$(sql "select confrelid::regclass::text||'|'||confdeltype::text from pg_constraint where conrelid='public.order_delivery_fulfillment_snapshot'::regclass and contype='f';")"
assert_eq "C7. aucun CHECK énuméré sur pricing_mode ni CHECK iff matched_prefix/is_fallback" "0" \
  "$(sql "select count(*) from pg_constraint where conrelid='public.order_delivery_fulfillment_snapshot'::regclass and contype='c' and (pg_get_constraintdef(oid) ~* 'pricing_mode.*(=|in).*''(free|fixed)' or pg_get_constraintdef(oid) ~* 'is_fallback');")"

# ============================================================
log "=== [B1-T-14 / Preuve 10] Aucun backfill ==="
assert_eq "B1-T-14a. zéro ligne d'instantané juste après migration" "0" "$(snap_count)"
assert_eq "B1-T-14b. commande nouveau moteur antérieure : aucune ligne" "0" "$(sql "select count(*) from public.order_delivery_fulfillment_snapshot where order_id='$PRE_ORDER_NEW';")"
assert_eq "B1-T-14c. commande legacy antérieure : aucune ligne" "0" "$(sql "select count(*) from public.order_delivery_fulfillment_snapshot where order_id='$PRE_ORDER_LEGACY';")"

# ============================================================
log "=== [B1-T-01..03] Catégories K1/K2 : aucun instantané ==="
RC="$(co b1-zone table "$(items "$ITEM_A" 1)" 7 "$(cust '' '')")"
assert_eq "B1-T-01a. commande table créée" "0" "$RC"
O="$(oid_of)"
assert_eq "B1-T-01b. table : aucune ligne ; delivery_fee = 0" "0|0.00" \
  "$(sql "select (select count(*) from public.order_delivery_fulfillment_snapshot where order_id='$O')||'|'||delivery_fee from public.orders where id='$O';")"
[ "$RC" = "0" ] || log "   détail : $(last_err | head -2)"

RC="$(co b1-zone pickup "$(items "$ITEM_A" 1)" null "$(cust '' '')")"
assert_eq "B1-T-02a. commande pickup créée" "0" "$RC"
O="$(oid_of)"
assert_eq "B1-T-02b. pickup : aucune ligne" "0" "$(sql "select count(*) from public.order_delivery_fulfillment_snapshot where order_id='$O';")"
[ "$RC" = "0" ] || log "   détail : $(last_err | head -2)"

RC="$(co b1-legacy delivery "$(items "$ITEM_L" 1)" null "$(cust 75011 Paris)")"
assert_eq "B1-T-03a. livraison legacy créée" "0" "$RC"
O="$(oid_of)"
assert_eq "B1-T-03b. legacy : aucune ligne" "0" "$(sql "select count(*) from public.order_delivery_fulfillment_snapshot where order_id='$O';")"
assert_eq "B1-T-03c. legacy : ligne orders byte-identique à la commande pré-B1 équivalente" "$PRE_LEGACY_ROW" \
  "$(sql "select service_mode||'|'||subtotal||'|'||delivery_fee||'|'||total||'|'||coalesce(delivery_zone,'<null>')||'|'||coalesce(fulfillment_rule_id::text,'<null>')||'|'||coalesce(fulfillment_code,'<null>')||'|'||coalesce(provider_code,'<null>')||'|'||coalesce(delivery_address,'<null>')||'|'||coalesce(customer_name,'<null>') from public.orders where id='$O';")"

# ============================================================
log "=== [B1-T-04/05] Règle de zone, mode fixed ==="
RC="$(co b1-zone delivery "$(items "$ITEM_A" 1)" null "$(cust 92100 Boulogne)")"
assert_eq "B1-T-04a. livraison zone (92100) créée" "0" "$RC"
O_PARIS="$(oid_of)"
assert_eq "B1-T-04b. exactement 1 ligne" "1" "$(sql "select count(*) from public.order_delivery_fulfillment_snapshot where order_id='$O_PARIS';")"
assert_eq "B1-T-04c. les 7 faits = resolve_delivery_fulfillment appelé séparément (mêmes arguments)" \
  "$(res_of "$RID_A" 92100 1 10.00)" "$(snap_of "$O_PARIS")"
assert_eq "B1-T-05. fixed : matched_prefix NON nul (92), is_fallback=false, fixed_fee recopié, free_threshold nul" \
  "$RULE_PARIS|false|92|fixed|4.90|<null>|Livraison Paris et 92" "$(snap_of "$O_PARIS")"
assert_eq "B1-T-05b. orders.delivery_fee = 4.90, total = 14.90 ; version v1" "4.90|14.90|v1" \
  "$(sql "select o.delivery_fee||'|'||o.total||'|'||s.snapshot_method_version from public.orders o join public.order_delivery_fulfillment_snapshot s on s.order_id=o.id where o.id='$O_PARIS';")"
assert_eq "B1-T-05c. orders.delivery_zone garde sa sémantique (code postal client), intouchée par B1" "92100" \
  "$(sql "select delivery_zone from public.orders where id='$O_PARIS';")"

log "=== [B1-T-06] Règle de repli ==="
RC="$(co b1-zone delivery "$(items "$ITEM_A" 1)" null "$(cust 33000 Bordeaux)")"
assert_eq "B1-T-06a. livraison hors zones -> repli, commande créée" "0" "$RC"
O_FB="$(oid_of)"
assert_eq "B1-T-06b. repli : matched_prefix NUL, is_fallback=true, triplet du repli" \
  "$RULE_FB|true|<null>|fixed|7.50|<null>|Livraison France (repli)" "$(snap_of "$O_FB")"
assert_eq "B1-T-06c. delivery_fee = 7.50" "7.50" "$(sql "select delivery_fee from public.orders where id='$O_FB';")"

log "=== [B1-T-07/08/10] free_above_threshold, seuil exact et seuil − 0,01 ; customer_text nul ==="
RC="$(co b1-zone delivery "$(items "$ITEM_A" 2)" null "$(cust 69003 Lyon)")"
assert_eq "B1-T-07a. sous-total = seuil (20.00), commande créée" "0" "$RC"
O7="$(oid_of)"
assert_eq "B1-T-07b. delivery_fee = 0 au seuil exact" "20.00|0.00" "$(sql "select subtotal||'|'||delivery_fee from public.orders where id='$O7';")"
assert_eq "B1-T-07c. le triplet instantané reste celui de la règle" \
  "$RULE_LYON|false|69|free_above_threshold|5.00|20.00|<null>" "$(snap_of "$O7")"
RC="$(co b1-zone delivery "$(items "$ITEM_A1999" 1)" null "$(cust 69003 Lyon)")"
assert_eq "B1-T-08a. sous-total = seuil − 0,01, commande créée" "0" "$RC"
O8="$(oid_of)"
assert_eq "B1-T-08b. delivery_fee = fixed_fee (5.00)" "19.99|5.00" "$(sql "select subtotal||'|'||delivery_fee from public.orders where id='$O8';")"
assert_eq "B1-T-10. customer_text nul sur la règle -> ligne écrite, customer_text nul" "1|<null>" \
  "$(sql "select count(*)||'|'||coalesce(max(customer_text),'<null>') from public.order_delivery_fulfillment_snapshot where order_id='$O8';")"

log "=== [B1-T-09] pricing_mode = free ==="
RC="$(co b1-zone delivery "$(items "$ITEM_A" 3)" null "$(cust 13001 Marseille)")"
assert_eq "B1-T-09a. mode free (3 articles), commande créée" "0" "$RC"
O9="$(oid_of)"
assert_eq "B1-T-09b. delivery_fee = 0 ; fixed_fee et free_threshold NULS ; provider stuart sur orders" "0.00|stuart" \
  "$(sql "select delivery_fee||'|'||provider_code from public.orders where id='$O9';")"
assert_eq "B1-T-09c. instantané free" "free|<null>|<null>|13" \
  "$(sql "select pricing_mode||'|'||coalesce(fixed_fee::text,'<null>')||'|'||coalesce(free_threshold::text,'<null>')||'|'||matched_prefix from public.order_delivery_fulfillment_snapshot where order_id='$O9';")"

log "=== [B1-T-11] Commandes inéligibles : aucune commande, aucune ligne, erreurs inchangées ==="
N_ORD="$(order_count)"; N_SNAP="$(snap_count)"
RC="$(co b1-nofb delivery "$(items "$ITEM_B" 1)" null "$(cust 13001 Marseille)")"
assert_nonzero_rc "B1-T-11a. hors zone refusé" "$RC"
assert_contains "B1-T-11b. identité : SCANYM_OUT_OF_DELIVERY_ZONE" "SCANYM_OUT_OF_DELIVERY_ZONE: Zone non desservie: 13001" "$(last_err)"
RC="$(co b1-zone delivery "$(items "$ITEM_A" 1)" null "$(cust 13001 Marseille)")"
assert_nonzero_rc "B1-T-11c. sous le minimum refusé" "$RC"
assert_contains "B1-T-11d. identité : Minimum de 3 articles requis pour la livraison (reçu 1)" "Minimum de 3 articles requis pour la livraison (reçu 1)" "$(last_err)"
RC="$(co b1-zone delivery "$(items "$ITEM_A" 1)" null "$(cust '' Paris)")"
assert_nonzero_rc "B1-T-11e. sans code postal refusé" "$RC"
assert_contains "B1-T-11f. identité : Code postal absent de l'adresse" "Code postal absent de l'adresse" "$(last_err)"
assert_eq "B1-T-11g. aucune commande et aucune ligne créées" "$N_ORD|$N_SNAP" "$(order_count)|$(snap_count)"

# ============================================================
log "=== [B1-X-09] Payload client enrichi : aucun effet (B1-I-05) ==="
EVIL='{"first_name":"Ada","last_name":"Lovelace","name":"Ada Lovelace","phone":"0612345678","email":"ada@example.test","address":"1 rue Test, 92100 Boulogne","postalCode":"92100","street":"1 rue Test","city":"Boulogne","country":"FR","deliveryFee":0,"delivery_fee":0,"fulfillmentCode":"evil","providerCode":"evil","pricingMode":"free","matchedPrefix":"99","isFallback":true,"fixedFee":0,"customerText":"pwned"}'
RC="$(co b1-zone delivery "$(items "$ITEM_A" 1)" null "$EVIL")"
assert_eq "B1-X-09a. commande créée" "0" "$RC"
OX9="$(oid_of)"
assert_eq "B1-X-09b. instantané identique à celui d'une commande honnête" "$(snap_of "$O_PARIS")" "$(snap_of "$OX9")"
assert_eq "B1-X-09c. delivery_fee / fulfillment_code / provider_code serveur" "4.90|paris_fixed|internal" \
  "$(sql "select delivery_fee||'|'||fulfillment_code||'|'||provider_code from public.orders where id='$OX9';")"

# ============================================================
log "=== [B1-T-15] 10 commandes concurrentes, même règle, 10 connexions ==="
N_SNAP_BEFORE="$(snap_count)"
for i in 1 2 3 4 5 6 7 8 9 10; do
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" \
    -c "select order_id from public.create_order('b1-zone','delivery','$(items "$ITEM_A" 1)'::jsonb, null, '$(cust 75018 Paris)'::jsonb, null, 'fr', false);" \
    >/tmp/scanym-b1-par-$$-$i 2>&1 &
done
wait
PAR_OK="$(cat /tmp/scanym-b1-par-$$-* | grep -cE '^[0-9a-f-]{36}$')"
assert_eq "B1-T-15a. 10 commandes concurrentes créées" "10" "$PAR_OK"
assert_eq "B1-T-15b. 10 instantanés distincts ajoutés" "$((N_SNAP_BEFORE+10))" "$(snap_count)"
PAR_IDS="$(cat /tmp/scanym-b1-par-$$-* | grep -E '^[0-9a-f-]{36}$' | sed "s/.*/'&'/" | paste -sd, -)"
assert_eq "B1-T-15c. chacun cohérent avec son propre delivery_fee (fixed 4.90)" "10" \
  "$(sql "select count(*) from public.orders o join public.order_delivery_fulfillment_snapshot s on s.order_id=o.id where o.id in ($PAR_IDS) and s.pricing_mode='fixed' and s.fixed_fee=o.delivery_fee and s.matched_prefix='75' and s.fulfillment_rule_id='$RULE_PARIS';")"

# ============================================================
log "=== [B1-X-14 / B1-T-16] Résolveur substitué dans le harnais ==="
# Substitution TEMPORAIRE du résolveur (harnais uniquement) : le vrai est
# renommé, un faux de même signature le relaie en altérant une valeur.
swap_resolver() { # $1 = expression SQL de delivery_fee, $2 = expression de pricing_mode
  psql -X -q -d "${SWAP_DB:-$DB}" -v ON_ERROR_STOP=1 >/dev/null <<SQL
alter function public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric) rename to resolve_delivery_fulfillment_real;
create function public.resolve_delivery_fulfillment(p_restaurant_id uuid, p_mode_code text, p_postal_code text, p_total_count integer, p_subtotal numeric default null)
returns table (eligible boolean, fulfillment_rule_id uuid, fulfillment_code text, provider text, matched_prefix text, zone_prefixes text[], is_fallback boolean, min_items integer, customer_text text, display_order integer, pricing_mode text, fixed_fee numeric, free_threshold numeric, delivery_fee numeric, block text, missing integer)
language sql stable security definer set search_path = '' as \$f\$
  select r.eligible, r.fulfillment_rule_id, r.fulfillment_code, r.provider, r.matched_prefix, r.zone_prefixes, r.is_fallback, r.min_items, r.customer_text, r.display_order,
         $2, r.fixed_fee, r.free_threshold, $1, r.block, r.missing
  from public.resolve_delivery_fulfillment_real(p_restaurant_id, p_mode_code, p_postal_code, p_total_count, p_subtotal) r
\$f\$;
SQL
}
restore_resolver() {
  psql -X -q -d "${SWAP_DB:-$DB}" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
drop function public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric);
alter function public.resolve_delivery_fulfillment_real(uuid,text,text,integer,numeric) rename to resolve_delivery_fulfillment;
SQL
}
N_ORD="$(order_count)"; N_SNAP="$(snap_count)"
swap_resolver "r.delivery_fee + 1.00" "r.pricing_mode"
RC="$(co b1-zone delivery "$(items "$ITEM_A" 1)" null "$(cust 75018 Paris)")"
assert_nonzero_rc "B1-X-14a. résolveur incohérent (frais ≠ triplet) : create_order refusée" "$RC"
assert_contains "B1-X-14b. SQLSTATE 22023 / SCANYM_DELIVERY_SNAPSHOT_INCONSISTENT" "SCANYM_DELIVERY_SNAPSHOT_INCONSISTENT" "$(last_err)"
X14_STATE="$(PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -v VERBOSITY=verbose -c "select * from public.create_order('b1-zone','delivery','$(items "$ITEM_A" 1)'::jsonb, null, '$(cust 75018 Paris)'::jsonb, null, 'fr', false);" 2>&1 | grep -o '22023' | head -1)"
assert_eq "B1-X-14c. code d'erreur 22023" "22023" "$X14_STATE"
assert_eq "B1-X-14d. transaction ENTIÈRE annulée : aucune commande, aucune ligne" "$N_ORD|$N_SNAP" "$(order_count)|$(snap_count)"
restore_resolver

# B1-T-16 — pricing_mode hors vocabulaire v1 (simulation B5).
# ARBITRAGE RAVEL/CIO (scanym-orchestrator#17, REMEDIATION_REQUESTED —
# NARROW, suite au FAIL Chateaubriand B1-T16-CONTRACT) :
#   - §8.3 B1-A-01 fait autorité à l'exécution : create_order DOIT échouer
#     fermé si le résolveur renvoie un pricing_mode dont B1-A-01 ne connaît
#     pas encore la formule de frais ;
#   - B5 devra mettre à jour le résolveur ET la transcription B1-A-01
#     atomiquement, dans la même livraison, avant tout usage au checkout ;
#   - §6.2 inchangé : la TABLE ne porte aucun CHECK énuméré.
# B1-T-16 est donc clarifié en trois volets :
#   (a) la table accepte, isolément, un pricing_mode non-v1 ;
#   (b) create_order REJETTE un pricing_mode inconnu de B1-A-01 ;
#   (c) une fois B1-A-01 étendu de façon cohérente avec le résolveur,
#       le checkout PASSE pour ce nouveau mode.
RC="$(sql_rc "begin; insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, matched_prefix, pricing_mode, fixed_fee, free_threshold, customer_text) values ('$PRE_ORDER_NEW', gen_random_uuid(), false, '75', 'percentage_b5', null, null, null); rollback;")"
assert_eq "B1-T-16a. (a) la TABLE accepte isolément un pricing_mode non-v1 (aucun CHECK énuméré, §6.2)" "0" "$RC"

N_ORD="$(order_count)"; N_SNAP="$(snap_count)"
swap_resolver "r.delivery_fee" "'percentage_b5'::text"
RC="$(co b1-zone delivery "$(items "$ITEM_A" 1)" null "$(cust 75018 Paris)")"
assert_nonzero_rc "B1-T-16b. (b) mode inconnu de B1-A-01 (frais du résolveur = fixed_fee) : create_order rejette" "$RC"
assert_contains "B1-T-16c. (b) le rejet vient de B1-A-01 (22023), pas d'une contrainte de vocabulaire" "SCANYM_DELIVERY_SNAPSHOT_INCONSISTENT" "$(last_err)"
restore_resolver
# Contre-exemple exact de l'audit : mode inconnu ET frais nul.
swap_resolver "0::numeric" "'percentage_b5'::text"
RC="$(co b1-zone delivery "$(items "$ITEM_A" 1)" null "$(cust 75018 Paris)")"
assert_nonzero_rc "B1-T-16d. (b) contre-exemple Chateaubriand : pricing_mode='percentage_b5', delivery_fee=0 -> rejet" "$RC"
assert_contains "B1-T-16e. (b) ... par B1-A-01" "SCANYM_DELIVERY_SNAPSHOT_INCONSISTENT" "$(last_err)"
restore_resolver
assert_eq "B1-T-16f. (b) aucune commande ni ligne créée par les rejets" "$N_ORD|$N_SNAP" "$(order_count)|$(snap_count)"

# (c) — SIMULATION B5, HARNAIS UNIQUEMENT, sur une base CLONE : la
# migration B1 n'est pas modifiée. On régénère create_order depuis
# pg_get_functiondef en ajoutant UNE seule branche à la transcription
# B1-A-01 (formule fictive « pourcentage » : fixed_fee % du sous-total),
# et le résolveur substitué renvoie ce mode avec le frais correspondant.
DB_B5="${DB_AUX}_b5"
psql -c "create database \"$DB_B5\" template \"$DB\";" >/dev/null 2>"$ERR" || fatal "clone B5 : $(cat "$ERR")"
psql -X -q -d "$DB_B5" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<'SQL' || fatal "extension B1-A-01 simulée : $(cat "$ERR")"
do $b5$
declare
  d text;
  needle constant text := E'        else null\n      end\n    ) then';
begin
  d := pg_get_functiondef('public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)'::regprocedure);
  if (length(d) - length(replace(d, needle, ''))) / length(needle) <> 1 then
    raise exception 'ancre B1-A-01 introuvable ou non unique';
  end if;
  d := replace(d, needle,
    E'        when v_resolved.pricing_mode = ''percentage_b5'' then\n'
    || E'          round(coalesce(v_subtotal, 0) * v_resolved.fixed_fee / 100, 2)\n'
    || needle);
  execute d;
end $b5$;
SQL
assert_eq "B1-T-16g. (c) clone : B1-A-01 étendu d'une seule branche, create_order toujours unique" "1|1" \
  "$(psql -X -A -q -t -d "$DB_B5" -c "select count(*) || '|' || (select (length(prosrc) - length(replace(prosrc, 'percentage_b5', ''))) / length('percentage_b5') from pg_proc where oid='$CO_SIG'::regprocedure) from pg_proc where proname='create_order';")"
SWAP_DB="$DB_B5" swap_resolver "round(coalesce(p_subtotal, 0) * r.fixed_fee / 100, 2)" "'percentage_b5'::text"
B5_OUT="$(PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB_B5" -c "select order_id from public.create_order('b1-zone','delivery','$(items "$ITEM_A" 1)'::jsonb, null, '$(cust 75018 Paris)'::jsonb, null, 'fr', false);" 2>&1)"
assert_eq "B1-T-16h. (c) nouveau mode + B1-A-01 étendu de façon cohérente : le checkout PASSE" "36" "${#B5_OUT}"
assert_eq "B1-T-16i. (c) instantané du nouveau mode et frais corroboré (4.90 % de 10.00 = 0.49)" "percentage_b5|4.90|0.49|v1" \
  "$(psql -X -A -q -t -d "$DB_B5" -c "select s.pricing_mode||'|'||s.fixed_fee||'|'||o.delivery_fee||'|'||s.snapshot_method_version from public.orders o join public.order_delivery_fulfillment_snapshot s on s.order_id=o.id where o.id::text='$B5_OUT';")"
SWAP_DB="$DB_B5" restore_resolver
SWAP_DB="$DB_B5" swap_resolver "round(coalesce(p_subtotal, 0) * r.fixed_fee / 100, 2) + 1.00" "'percentage_b5'::text"
RC="$(PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB_B5" -c "select order_id from public.create_order('b1-zone','delivery','$(items "$ITEM_A" 1)'::jsonb, null, '$(cust 75018 Paris)'::jsonb, null, 'fr', false);" >/dev/null 2>/tmp/scanym-b1-err-$$.txt; echo $?)"
assert_nonzero_rc "B1-T-16j. (c) même B1-A-01 étendu, frais INCOHÉRENT pour le nouveau mode : toujours rejeté" "$RC"
assert_contains "B1-T-16k. (c) ... par B1-A-01" "SCANYM_DELIVERY_SNAPSHOT_INCONSISTENT" "$(last_err)"
SWAP_DB="$DB_B5" restore_resolver
psql -c "drop database if exists \"$DB_B5\";" >/dev/null 2>&1
assert_eq "B1-T-16l. résolveur réel restauré sur la base principale (md5 inchangé)" "$PRE_RES_MD5" "$(fn_md5 "$RES_SIG")"

# ============================================================
log "=== [B1-X-01..08 / Preuve 11] Privilèges : instantané inaltérable ==="
RC="$(as_user_rc "$OWNER_A" "update public.order_delivery_fulfillment_snapshot set fixed_fee = 0 where order_id='$O_PARIS';")"
assert_nonzero_rc "B1-X-01a. UPDATE en authenticated (membre) refusé" "$RC"
assert_contains "B1-X-01b. permission denied (42501)" "permission denied" "$(last_err)"
RC="$(as_user_rc "$OWNER_A" "delete from public.order_delivery_fulfillment_snapshot where order_id='$O_PARIS';")"
assert_nonzero_rc "B1-X-02. DELETE en authenticated refusé" "$RC"
RC="$(as_user_rc "$OWNER_A" "truncate public.order_delivery_fulfillment_snapshot;")"
assert_nonzero_rc "B1-X-03a. TRUNCATE en authenticated refusé" "$RC"
RC="$(as_service_rc "truncate public.order_delivery_fulfillment_snapshot;")"
assert_nonzero_rc "B1-X-03b. TRUNCATE en service_role refusé" "$RC"
RC="$(as_service_rc "update public.order_delivery_fulfillment_snapshot set fixed_fee = 0;")"
assert_nonzero_rc "B1-X-03c. UPDATE en service_role refusé" "$RC"
RC="$(as_service_rc "delete from public.order_delivery_fulfillment_snapshot;")"
assert_nonzero_rc "B1-X-03d. DELETE en service_role refusé" "$RC"
RC="$(as_user_rc "$OWNER_A" "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, pricing_mode) values ('$PRE_ORDER_NEW', gen_random_uuid(), true, 'free');")"
assert_nonzero_rc "B1-X-04a. INSERT en authenticated refusé" "$RC"
RC="$(as_anon_rc "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, pricing_mode) values ('$PRE_ORDER_NEW', gen_random_uuid(), true, 'free');")"
assert_nonzero_rc "B1-X-04b. INSERT en anon refusé" "$RC"
RC="$(as_service_rc "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, pricing_mode) values ('$PRE_ORDER_NEW', gen_random_uuid(), true, 'free');")"
assert_nonzero_rc "B1-X-04c. INSERT en service_role refusé" "$RC"
assert_eq "B1-X-01..04. instantané de référence intact après les attaques" \
  "$RULE_PARIS|false|92|fixed|4.90|<null>|Livraison Paris et 92" "$(snap_of "$O_PARIS")"
PRIVS="$(sql "select string_agg(r||':'||p, ',' order by r, p) from unnest(array['anon','authenticated','service_role']) r, unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where has_table_privilege(r, 'public.order_delivery_fulfillment_snapshot', p);")"
assert_eq "B1-X-01..04. has_table_privilege : aucun droit d'écriture pour aucun rôle applicatif" "" "$PRIVS"
if [ "$(sql "select current_setting('server_version_num')::int >= 170000;")" = "t" ]; then
  assert_eq "B1-X-03e. MAINTAIN révoqué (PG ≥ 17)" "0" \
    "$(sql "select count(*) from unnest(array['anon','authenticated','service_role']) r where has_table_privilege(r, 'public.order_delivery_fulfillment_snapshot', 'MAINTAIN');")"
else
  log "INFO: B1-X-03e (MAINTAIN) non exercé — serveur $(sql "show server_version;") < 17 ; bloc conditionnel du §12 sans effet ici."
fi

assert_eq "B1-X-05a. SELECT membre (propriétaire) : lit l'instantané de son établissement" "1" \
  "$(as_user "$OWNER_A" "select count(*) from public.order_delivery_fulfillment_snapshot where order_id='$O_PARIS';")"
RC="$(as_user_rc "$STRANGER" "select count(*) from public.order_delivery_fulfillment_snapshot;")"
assert_eq "B1-X-05b. SELECT authenticated NON membre : pas d'erreur" "0" "$RC"
assert_eq "B1-X-05c. ... et 0 ligne (RLS)" "0" "$(last_out | tr -d '[:space:]')"
RC="$(as_anon_rc "select count(*) from public.order_delivery_fulfillment_snapshot;")"
assert_nonzero_rc "B1-X-06. SELECT anon refusé (aucun grant)" "$RC"
RC="$(as_service_rc "select count(*) from public.order_delivery_fulfillment_snapshot;")"
assert_nonzero_rc "B1-X-07. SELECT service_role refusé (revoke all le nomme)" "$RC"

RC="$(sql_rc "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, matched_prefix, pricing_mode, fixed_fee) values ('$O_PARIS', '$RULE_PARIS', false, '75', 'fixed', 0);")"
assert_nonzero_rc "B1-X-08a. seconde écriture pour la même commande (même par le propriétaire) refusée" "$RC"
assert_contains "B1-X-08b. par la clé primaire order_id" "order_delivery_fulfillment_snapshot_pkey" "$(last_err)"

log "=== [B1-X-11..13] Domaines ==="
x_insert() { # $1 matched_prefix SQL, $2 fixed_fee SQL, $3 free_threshold SQL
  sql_rc "insert into public.order_delivery_fulfillment_snapshot (order_id, fulfillment_rule_id, is_fallback, matched_prefix, pricing_mode, fixed_fee, free_threshold) values ('$PRE_ORDER_NEW', gen_random_uuid(), false, $1, 'fixed', $2, $3);"
}
RC="$(x_insert "'  75018  '" 1 null)"; assert_nonzero_rc "B1-X-11a. matched_prefix '  75018  ' rejeté" "$RC"
assert_contains "B1-X-11b. par odfs_matched_prefix_shape" "odfs_matched_prefix_shape" "$(last_err)"
RC="$(x_insert "''" 1 null)"; assert_nonzero_rc "B1-X-11c. matched_prefix '' rejeté" "$RC"
assert_contains "B1-X-11d. par odfs_matched_prefix_shape" "odfs_matched_prefix_shape" "$(last_err)"
RC="$(x_insert "'75'" "'NaN'::numeric" null)"; assert_nonzero_rc "B1-X-12a. fixed_fee NaN rejeté" "$RC"
assert_contains "B1-X-12b. par odfs_fixed_fee_finite" "odfs_fixed_fee_finite" "$(last_err)"
RC="$(x_insert "'75'" "'Infinity'::numeric" null)"; assert_nonzero_rc "B1-X-12c. fixed_fee Infinity rejeté" "$RC"
RC="$(x_insert "'75'" 1 "'NaN'::numeric")"; assert_nonzero_rc "B1-X-12d. free_threshold NaN rejeté" "$RC"
RC="$(x_insert "'75'" 1 -0.01)"; assert_nonzero_rc "B1-X-13a. free_threshold négatif rejeté" "$RC"
assert_contains "B1-X-13b. par odfs_free_threshold_non_negative" "odfs_free_threshold_non_negative" "$(last_err)"
RC="$(x_insert "'75'" -1 null)"; assert_nonzero_rc "B1-X-13c. fixed_fee négatif rejeté" "$RC"
assert_eq "B1-X-11..13. aucune ligne parasite pour la commande antérieure" "0" \
  "$(sql "select count(*) from public.order_delivery_fulfillment_snapshot where order_id='$PRE_ORDER_NEW';")"

# ============================================================
log "=== [B1-X-10] Édition tarifaire VALIDÉE PENDANT un checkout (B1-I-06) ==="
# Déclencheur HARNAIS UNIQUEMENT : pause pendant l'update public.orders de
# create_order, c.-à-d. APRÈS la lecture du résolveur et AVANT l'insert
# de l'instantané. L'édition marchande est validée pendant cette pause.
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create function public.b1_harness_pause() returns trigger language plpgsql as $f$
begin
  if new.delivery_fee is distinct from old.delivery_fee then perform pg_sleep(3); end if;
  return new;
end $f$;
create trigger b1_harness_pause after update of delivery_fee on public.orders
  for each row execute function public.b1_harness_pause();
SQL
PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" \
  -c "select order_id from public.create_order('b1-zone','delivery','$(items "$ITEM_A" 1)'::jsonb, null, '$(cust 75018 Paris)'::jsonb, null, 'fr', false);" \
  >/tmp/scanym-b1-par-$$-x10 2>&1 &
PID_X10=$!
sleep 1
RC="$(as_user_rc "$OWNER_A" "select public.update_merchant_delivery_fulfillment_pricing('$RULE_PARIS', 'fixed', 9.99, null, 'Tarif édité pendant le checkout');")"
assert_eq "B1-X-10a. édition marchande validée pendant le checkout" "0" "$RC"
[ "$RC" = "0" ] || log "   détail : $(last_err | head -2)"
wait "$PID_X10"
OX10="$(grep -E '^[0-9a-f-]{36}$' /tmp/scanym-b1-par-$$-x10 | head -1)"
assert_eq "B1-X-10b. le checkout concurrent aboutit" "36" "${#OX10}"
assert_eq "B1-X-10c. instantané cohérent avec le frais de SA transaction (ancien tarif 4.90, jamais un mélange)" \
  "4.90|fixed|4.90|Livraison Paris et 92" \
  "$(sql "select o.delivery_fee||'|'||s.pricing_mode||'|'||s.fixed_fee||'|'||s.customer_text from public.orders o join public.order_delivery_fulfillment_snapshot s on s.order_id=o.id where o.id='$OX10';")"
psql -X -q -d "$DB" -c "drop trigger b1_harness_pause on public.orders; drop function public.b1_harness_pause();" >/dev/null
assert_eq "B1-X-10d. déclencheur de harnais retiré (structure orders revenue à l'identique)" "$PRE_ORDERS_SHAPE" "$(orders_shape_md5)"
RC="$(co b1-zone delivery "$(items "$ITEM_A" 1)" null "$(cust 75018 Paris)")"
assert_eq "B1-X-10e. commande suivante : nouveau tarif appliqué et instantané" "9.99|fixed|9.99|Tarif édité pendant le checkout" \
  "$(sql "select o.delivery_fee||'|'||s.pricing_mode||'|'||s.fixed_fee||'|'||s.customer_text from public.orders o join public.order_delivery_fulfillment_snapshot s on s.order_id=o.id where o.id='$(oid_of)';")"

# ============================================================
log "=== [B1-T-13 / Preuve 12] Édition tarifaire APRÈS commande : instantané inchangé ==="
SNAP_FB_BEFORE="$(snap_of "$O_FB")"; FEE_FB_BEFORE="$(sql "select delivery_fee||'|'||total from public.orders where id='$O_FB';")"
SNAP7_BEFORE="$(snap_of "$O7")"
RC="$(as_user_rc "$OWNER_A" "select public.update_merchant_delivery_fulfillment_pricing('$RULE_FB', 'free_above_threshold', 12.00, 99.00, 'Repli édité');")"
assert_eq "B1-T-13a. édition des 4 colonnes de la règle de repli" "0" "$RC"
RC="$(as_user_rc "$OWNER_A" "select public.update_merchant_delivery_fulfillment_pricing('$RULE_LYON', 'fixed', 8.00, null, 'Lyon édité');")"
assert_eq "B1-T-13b. édition des 4 colonnes de la règle Lyon" "0" "$RC"
assert_eq "B1-T-13c. configuration effectivement modifiée" "free_above_threshold|12.00|99.00|Repli édité" \
  "$(sql "select pricing_mode||'|'||fixed_fee||'|'||free_threshold||'|'||customer_text from public.restaurant_sale_mode_fulfillments where id='$RULE_FB';")"
assert_eq "B1-T-13d. instantané repli INCHANGÉ, valeur par valeur" "$SNAP_FB_BEFORE" "$(snap_of "$O_FB")"
assert_eq "B1-T-13e. instantané Lyon INCHANGÉ, valeur par valeur" "$SNAP7_BEFORE" "$(snap_of "$O7")"
assert_eq "B1-T-13f. orders.delivery_fee / total INCHANGÉS" "$FEE_FB_BEFORE" "$(sql "select delivery_fee||'|'||total from public.orders where id='$O_FB';")"
assert_eq "B1-T-13g. instantané Paris (O_PARIS) INCHANGÉ malgré l'édition X-10" \
  "$RULE_PARIS|false|92|fixed|4.90|<null>|Livraison Paris et 92" "$(snap_of "$O_PARIS")"

# ============================================================
log "=== [B1-T-12] Suppression de la règle par cascade restaurant_sale_modes ==="
RC="$(co b1-del delivery "$(items "$ITEM_C" 1)" null "$(cust 75001 Paris)")"
assert_eq "B1-T-12a. commande sur la règle à supprimer" "0" "$RC"
O12="$(oid_of)"
SNAP12="$(snap_of "$O12")"
assert_eq "B1-T-12b. avant suppression : orders.fulfillment_rule_id = règle" "$RULE_DEL" "$(sql "select fulfillment_rule_id from public.orders where id='$O12';")"
RC="$(sql_rc "delete from public.restaurant_sale_modes where restaurant_id='$RID_C' and mode_code='delivery';")"
assert_eq "B1-T-12c. suppression du mode parent (cascade vers les règles)" "0" "$RC"
[ "$RC" = "0" ] || log "   détail : $(last_err | head -2)"
assert_eq "B1-T-12d. la règle a disparu" "0" "$(sql "select count(*) from public.restaurant_sale_mode_fulfillments where id='$RULE_DEL';")"
assert_eq "B1-T-12e. orders.fulfillment_rule_id devenu NUL (on delete set null, comportement existant)" "<null>" \
  "$(sql "select coalesce(fulfillment_rule_id::text,'<null>') from public.orders where id='$O12';")"
assert_eq "B1-T-12f. instantané INTACT, fulfillment_rule_id toujours lisible (B1-I-07)" "$SNAP12" "$(snap_of "$O12")"
assert_eq "B1-T-12g. fulfillment_rule_id instantané = identifiant de la règle supprimée" "$RULE_DEL" \
  "$(sql "select fulfillment_rule_id from public.order_delivery_fulfillment_snapshot where order_id='$O12';")"

# ============================================================
log "=== [Preuve 13] matched_prefix survit comme fait historique ==="
assert_eq "P13a. matched_prefix de O_PARIS = 92 alors que orders.delivery_zone porte 92100" "92|92100" \
  "$(sql "select s.matched_prefix||'|'||o.delivery_zone from public.order_delivery_fulfillment_snapshot s join public.orders o on o.id=s.order_id where o.id='$O_PARIS';")"
assert_eq "B1-I-03. matched_prefix nul ⟺ is_fallback, sur TOUTES les lignes écrites" "0" \
  "$(sql "select count(*) from public.order_delivery_fulfillment_snapshot where (matched_prefix is null) <> is_fallback;")"
assert_eq "B1-I-04. aucune ligne pour une commande sans orders.fulfillment_rule_id à l'écriture (hors T-12)" "0" \
  "$(sql "select count(*) from public.order_delivery_fulfillment_snapshot s join public.orders o on o.id=s.order_id where o.fulfillment_rule_id is null and s.order_id <> '$O12';")"
assert_eq "B1-I-04b. toute commande livraison nouveau moteur post-B1 porte un instantané" "0" \
  "$(sql "select count(*) from public.orders o where o.fulfillment_rule_id is not null and o.id not in ('$PRE_ORDER_NEW') and not exists (select 1 from public.order_delivery_fulfillment_snapshot s where s.order_id=o.id);")"

log "=== [B1-X-18] purge_old_customer_data(0) ==="
SNAP_PARIS_BEFORE="$(snap_of "$O_PARIS")"
RC="$(sql_rc "select public.purge_old_customer_data(0);")"
assert_eq "B1-X-18a. purge exécutée" "0" "$RC"
assert_eq "B1-X-18b. orders.delivery_zone mis à NUL par la purge (état de fait, Q-B1-2)" "<null>|true" \
  "$(sql "select coalesce(delivery_zone,'<null>')||'|'||personal_data_purged from public.orders where id='$O_PARIS';")"
assert_eq "B1-X-18c. l'instantané SURVIT intact (matched_prefix compris)" "$SNAP_PARIS_BEFORE" "$(snap_of "$O_PARIS")"

# ============================================================
log "=== [B1-T-21] Suivi client : 14 colonnes inchangées ==="
assert_eq "B1-T-21a. get_order_tracking_by_capability : table de retour inchangée" "$PRE_TRACK_RESULT" \
  "$(sql "select pg_get_function_result('public.get_order_tracking_by_capability(uuid,uuid,text)'::regprocedure);")"
assert_eq "B1-T-21b. 14 colonnes" "14" \
  "$(sql "select array_length(proallargtypes,1) - pronargs from pg_proc where oid='public.get_order_tracking_by_capability(uuid,uuid,text)'::regprocedure;")"

log "=== [B1-T-24] initiate_payment_attempt : montant = orders.total ==="
RC="$(as_service_rc "select amount||'|'||currency from public.initiate_payment_attempt('$O_FB','fixture-provider','b1-ref-1');")"
assert_eq "B1-T-24a. initiate_payment_attempt (service_role) sur une commande B1" "0" "$RC"
assert_eq "B1-T-24b. amount = orders.total (7.50 + 10.00)" "$(sql "select total||'|'||currency from public.orders where id='$O_FB';")" "$(last_out | head -1)"

# ============================================================
log "=== [B1-T-23] Ventilation TVA du frais : identique avec et sans B1 ==="
psql -c "create database \"${DB_AUX}_vat\" template \"$DB_PRE\";" >/dev/null 2>&1
psql -c "create database \"${DB_AUX}_vatb1\" template \"$DB_PRE\";" >/dev/null 2>&1
T23_OK=1
psql -X -q -d "${DB_AUX}_vat" -v ON_ERROR_STOP=1 -f "$VAT_SQL" >/dev/null 2>"$ERR" || { T23_OK=0; log "INFO: lot TVA non applicable sur le gabarit : $(head -2 "$ERR")"; }
psql -X -q -d "${DB_AUX}_vatb1" -v ON_ERROR_STOP=1 -f "$VAT_SQL" >/dev/null 2>"$ERR" || T23_OK=0
psql -X -q -d "${DB_AUX}_vatb1" -v ON_ERROR_STOP=1 -f "$B1_SQL" >/dev/null 2>"$ERR" || { T23_OK=0; log "INFO: B1 sur TVA : $(head -3 "$ERR")"; }
if [ "$T23_OK" = "1" ]; then
  # La ventilation TVA est fail-closed sans taux : taux produit fixé
  # à l'identique dans les deux bases.
  for d in "${DB_AUX}_vat" "${DB_AUX}_vatb1"; do
    psql -X -q -d "$d" -c "update public.menu_items set tax_rate = 10.00;" >/dev/null
  done
  vat_alloc() { # $1 base -> "delivery_fee|allocations|somme|instantané"
    local o
    o="$(PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$1" -c "select order_id from public.create_order('b1-zone','delivery','$(items "$ITEM_A" 1)'::jsonb, null, '$(cust 92100 Boulogne)'::jsonb, null, 'fr', false);" 2>&1)"
    psql -X -A -q -t -d "$1" -c "select o.delivery_fee||'|'||coalesce((select string_agg(tax_rate_snapshot||':'||delivery_fee_gross_share||':'||delivery_fee_net_share||':'||delivery_fee_tax_amount, ',' order by tax_rate_snapshot) from public.order_delivery_tax_allocations a where a.order_id=o.id),'<aucune>')||'|'||coalesce((select sum(delivery_fee_gross_share)::text from public.order_delivery_tax_allocations a where a.order_id=o.id),'<null>') from public.orders o where o.id::text='$o';" 2>&1
  }
  A_NOB1="$(vat_alloc "${DB_AUX}_vat")"
  A_B1="$(vat_alloc "${DB_AUX}_vatb1")"
  log "   ventilation sans B1 : $A_NOB1 ; avec B1 : $A_B1"
  assert_eq "B1-T-23a. ventilation TVA identique avec et sans B1" "$A_NOB1" "$A_B1"
  assert_eq "B1-T-23b. sum(delivery_fee_gross_share) = orders.delivery_fee" "$(printf '%s' "$A_B1" | cut -d'|' -f1)" "$(printf '%s' "$A_B1" | cut -d'|' -f3)"
  assert_eq "B1-T-23c. l'instantané B1 est écrit à côté de la ventilation" "1" \
    "$(psql -X -A -q -t -d "${DB_AUX}_vatb1" -c "select count(*) from public.order_delivery_fulfillment_snapshot;")"
else
  fail "B1-T-23. chaîne TVA + B1 non constructible dans le harnais"
fi

# ============================================================
log "=== [B1-X-15] Deux surcharges de create_order : P-5 refuse ==="
psql -c "create database \"${DB_AUX}_x15\" template \"$DB_PRE\";" >/dev/null 2>&1
psql -X -q -d "${DB_AUX}_x15" -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
create function public.create_order(p_slug text, p_service_mode text, p_items jsonb, p_table_number integer, p_customer jsonb, p_note text, p_language text)
returns table (order_id uuid, order_number bigint, public_token uuid, total numeric) language sql as $f$ select null::uuid, null::bigint, null::uuid, null::numeric $f$;
SQL
assert_eq "B1-X-15a. gabarit : 2 surcharges présentes" "2" "$(co_count "${DB_AUX}_x15")"
if psql -X -q -d "${DB_AUX}_x15" -v ON_ERROR_STOP=1 -f "$B1_SQL" >/tmp/scanym-b1-out-$$.txt 2>&1; then
  fail "B1-X-15b. la migration a RÉUSSI malgré 2 surcharges"
else
  assert_contains "B1-X-15b. refus par P-5" "\[P-5\]" "$(cat /tmp/scanym-b1-out-$$.txt)"
fi
assert_eq "B1-X-15c. rien n'est appliqué : table absente" "" \
  "$(psql -X -A -q -t -d "${DB_AUX}_x15" -c "select to_regclass('public.order_delivery_fulfillment_snapshot');")"
assert_eq "B1-X-15d. create_order 8 args inchangée" "$PRE_CO_MD5" "$(fn_md5 "$CO_SIG" "${DB_AUX}_x15")"

log "=== [B1-X-16] Double application : P-7 refuse ==="
if psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$B1_SQL" >/tmp/scanym-b1-out-$$.txt 2>&1; then
  fail "B1-X-16. la seconde application a RÉUSSI"
else
  assert_contains "B1-X-16a. refus par P-7" "\[P-7\]" "$(cat /tmp/scanym-b1-out-$$.txt)"
fi
assert_eq "B1-X-16b. create_order inchangée par la tentative" "$POST_CO_SRC" "$(sql "select md5(prosrc) from pg_proc where oid='$CO_SIG'::regprocedure;")"

log "=== [B1-X-17] Rollback puis re-migration ==="
psql -c "create database \"$DB_AUX\" template \"$DB\";" >/dev/null 2>&1
if psql -X -q -d "$DB_AUX" -v ON_ERROR_STOP=1 -f "$B1_ROLLBACK_SQL" >/tmp/scanym-b1-out-$$.txt 2>&1; then
  pass "B1-X-17a. rollback appliqué"
else
  fail "B1-X-17a. rollback en échec : $(tail -5 /tmp/scanym-b1-out-$$.txt)"
fi
assert_eq "B1-X-17b. après rollback : 1 surcharge" "1" "$(co_count "$DB_AUX")"
assert_eq "B1-X-17c. après rollback : create_order = définition pré-B1 (md5 pg_get_functiondef)" "$PRE_CO_MD5" "$(fn_md5 "$CO_SIG" "$DB_AUX")"
assert_eq "B1-X-17d. après rollback : ACL identique" "$PRE_CO_ACL" "$(psql -X -A -q -t -d "$DB_AUX" -c "select proacl::text from pg_proc where oid='$CO_SIG'::regprocedure;")"
assert_eq "B1-X-17e. après rollback : table absente" "" "$(psql -X -A -q -t -d "$DB_AUX" -c "select to_regclass('public.order_delivery_fulfillment_snapshot');")"
if psql -X -q -d "$DB_AUX" -v ON_ERROR_STOP=1 -f "$B1_SQL" >/tmp/scanym-b1-out-$$.txt 2>&1; then
  pass "B1-X-17f. re-migration appliquée"
else
  fail "B1-X-17f. re-migration en échec : $(tail -5 /tmp/scanym-b1-out-$$.txt)"
fi
assert_eq "B1-X-17g. après re-migration : 1 surcharge" "1" "$(co_count "$DB_AUX")"
assert_eq "B1-X-17h. après re-migration : create_order identique à la première migration" "$POST_CO_SRC" \
  "$(psql -X -A -q -t -d "$DB_AUX" -c "select md5(prosrc) from pg_proc where oid='$CO_SIG'::regprocedure;")"
assert_eq "B1-X-17i. après re-migration : table vide (aucun backfill, les instantanés détruits ne reviennent pas)" "0" \
  "$(psql -X -A -q -t -d "$DB_AUX" -c "select count(*) from public.order_delivery_fulfillment_snapshot;")"

# ============================================================
echo
log "=== RÉSUMÉ ==="
log "PASS: $PASS_COUNT"
log "FAIL: $FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "Échecs :"; cat "$FAIL_LOG"
  exit 1
fi
log "TOUS LES CONTRÔLES B1 PASSENT."
