#!/usr/bin/env bash
# ============================================================
# Scanym — SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING
# FOUNDATION — Harnais PostgreSQL jetable
# (supabase/DRAFT-lot-server-delivery-fulfillment-pricing.sql).
#
# Baseline : chaîne réelle complète jusqu'à LOT B (même patron que
# supabase/tests/fulfillment-routing-lot-b-check.sh, NON modifié par ce
# lot — il continue de prouver le contrat LOT B.1 en isolation) + LOT A
# + LOT B, puis application de ce nouveau DRAFT en fin de chaîne.
# AUCUNE exécution contre Supabase Production.
#
# Couvre (mission "SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING
# FOUNDATION", section 20) :
#   - contraintes de tarification par règle (fixed_fee, free_threshold,
#     combinaison pricing_mode valide) ;
#   - résolveur : règle locale, règle fallback, no-postal, below-min ;
#   - pont de migration SERVEUR : zéro règle active -> legacy
#     inchangé ; au moins une règle active -> nouveau moteur exclusif,
#     jamais de repli legacy (y compris quand TOUTES les règles sont
#     enabled=false : compte comme "aucune règle active") ;
#   - calcul du frais de livraison et calcul du total ;
#   - instantané de commande (fulfillment_rule_id/fulfillment_code/
#     provider_code/delivery_fee persistés, jamais réécrits après
#     coup) ;
#   - provider jamais exposé par la RPC publique ni par aucune donnée
#     accessible à anon ;
#   - le client ne peut jamais forcer le prestataire ni le frais
#     (signature de create_order inchangée, aucun paramètre pour ça) ;
#   - intégrité de l'instantané (CHECK total = subtotal + delivery_fee).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/server-delivery-fulfillment-pricing-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_A_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql"
DRAFT_B_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql"
DB="scanym_sdfp_check_$$"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
FAIL_LOG="/tmp/scanym-sdfp-fails-$$.log"
: > "$FAIL_LOG"
fail() {
  FAIL_COUNT=$((FAIL_COUNT+1))
  printf '%s\n' "$*" >> "$FAIL_LOG"
  log "FAIL: $*"
}

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_rc() {
  local desc="$1" expected_rc="$2" actual_rc="$3"
  if [ "$expected_rc" = "$actual_rc" ]; then pass "$desc (rc=$actual_rc)"; else fail "$desc — attendu rc=$expected_rc, obtenu rc=$actual_rc"; fi
}
assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then pass "$desc"; else fail "$desc — '$needle' absent de : $haystack"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }

log "Construction baseline $DB (identique au patron fulfillment-routing-lot-b-check.sh)..."
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
psql -d "$DB" >/dev/null <<'SQL'
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

for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
done
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-illico-v2.sql" >/dev/null 2>&1
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sanaa.sql" >/dev/null 2>&1
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sirocco-demo.sql" >/dev/null 2>&1
psql -d "$DB" -c "update restaurants set status='active';" >/dev/null 2>&1
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
psql -d "$DB" -c "alter default privileges in schema public grant execute on functions to service_role;" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_A_SQL" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_B_SQL" >/dev/null

BEFORE_TABLES=$(sql "select count(*) from pg_tables where schemaname='public';")

log "Application du DRAFT server delivery fulfillment & pricing..."
DRAFT_RC=0
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-sdfp-apply-$$.log 2>&1 || DRAFT_RC=$?
assert_rc "DRAFT s'applique sans erreur sur baseline propre (LOT A/B déjà installés)" 0 "$DRAFT_RC"
if [ "$DRAFT_RC" != "0" ]; then cat /tmp/scanym-sdfp-apply-$$.log; fi
rm -f /tmp/scanym-sdfp-apply-$$.log

REAPPLY_RC=0
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null 2>&1 || REAPPLY_RC=$?
assert_rc "réexécution du DRAFT échoue proprement (préflight anti-double-application)" 1 "$([ "$REAPPLY_RC" != "0" ] && echo 1 || echo 0)"

NODEP_DB="scanym_sdfp_nodep_$$"
psql -c "drop database if exists \"$NODEP_DB\";" >/dev/null 2>&1 || true
createdb "$NODEP_DB"
psql -d "$NODEP_DB" -c "create extension if not exists pgcrypto;" >/dev/null
NODEP_RC=0
psql -d "$NODEP_DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null 2>&1 || NODEP_RC=$?
assert_rc "DRAFT refuse de s'appliquer sans LOT A/B (prérequis manquant)" 1 "$([ "$NODEP_RC" != "0" ] && echo 1 || echo 0)"
psql -c "drop database if exists \"$NODEP_DB\";" >/dev/null 2>&1 || true

# ==================================================================
# SCHEMA — colonnes de tarification, contraintes
# ==================================================================
SANAA_ID=$(sql "select id from restaurants where slug='sanaa-cookies';")
SIROCCO_ID=$(sql "select id from restaurants where slug='le-sirocco';")
ITEM_ID=$(sql "select mi.id from menu_items mi join menu_categories mc on mc.id=mi.category_id where mc.restaurant_id='$SANAA_ID' and mi.is_available and mc.is_active and mi.option_source_category_id is null limit 1;")

assert_eq "restaurant_sale_mode_fulfillments.pricing_mode existe, default 'free'" "free" "$(sql "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, zone_prefixes, display_order) values ('$SANAA_ID','delivery','probe_default', array['00'], 50); select pricing_mode from restaurant_sale_mode_fulfillments where fulfillment_code='probe_default';")"
sql "delete from restaurant_sale_mode_fulfillments where fulfillment_code='probe_default';" >/dev/null

BAD_COMBO_RC=0
psql -d "$DB" -c "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, zone_prefixes, display_order, pricing_mode, fixed_fee) values ('$SANAA_ID','delivery','bad_combo', array['00'], 51, 'free', 12.00);" >/dev/null 2>&1 || BAD_COMBO_RC=$?
assert_rc "CHECK combo tarification rejette pricing_mode='free' avec fixed_fee non-null" 1 "$([ "$BAD_COMBO_RC" != "0" ] && echo 1 || echo 0)"

BAD_NEGATIVE_RC=0
psql -d "$DB" -c "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, zone_prefixes, display_order, pricing_mode, fixed_fee) values ('$SANAA_ID','delivery','bad_negative', array['00'], 52, 'fixed', -1.00);" >/dev/null 2>&1 || BAD_NEGATIVE_RC=$?
assert_rc "CHECK fixed_fee >= 0 rejette une valeur négative" 1 "$([ "$BAD_NEGATIVE_RC" != "0" ] && echo 1 || echo 0)"

# ==================================================================
# Données de test : 2 règles pour Sanaa (fixed + free_above_threshold fallback)
# ==================================================================
sql "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, zone_prefixes, is_fallback, min_items, customer_text, display_order, pricing_mode, fixed_fee, free_threshold) values
  ('$SANAA_ID','delivery','local_delivery_75','stuart', array['75'], false, 2, 'Livraison locale', 0, 'fixed', 5.00, null),
  ('$SANAA_ID','delivery','wide_shipping','chronofresh', array[]::text[], true, 1, 'Expedition', 1, 'free_above_threshold', 8.00, 30.00);
" >/dev/null

# ==================================================================
# RÉSOLVEUR — tarification
# ==================================================================
assert_eq "règle locale (75), subtotal 10 -- fixed_fee=5.00 appliqué" "local_delivery_75|fixed|5.00|5.00|t" "$(sql "select fulfillment_code, pricing_mode, fixed_fee, delivery_fee, eligible from resolve_delivery_fulfillment('$SANAA_ID','delivery','75001',3,10);")"
assert_eq "fallback (non-75), subtotal 10 (< seuil 30) -- fixed_fee=8.00 appliqué (pas encore gratuit)" "wide_shipping|8.00|t" "$(sql "select fulfillment_code, delivery_fee, eligible from resolve_delivery_fulfillment('$SANAA_ID','delivery','13001',3,10);")"
assert_eq "fallback (non-75), subtotal 35 (>= seuil 30) -- gratuit (free_above_threshold)" "wide_shipping|0|t" "$(sql "select fulfillment_code, delivery_fee, eligible from resolve_delivery_fulfillment('$SANAA_ID','delivery','13001',3,35);")"
assert_eq "seuil EXACT (subtotal = free_threshold) -- gratuit, seuil non exclusif" "0" "$(sql "select delivery_fee from resolve_delivery_fulfillment('$SANAA_ID','delivery','13001',3,30);")"
assert_eq "subtotal NULL traité comme 0 -- jamais une gratuité optimiste" "8.00" "$(sql "select delivery_fee from resolve_delivery_fulfillment('$SANAA_ID','delivery','13001',3,null);")"
assert_eq "aucune règle retenue (no-postal) -- delivery_fee NULL" "" "$(sql "select coalesce(delivery_fee::text,'') from resolve_delivery_fulfillment('$SANAA_ID','delivery',null,3,10);")"
assert_eq "below-min : delivery_fee reste renseigné (même convention que fulfillment_code/customer_text, LOT B.1)" "5.00|below-min" "$(sql "select delivery_fee, block from resolve_delivery_fulfillment('$SANAA_ID','delivery','75001',1,10);")"
assert_eq "resolve_delivery_fulfillment expose fulfillment_rule_id (non-null pour une règle résolue)" "t" "$(sql "select (fulfillment_rule_id is not null) from resolve_delivery_fulfillment('$SANAA_ID','delivery','75001',3,10);")"

# ==================================================================
# RPC PUBLIQUE — tarification exposée, provider jamais exposé
# ==================================================================
assert_eq "RPC publique expose pricing_mode/fixed_fee/free_threshold" "local_delivery_75|fixed|5.00|
wide_shipping|free_above_threshold|8.00|30.00" "$(sql "select fulfillment_code, pricing_mode, fixed_fee, free_threshold from get_restaurant_public_delivery_fulfillments('$SANAA_ID') order by display_order;")"
assert_eq "RPC publique -- forme de retour ne contient JAMAIS provider" "f" "$(sql "select pg_get_function_result(oid) ilike '%provider%' from pg_proc where proname='get_restaurant_public_delivery_fulfillments';")"
assert_eq "RPC publique -- définition ne référence jamais provider/config (recherche brute)" "f" "$(sql "select (pg_get_functiondef(oid) ilike '%provider%' or pg_get_functiondef(oid) ilike '%.config%') from pg_proc where proname='get_restaurant_public_delivery_fulfillments';")"

# ==================================================================
# CREATE_ORDER — pont de migration serveur, tarification, instantané
# ==================================================================

# Legacy : tenant SANS règle active (Sirocco n'a même pas le mode
# delivery -- même échec précoce qu'avant ce lot, INCHANGÉ).
SIROCCO_RC=0
SIROCCO_OUT=$(psql -d "$DB" -c "select 1 from create_order('le-sirocco','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',1,'option_item_id',null)), null, jsonb_build_object('address','1 rue X 75001'), null, 'fr');" 2>&1) || SIROCCO_RC=$?
assert_rc "tenant sans mode delivery -- échec précoce INCHANGÉ (mode non autorisé)" 1 "$([ "$SIROCCO_RC" != "0" ] && echo 1 || echo 0)"
assert_contains "message d'erreur INCHANGÉ pour ce cas" "$SIROCCO_OUT" "non autorisé"

# Legacy : Sanaa AVANT toute règle de fulfillment -- delivery_fee=0,
# total=subtotal, comportement BYTE-IDENTIQUE.
LEGACY_ROW=$(sql "delete from restaurant_sale_mode_fulfillments where restaurant_id='$SANAA_ID'; select subtotal, delivery_fee, total from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',12,'option_item_id',null)), null, jsonb_build_object('name','L','phone','0600000000','email','l@example.com','address','1 rue Test 75001 Paris'), null, 'fr');")
assert_eq "LEGACY (0 règle) : delivery_fee=0, total=subtotal (comportement pré-existant inchangé)" "30.00|0.00|30.00" "$LEGACY_ROW"

LEGACY_ZONE_RC=0
LEGACY_ZONE_OUT=$(psql -d "$DB" -c "select 1 from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',12,'option_item_id',null)), null, jsonb_build_object('name','L','phone','0600000000','email','l@example.com','address','1 rue Test 13001 Marseille'), null, 'fr');" 2>&1) || LEGACY_ZONE_RC=$?
assert_rc "LEGACY (0 règle) : zone hors JSONB delivery_zone_prefixes -- rejet INCHANGÉ" 1 "$([ "$LEGACY_ZONE_RC" != "0" ] && echo 1 || echo 0)"
assert_contains "LEGACY : message 'Zone non desservie' INCHANGÉ" "$LEGACY_ZONE_OUT" "Zone non desservie"

# Ré-insère les 2 règles pour la suite (nouveau moteur).
sql "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, zone_prefixes, is_fallback, min_items, customer_text, display_order, pricing_mode, fixed_fee, free_threshold) values
  ('$SANAA_ID','delivery','local_delivery_75','stuart', array['75'], false, 2, 'Livraison locale', 0, 'fixed', 5.00, null),
  ('$SANAA_ID','delivery','wide_shipping','chronofresh', array[]::text[], true, 1, 'Expedition', 1, 'free_above_threshold', 8.00, 30.00);
" >/dev/null

NEW_ROW=$(sql "select subtotal, delivery_fee, total from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',3,'option_item_id',null)), null, jsonb_build_object('name','N','phone','0600000001','email','n@example.com','address','2 rue Test 75001 Paris','postalCode','75001'), null, 'fr');")
assert_eq "NOUVEAU MOTEUR : subtotal 7.50 (3x2.50) + fee 5.00 = total 12.50" "7.50|5.00|12.50" "$NEW_ROW"

SNAPSHOT_ROW=$(sql "select fulfillment_code, provider_code, delivery_fee, (total = subtotal + delivery_fee) from orders order by created_at desc limit 1;")
assert_eq "INSTANTANÉ persisté : fulfillment_code/provider_code/delivery_fee, invariant total=subtotal+delivery_fee vrai" "local_delivery_75|stuart|5.00|t" "$SNAPSHOT_ROW"

# Frais gratuit au-dessus du seuil, via le fallback (13001, subtotal >= 30 avec assez d'articles).
FREE_ROW=$(sql "select subtotal, delivery_fee, total from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',15,'option_item_id',null)), null, jsonb_build_object('name','F','phone','0600000002','email','f@example.com','address','4 rue Test 13001 Marseille','postalCode','13001'), null, 'fr');")
assert_eq "NOUVEAU MOTEUR, fallback, subtotal >= seuil -- delivery_fee=0, total=subtotal" "37.50|0.00|37.50" "$FREE_ROW"

# below-min via le nouveau moteur : rejet, message réutilisant le
# style existant (comparé au message LEGACY ci-dessus).
BELOWMIN_RC=0
BELOWMIN_OUT=$(psql -d "$DB" -c "select 1 from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',1,'option_item_id',null)), null, jsonb_build_object('name','M','phone','0600000003','email','m@example.com','address','5 rue Test 75001 Paris','postalCode','75001'), null, 'fr');" 2>&1) || BELOWMIN_RC=$?
assert_rc "NOUVEAU MOTEUR : below-min (1 < min 2) -- rejeté" 1 "$([ "$BELOWMIN_RC" != "0" ] && echo 1 || echo 0)"
assert_contains "message below-min réutilise le style existant" "$BELOWMIN_OUT" "Minimum de"

# no-postal via le nouveau moteur.
NOPOSTAL_RC=0
NOPOSTAL_OUT=$(psql -d "$DB" -c "select 1 from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',3,'option_item_id',null)), null, jsonb_build_object('name','P','phone','0600000004','email','p@example.com','address','rue sans code postal'), null, 'fr');" 2>&1) || NOPOSTAL_RC=$?
assert_rc "NOUVEAU MOTEUR : adresse sans code postal -- rejeté (même message que legacy)" 1 "$([ "$NOPOSTAL_RC" != "0" ] && echo 1 || echo 0)"
assert_contains "message no-postal INCHANGÉ" "$NOPOSTAL_OUT" "Code postal absent"

# ==================================================================
# SADFP-V2-02 (CORRECTION v3 §9) : le cas no-postal ci-dessus ne
# prouve le rejet QUE lorsque l'adresse elle-même ne contient AUCUN
# numéro à 5 chiffres -- insuffisant : il ne prouve pas que le nouveau
# moteur résiste à un repli regex quand l'adresse CONTIENT un numéro
# plausible ("75001") mais que le champ structuré est absent/blanc.
# Cas C1/C2 ci-dessous couvrent exactement ce trou, en vérifiant en
# plus qu'AUCUNE commande n'est créée (aucun INSERT partiel avant le
# rejet).
# ==================================================================

# Cas C1 : postalCode structuré ABSENT (aucune clé du tout) + adresse
# contenant "75001" -- doit rejeter EXACTEMENT comme le cas no-postal
# ci-dessus, jamais router via le "75001" présent dans l'adresse.
PRE_COUNT_C1=$(sql "select count(*) from orders;")
CASE_C1_RC=0
CASE_C1_OUT=$(psql -d "$DB" -c "select 1 from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',3,'option_item_id',null)), null, jsonb_build_object('name','C1','phone','0600000011','email','c1@example.com','address','Bâtiment 75001'), null, 'fr');" 2>&1) || CASE_C1_RC=$?
POST_COUNT_C1=$(sql "select count(*) from orders;")
assert_rc "SADFP-V2-02 Cas C1 : adresse contenant '75001' MAIS postalCode structuré absent -- rejeté (nouveau moteur, aucun repli regex)" 1 "$([ "$CASE_C1_RC" != "0" ] && echo 1 || echo 0)"
assert_contains "SADFP-V2-02 Cas C1 : message 'Code postal absent' -- jamais un routage via le '75001' de l'adresse" "$CASE_C1_OUT" "Code postal absent"
assert_eq "SADFP-V2-02 Cas C1 : aucune commande créée (rejet avant tout INSERT, pas de mutation partielle)" "$PRE_COUNT_C1" "$POST_COUNT_C1"

# Cas C2 : postalCode structuré = "   " (uniquement des espaces),
# même adresse -- doit être trim() -> NULL puis rejeté EXACTEMENT
# comme C1, jamais silencieusement accepté ni réconcilié avec l'adresse.
PRE_COUNT_C2=$(sql "select count(*) from orders;")
CASE_C2_RC=0
CASE_C2_OUT=$(psql -d "$DB" -c "select 1 from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',3,'option_item_id',null)), null, jsonb_build_object('name','C2','phone','0600000012','email','c2@example.com','address','Bâtiment 75001','postalCode','   '), null, 'fr');" 2>&1) || CASE_C2_RC=$?
POST_COUNT_C2=$(sql "select count(*) from orders;")
assert_rc "SADFP-V2-02 Cas C2 : postalCode structuré blanc ('   ') -- trim() -> NULL -- rejeté, même comportement que C1" 1 "$([ "$CASE_C2_RC" != "0" ] && echo 1 || echo 0)"
assert_contains "SADFP-V2-02 Cas C2 : message 'Code postal absent' -- aucun repli regex même avec un postalCode explicitement blanc" "$CASE_C2_OUT" "Code postal absent"
assert_eq "SADFP-V2-02 Cas C2 : aucune commande créée" "$PRE_COUNT_C2" "$POST_COUNT_C2"

# out-of-zone via le nouveau moteur (aucun fallback -- désactive
# temporairement le fallback pour prouver le cas "aucune règle du
# tout").
sql "update restaurant_sale_mode_fulfillments set enabled=false where restaurant_id='$SANAA_ID' and fulfillment_code='wide_shipping';" >/dev/null
OOZ_RC=0
OOZ_OUT=$(psql -d "$DB" -c "select 1 from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',3,'option_item_id',null)), null, jsonb_build_object('name','Z','phone','0600000005','email','z@example.com','address','6 rue Test 13001 Marseille','postalCode','13001'), null, 'fr');" 2>&1) || OOZ_RC=$?
assert_rc "NOUVEAU MOTEUR : hors zone, aucun fallback actif -- rejeté" 1 "$([ "$OOZ_RC" != "0" ] && echo 1 || echo 0)"
assert_contains "message out-of-zone réutilise 'Zone non desservie'" "$OOZ_OUT" "Zone non desservie"
sql "update restaurant_sale_mode_fulfillments set enabled=true where restaurant_id='$SANAA_ID' and fulfillment_code='wide_shipping';" >/dev/null

# Pont de migration serveur : TOUTES les règles désactivées -- compte
# comme "aucune règle active", retombe sur legacy (byte-identique).
sql "update restaurant_sale_mode_fulfillments set enabled=false where restaurant_id='$SANAA_ID' and mode_code='delivery';" >/dev/null
BRIDGE_ROW=$(sql "select subtotal, delivery_fee, total from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',12,'option_item_id',null)), null, jsonb_build_object('name','B','phone','0600000006','email','b@example.com','address','7 rue Test 75001 Paris'), null, 'fr');")
assert_eq "PONT SERVEUR : toutes les règles enabled=false -- compte comme 'aucune règle active', retombe sur LEGACY (byte-identique)" "30.00|0.00|30.00" "$BRIDGE_ROW"
sql "update restaurant_sale_mode_fulfillments set enabled=true where restaurant_id='$SANAA_ID' and mode_code='delivery';" >/dev/null

# ==================================================================
# CLIENT NE PEUT JAMAIS FORCER LE PRESTATAIRE NI LE FRAIS
# ==================================================================
assert_eq "create_order : signature d'entrée INCHANGÉE (7 paramètres, aucun paramètre fee/provider possible)" "p_slug text, p_service_mode text, p_items jsonb, p_table_number integer, p_customer jsonb, p_note text, p_language text" "$(sql "select pg_get_function_identity_arguments(oid) from pg_proc where proname='create_order';")"
assert_eq "create_order : ignore silencieusement un fulfillment_code/provider/delivery_fee injecté dans p_customer (jamais lu, jamais utilisé)" "7.50|5.00|12.50" "$(sql "select subtotal, delivery_fee, total from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',3,'option_item_id',null)), null, jsonb_build_object('name','X','phone','0600000007','email','x@example.com','address','8 rue Test 75001 Paris','postalCode','75001','fulfillment_code','FAKE','provider','FAKE_PROVIDER','delivery_fee','999.00'), null, 'fr');")"

# ==================================================================
# SADFP-01 — CODE POSTAL STRUCTURÉ COMME SEULE SOURCE DE ROUTAGE
# (mission CORRECTION v2 §4) : preuves adversariales que le nouveau
# moteur route EXCLUSIVEMENT sur p_customer->>'postalCode', jamais sur
# une extraction regex depuis l'adresse en texte libre.
# ==================================================================

# Cas A : l'adresse contient un numéro qui RESSEMBLE à un code postal
# parisien ("75001"), mais le postalCode STRUCTURÉ est "13001" (hors
# zone 75, tombe sur le fallback). L'ANCIEN comportement (regex sur
# l'adresse) aurait à tort résolu local_delivery_75/5.00 -- la
# correction doit résoudre wide_shipping/8.00.
sql "select 1 from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',3,'option_item_id',null)), null, jsonb_build_object('name','CaseA','phone','0600000008','email','casea@example.com','address','Bâtiment 75001','postalCode','13001'), null, 'fr');" >/dev/null
CASE_A_ROW=$(sql "select fulfillment_code, delivery_fee from orders order by created_at desc limit 1;")
assert_eq "SADFP-01 Cas A : adresse trompeuse ('Bâtiment 75001') mais postalCode structuré '13001' -- route sur wide_shipping (fallback), JAMAIS local_delivery_75" "wide_shipping|8.00" "$CASE_A_ROW"

# Cas B : l'adresse contient PLUSIEURS nombres à 5 chiffres (75001 et
# 92100), mais le postalCode structuré '75001' doit seul décider --
# résultat identique à NEW_ROW (local_delivery_75/5.00).
CASE_B_ROW=$(sql "select subtotal, delivery_fee, total from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',3,'option_item_id',null)), null, jsonb_build_object('name','CaseB','phone','0600000009','email','caseb@example.com','address','92100 puis 75001, ambigu','postalCode','75001'), null, 'fr');")
assert_eq "SADFP-01 Cas B : adresse avec PLUSIEURS nombres à 5 chiffres -- route exclusivement sur le postalCode structuré '75001'" "7.50|5.00|12.50" "$CASE_B_ROW"

# Cas D : l'adresse est délibérément un faux/invalide ('FAKE 00000
# INVALID' -- ce '00000' ne matche aucun préfixe réel), mais le
# postalCode structuré '75001' reste valide -- doit quand même réussir
# via local_delivery_75. Prouve qu'un client ne peut pas empoisonner le
# routage via le champ adresse.
CASE_D_ROW=$(sql "select subtotal, delivery_fee, total from create_order('sanaa-cookies','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ID','quantity',3,'option_item_id',null)), null, jsonb_build_object('name','CaseD','phone','0600000010','email','cased@example.com','address','FAKE 00000 INVALID','postalCode','75001'), null, 'fr');")
assert_eq "SADFP-01 Cas D : adresse invalide/fausse mais postalCode structuré valide -- réussit via local_delivery_75 (structuré gagne toujours)" "7.50|5.00|12.50" "$CASE_D_ROW"

# ==================================================================
# INTÉGRITÉ / SÉCURITÉ
# ==================================================================
assert_eq "orders : CHECK total = subtotal + delivery_fee existe" "t" "$(sql "select exists (select 1 from pg_constraint where conname='orders_total_equals_subtotal_plus_delivery_fee');")"
DIRECT_UPDATE_RC=0
psql -d "$DB" -c "update orders set total = 99999 where id = (select id from orders order by created_at desc limit 1);" >/dev/null 2>&1 || DIRECT_UPDATE_RC=$?
assert_rc "CHECK bloque une écriture directe qui romprait l'invariant total=subtotal+delivery_fee" 1 "$([ "$DIRECT_UPDATE_RC" != "0" ] && echo 1 || echo 0)"
assert_eq "resolve_delivery_fulfillment reste révoqué de public/anon/authenticated (aucun appelant direct)" "" "$(sql "select string_agg(grantee,',') from information_schema.role_routine_grants where routine_name='resolve_delivery_fulfillment' and grantee in ('anon','authenticated','PUBLIC');")"
assert_eq "orders.fulfillment_rule_id référence bien restaurant_sale_mode_fulfillments(id)" "t" "$(sql "select exists (select 1 from information_schema.table_constraints tc join information_schema.key_column_usage kcu on tc.constraint_name=kcu.constraint_name where tc.table_name='orders' and tc.constraint_type='FOREIGN KEY' and kcu.column_name='fulfillment_rule_id');")"

# ==================================================================
# FIXTURE COMMUNE — preuve de déterminisme du calcul de frais
# (mission §13/§22), même patron que la section "FIXTURE COMMUNE"
# de fulfillment-routing-lot-b-check.sh (FRB-B-02) : tests/fixtures/
# delivery-pricing-cases.json est LA source de vérité unique,
# également consommée côté TypeScript par
# tests/v102-delivery-pricing-determinism.test.ts -- MÊME cas, MÊME
# résultat attendu des deux côtés.
#
# le-sirocco (tenant "table only", sans mode delivery propre) sert de
# tenant scratch dédié -- jamais Sanaa (ses propres règles de
# tarification, utilisées par les sections précédentes de ce harnais,
# resteraient sans rapport si on les écrasait ici). Un mode 'delivery'
# est créé pour l'occasion (Sirocco n'en a structurellement aucun),
# chaque cas nettoie ses propres données avant de s'exécuter (voir le
# générateur), aucune interférence possible avec les sections
# précédentes.
# ==================================================================
sql "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order) values ('$SIROCCO_ID','delivery',true,9) on conflict do nothing;" >/dev/null

FIXTURE_JSON="$ROOT/tests/fixtures/delivery-pricing-cases.json"
GENERATOR="$SUPABASE_DIR/tests/generate-delivery-pricing-fixture-checks.mjs"
FIXTURE_SQL="/tmp/scanym-pricing-fixture-checks-$$.sql"

assert_eq "le générateur de fixture prix existe" "t" "$([ -f "$GENERATOR" ] && echo t || echo f)"
node "$GENERATOR" "$FIXTURE_JSON" "$SIROCCO_ID" "delivery" > "$FIXTURE_SQL"

FIXTURE_CASE_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$FIXTURE_JSON','utf8')).cases.length)")
log "Fixture prix : $FIXTURE_CASE_COUNT cas générés depuis $FIXTURE_JSON"

FIXTURE_OUT=$(psql -X -A -q -t -d "$DB" -f "$FIXTURE_SQL")
FIXTURE_LINE_COUNT=$(echo "$FIXTURE_OUT" | grep -c '|' || true)
assert_eq "le script généré produit exactement 1 ligne de résultat par cas de la fixture prix ($FIXTURE_CASE_COUNT attendues)" "$FIXTURE_CASE_COUNT" "$FIXTURE_LINE_COUNT"

while IFS='|' read -r case_id passed actual; do
  [ -z "$case_id" ] && continue
  if [ "$passed" = "t" ]; then
    pass "FIXTURE PRIX[$case_id]: SQL produit exactement le delivery_fee attendu (identique au contrat frontend)"
  else
    fail "FIXTURE PRIX[$case_id]: SQL diverge du delivery_fee attendu -- obtenu $actual"
  fi
done <<< "$FIXTURE_OUT"

rm -f "$FIXTURE_SQL"
sql "delete from restaurant_sale_mode_fulfillments where restaurant_id='$SIROCCO_ID' and mode_code='delivery'; delete from restaurant_sale_modes where restaurant_id='$SIROCCO_ID' and mode_code='delivery';" >/dev/null

log "=== RÉSUMÉ : $PASS_COUNT PASS / $FAIL_COUNT FAIL ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "--- détail des échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
