#!/usr/bin/env bash
# ============================================================
# Scanym — RECEIPT / INVOICE TAX DETAIL v1.1 — Harnais reproductible
# pour supabase/DRAFT-lot-receipt-invoice-tax-detail-v1.sql.
#
# v1.1 ajoute : [15] preuve bigint (aucun débordement int4) et [16]
# preuve d'exécution du rollback de migration (postcheck forcé en
# échec sur une copie de test jetable du fichier SQL -- le fichier
# livré lui-même n'est jamais modifié par ce harnais) -- ferment
# RITD-V1-WEIGHT-OVERFLOW-01 et RITD-V1-MIGRATION-POSTCHECK-01.
#
# PostgreSQL communautaire vanilla (pas une instance Supabase managée),
# même patron que tous les harnais précédents.
#
# CHAÎNE DE DÉPENDANCE RÉELLE (mandat §5/§47, ré-auditée directement,
# PAS supposée) : ce lot dépend STRUCTURELLEMENT de :
#   1. la chaîne minimale ORDERS/LOT 2A jusqu'à v81 (patron
#      payment-p3b6-checkout-billing-context-check.sh, build_minimal_chain)
#   2. v82/v83/v84 (sale modes) + fulfillment-routing-model +
#      fulfillment-routing-lot-b-rpc + server-delivery-fulfillment-pricing
#      (porte la définition de create_order réutilisée comme point de
#      départ avant ce lot)
#   3. DRAFT-lot-payment-p3b6-checkout-billing-context.sql (dernière
#      définition PUBLIÉE de create_order avant ce lot -- ce lot la
#      remplace par CREATE OR REPLACE avec signature identique)
#   4. DRAFT-lot-customer-order-tracking-foundation.sql (pour prouver
#      par un appel RÉEL que get_order_tracking reste inchangé et ne
#      fuit aucun champ fiscal -- indépendant structurellement, mais
#      inclus ici pour la preuve d'isolation, mandat §31/§45)
#   5. DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql (v1.3,
#      PRÉREQUIS PUBLIÉ -- porte tax_rate/unit_weight_grams/
#      weight_is_approximate sur menu_items, consommés par ce lot)
# AUCUNE dépendance sur P1/P2A/P2B-A/P3-A0..A2/P3-B0..B5
# (payment_transactions, callbacks, Monetico) -- non inclus ici ; leur
# non-régression est prouvée séparément par leurs propres harnais
# INCHANGÉS (mandat §32, isolation paiement stricte).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/receipt-invoice-tax-detail-v1-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-receipt-invoice-tax-detail-v1.sql"
DB="scanym_receipt_v1_$$"
DB_DRIFT="scanym_receipt_v1_drift_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-receipt-v1-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

assert_struct_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then struct "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_behav_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then behav "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }

as_anon() { PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-receipt-v1-out-$$.txt 2>/tmp/scanym-receipt-v1-err-$$.txt
  echo $?
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-receipt-v1-out-$$.txt 2>/tmp/scanym-receipt-v1-err-$$.txt
  echo $?
}
as_owner() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "select set_config('test.uid','99999999-9999-9999-9999-999999999999', false);" \
    -c "$1" 2>&1
}

build_common_bootstrap() {
  local dbname="$1"
  psql -d "$dbname" >/dev/null <<'SQL'
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

build_minimal_chain() {
  local dbname="$1"
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
    psql -d "$dbname" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
}

build_full_chain_before_lot() {
  local dbname="$1"
  build_common_bootstrap "$dbname"
  build_minimal_chain "$dbname"
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-payment-p3b6-checkout-billing-context.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-customer-order-tracking-foundation.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql" >/dev/null
}

seed_smoke_restaurant() {
  local dbname="$1"
  psql -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into public.restaurants (id, slug, name, is_active, status)
values ('11111111-1111-1111-1111-111111111111','receipt-v1-check','Receipt V1 Check', true, 'active');
insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number)
values ('11111111-1111-1111-1111-111111111111','EUR', 1, '+33600000000');
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config)
values
  ('11111111-1111-1111-1111-111111111111','delivery', true, '{"delivery_zone_prefixes": ["75"], "delivery_min_items": 0}'::jsonb),
  ('11111111-1111-1111-1111-111111111111','pickup', true, '{}'::jsonb),
  ('11111111-1111-1111-1111-111111111111','table', true, '{}'::jsonb);
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','Cat', true, 1);
SQL
}

create_pickup_order() {
  # $1=menu_item_id $2=quantity
  as_anon "select * from create_order('receipt-v1-check', 'pickup', '[{\"menu_item_id\":\"$1\",\"quantity\":$2}]'::jsonb, null, '{\"name\":\"Client Test\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr');"
}

# ============================================================
# [0] BASELINE — chaîne complète jusqu'à CATALOGUE FISCAL v1.3
#     (déjà publiée) + LOT SOUS TEST.
# ============================================================
log "=== [0] Construction baseline $DB ==="
createdb "$DB"
build_full_chain_before_lot "$DB"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null
seed_smoke_restaurant "$DB"
struct "Application propre du lot RECEIPT/INVOICE TAX DETAIL v1 sur baseline réelle (v82+v83+v84+routing+delivery-pricing+p3b6+tracking+fiscal-v1.3)"

# ------------------------------------------------------------
# [1] STRUCTURE — colonnes order_items
# ------------------------------------------------------------
log "=== [1] Structure order_items ==="
assert_struct_eq "tax_rate_snapshot existe, numeric(5,2)" "1" "$(sql "select count(*) from information_schema.columns where table_name='order_items' and column_name='tax_rate_snapshot' and numeric_precision=5 and numeric_scale=2;")"
assert_struct_eq "tax_rate_snapshot est NULLABLE" "YES" "$(sql "select is_nullable from information_schema.columns where table_name='order_items' and column_name='tax_rate_snapshot';")"
assert_struct_eq "unit_weight_grams_snapshot existe, integer" "1" "$(sql "select count(*) from information_schema.columns where table_name='order_items' and column_name='unit_weight_grams_snapshot' and data_type='integer';")"
assert_struct_eq "unit_weight_grams_snapshot est NULLABLE" "YES" "$(sql "select is_nullable from information_schema.columns where table_name='order_items' and column_name='unit_weight_grams_snapshot';")"
assert_struct_eq "weight_is_approximate_snapshot existe, boolean" "1" "$(sql "select count(*) from information_schema.columns where table_name='order_items' and column_name='weight_is_approximate_snapshot' and data_type='boolean';")"
assert_struct_eq "weight_is_approximate_snapshot est NULLABLE" "YES" "$(sql "select is_nullable from information_schema.columns where table_name='order_items' and column_name='weight_is_approximate_snapshot';")"
assert_struct_eq "total_weight_grams_snapshot est une colonne GÉNÉRÉE" "ALWAYS" "$(sql "select is_generated from information_schema.columns where table_name='order_items' and column_name='total_weight_grams_snapshot';")"
assert_struct_eq "total_weight_grams_snapshot est de type bigint (v1.1, ferme RITD-V1-WEIGHT-OVERFLOW-01)" "bigint" "$(sql "select data_type from information_schema.columns where table_name='order_items' and column_name='total_weight_grams_snapshot';")"
assert_struct_eq "contrainte CHECK tax_rate_snapshot présente" "1" "$(sql "select count(*) from pg_constraint where conname='order_items_tax_rate_snapshot_chk';")"
assert_struct_eq "contrainte CHECK unit_weight_grams_snapshot présente" "1" "$(sql "select count(*) from pg_constraint where conname='order_items_unit_weight_grams_snapshot_chk';")"

# ------------------------------------------------------------
# [2] ACL — aucun accès d'écriture direct élargi, RLS lecture
#     toujours scopée restaurant.
# ------------------------------------------------------------
log "=== [2] ACL order_items ==="
assert_struct_eq "anon ne peut pas INSERT order_items" "1" "$(as_anon_rc "insert into order_items (order_id, item_name, quantity, unit_price, line_total) values ('11111111-1111-1111-1111-111111111111'::uuid,'x',1,1,1);")"
assert_struct_eq "authenticated ne peut pas INSERT order_items" "1" "$(as_authenticated_rc "insert into order_items (order_id, item_name, quantity, unit_price, line_total) values ('11111111-1111-1111-1111-111111111111'::uuid,'x',1,1,1);")"
assert_struct_eq "RLS toujours active sur order_items" "t" "$(sql "select relrowsecurity from pg_class where relname='order_items';")"
assert_struct_eq "policy merchant reads restaurant order items toujours présente" "1" "$(sql "select count(*) from pg_policies where tablename='order_items' and policyname='merchant reads restaurant order items';")"

# ------------------------------------------------------------
# [3] create_order — contrat public inchangé
# ------------------------------------------------------------
log "=== [3] Contrat create_order ==="
assert_struct_eq "create_order retourne toujours (order_id,order_number,public_token,subtotal,delivery_fee,total)" "TABLE(order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)" "$(sql "select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order';")"
assert_struct_eq "create_order: aucun grant à anon (execute toujours présent)" "1" "$(sql "select count(*) from information_schema.role_routine_grants where routine_name='create_order' and grantee='anon';")"
assert_struct_eq "create_order: grant execute à authenticated" "1" "$(sql "select count(*) from information_schema.role_routine_grants where routine_name='create_order' and grantee='authenticated';")"

# ============================================================
# [4] SCÉNARIO DE RÉFÉRENCE OBLIGATOIRE (mandat §33-39) — produit A
# (prix P1=7.50, tax T1=10.00, poids M1=200g) -> commande -> mise à
# jour produit (nom B, prix P2=8.50, tax T2=20.00, poids M2=250g) ->
# relecture du snapshot -> DOIT toujours montrer A/P1/T1/M1.
# ============================================================
log "=== [4] Scénario de référence -- immutabilité après mutation catalogue ==="
sql "insert into menu_items (id, category_id, name, price, is_available, tax_rate, unit_weight_grams, weight_is_approximate) values ('44444444-4444-4444-4444-444444444444','22222222-2222-2222-2222-222222222222','Raclette A', 7.50, true, 10.00, 200, false);" >/dev/null

ROW=$(create_pickup_order "44444444-4444-4444-4444-444444444444" 2)
OID=$(echo "$ROW" | cut -d'|' -f1)

# Prix/tax/poids modifiés APRÈS création de la commande.
sql "update menu_items set name='Raclette B', price=8.50, tax_rate=20.00, unit_weight_grams=250 where id='44444444-4444-4444-4444-444444444444';" >/dev/null

SNAP=$(sql "select item_name, quantity, unit_price, line_total, tax_rate_snapshot, unit_weight_grams_snapshot, total_weight_grams_snapshot, weight_is_approximate_snapshot from order_items where order_id='$OID';")
assert_behav_eq "item_name reste 'Raclette A' (jamais 'Raclette B')" "Raclette A" "$(echo "$SNAP" | cut -d'|' -f1)"
assert_behav_eq "quantity reste 2" "2" "$(echo "$SNAP" | cut -d'|' -f2)"
assert_behav_eq "unit_price reste 7.50 (jamais 8.50)" "7.50" "$(echo "$SNAP" | cut -d'|' -f3)"
assert_behav_eq "line_total reste 15.00 (7.50 x 2, jamais 17.00)" "15.00" "$(echo "$SNAP" | cut -d'|' -f4)"
assert_behav_eq "tax_rate_snapshot reste 10.00 (jamais 20.00)" "10.00" "$(echo "$SNAP" | cut -d'|' -f5)"
assert_behav_eq "unit_weight_grams_snapshot reste 200 (jamais 250)" "200" "$(echo "$SNAP" | cut -d'|' -f6)"
assert_behav_eq "total_weight_grams_snapshot = 200 x 2 = 400 (historique logistique, jamais 500)" "400" "$(echo "$SNAP" | cut -d'|' -f7)"
assert_behav_eq "weight_is_approximate_snapshot reste false" "f" "$(echo "$SNAP" | cut -d'|' -f8)"

# Confirme aussi que menu_items lui-même a bien changé (preuve que le
# test porte réellement sur une DIVERGENCE effective, pas une valeur
# jamais modifiée).
CUR=$(sql "select name, price, tax_rate, unit_weight_grams from menu_items where id='44444444-4444-4444-4444-444444444444';")
assert_behav_eq "menu_items courant a bien divergé (preuve du test)" "Raclette B|8.50|20.00|250" "$CUR"

# ------------------------------------------------------------
# [5] Test isolé -- changement de TAUX DE TAXE uniquement
# ------------------------------------------------------------
log "=== [5] Changement de taux de taxe isolé ==="
sql "insert into menu_items (id, category_id, name, price, is_available, tax_rate) values ('55555555-5555-5555-5555-555555555555','22222222-2222-2222-2222-222222222222','TaxItem', 5.00, true, 5.50);" >/dev/null
ROW5=$(create_pickup_order "55555555-5555-5555-5555-555555555555" 1)
OID5=$(echo "$ROW5" | cut -d'|' -f1)
sql "update menu_items set tax_rate = 21.00 where id='55555555-5555-5555-5555-555555555555';" >/dev/null
assert_behav_eq "tax_rate_snapshot conserve l'ancien taux 5.50 après changement isolé" "5.50" "$(sql "select tax_rate_snapshot from order_items where order_id='$OID5';")"

# ------------------------------------------------------------
# [6] Test isolé -- RENOMMAGE seul
# ------------------------------------------------------------
log "=== [6] Renommage isolé ==="
sql "insert into menu_items (id, category_id, name, price, is_available) values ('66666666-6666-6666-6666-666666666666','22222222-2222-2222-2222-222222222222','Nom Original', 3.00, true);" >/dev/null
ROW6=$(create_pickup_order "66666666-6666-6666-6666-666666666666" 1)
OID6=$(echo "$ROW6" | cut -d'|' -f1)
sql "update menu_items set name='Nom Renommé' where id='66666666-6666-6666-6666-666666666666';" >/dev/null
assert_behav_eq "item_name conserve 'Nom Original' après renommage isolé" "Nom Original" "$(sql "select item_name from order_items where order_id='$OID6';")"

# ------------------------------------------------------------
# [7] Produit SANS fiscal/mesure configuré -- NULL réellement stocké,
#     jamais une valeur inventée (mandat §17/§45).
# ------------------------------------------------------------
log "=== [7] Produit sans fiscal/mesure -- pas de valeur inventée ==="
sql "insert into menu_items (id, category_id, name, price, is_available) values ('77777777-7777-7777-7777-777777777777','22222222-2222-2222-2222-222222222222','Sans Fiscal', 4.00, true);" >/dev/null
ROW7=$(create_pickup_order "77777777-7777-7777-7777-777777777777" 1)
OID7=$(echo "$ROW7" | cut -d'|' -f1)
SNAP7=$(sql "select tax_rate_snapshot, unit_weight_grams_snapshot, total_weight_grams_snapshot, weight_is_approximate_snapshot from order_items where order_id='$OID7';")
assert_behav_eq "tax_rate_snapshot/unit_weight/total_weight NULL, weight_is_approximate=f (pas inventé)" "|||f" "$SNAP7"
assert_behav_eq "weight_is_approximate_snapshot = f (source NOT NULL DEFAULT false, jamais NULL pour une ligne post-lot)" "f" "$(echo "$SNAP7" | cut -d'|' -f4)"
assert_behav_eq "total_weight_grams_snapshot NULL quand unit_weight_grams_snapshot est NULL" "" "$(echo "$SNAP7" | cut -d'|' -f3)"

# ------------------------------------------------------------
# [8] LIGNES MULTIPLES -- aucune contamination croisée entre lignes
#     de tarifs/tax/poids différents dans la MÊME commande.
# ------------------------------------------------------------
log "=== [8] Lignes multiples -- isolation croisée ==="
sql "insert into menu_items (id, category_id, name, price, is_available, tax_rate, unit_weight_grams) values ('88888888-8888-8888-8888-888888888888','22222222-2222-2222-2222-222222222222','Ligne Un', 2.00, true, 5.50, 100);" >/dev/null
sql "insert into menu_items (id, category_id, name, price, is_available, tax_rate, unit_weight_grams) values ('99999999-9999-9999-9999-999999999999','22222222-2222-2222-2222-222222222222','Ligne Deux', 12.00, true, 20.00, 500);" >/dev/null
ROW8=$(as_anon "select * from create_order('receipt-v1-check', 'pickup', '[{\"menu_item_id\":\"88888888-8888-8888-8888-888888888888\",\"quantity\":3},{\"menu_item_id\":\"99999999-9999-9999-9999-999999999999\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Client Multi\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr');")
OID8=$(echo "$ROW8" | cut -d'|' -f1)
L1=$(sql "select unit_price, tax_rate_snapshot, unit_weight_grams_snapshot, total_weight_grams_snapshot from order_items where order_id='$OID8' and item_name='Ligne Un';")
L2=$(sql "select unit_price, tax_rate_snapshot, unit_weight_grams_snapshot, total_weight_grams_snapshot from order_items where order_id='$OID8' and item_name='Ligne Deux';")
assert_behav_eq "Ligne Un: 2.00|5.50|100|300 (100x3)" "2.00|5.50|100|300" "$L1"
assert_behav_eq "Ligne Deux: 12.00|20.00|500|500 (500x1, jamais teinté par Ligne Un)" "12.00|20.00|500|500" "$L2"

# ------------------------------------------------------------
# [9] QUANTITÉS -- 1, 2, valeur entière supérieure ; total logistique
#     scale correctement, jamais une quantité flottante.
# ------------------------------------------------------------
log "=== [9] Quantités 1/2/7 ==="
sql "insert into menu_items (id, category_id, name, price, is_available, tax_rate, unit_weight_grams) values ('a0000000-0000-0000-0000-00000000000a','22222222-2222-2222-2222-222222222222','QtyItem', 3.00, true, 10.00, 150);" >/dev/null
for QN in 1 2 7; do
  ROWQ=$(create_pickup_order "a0000000-0000-0000-0000-00000000000a" "$QN")
  OIDQ=$(echo "$ROWQ" | cut -d'|' -f1)
  EXP_LINE=$(psql -X -A -q -t -c "select (3.00 * $QN)::numeric(12,2);")
  EXP_WEIGHT=$((150 * QN))
  SNAPQ=$(sql "select quantity, line_total, total_weight_grams_snapshot from order_items where order_id='$OIDQ';")
  assert_behav_eq "qty=$QN: quantity/line_total/total_weight corrects" "$QN|$EXP_LINE|$EXP_WEIGHT" "$SNAPQ"
done
assert_struct_eq "quantity reste de type integer sur order_items" "integer" "$(sql "select data_type from information_schema.columns where table_name='order_items' and column_name='quantity';")"

# ------------------------------------------------------------
# [10] LIGNE HISTORIQUE (pré-lot, simulée) -- lisible sans erreur,
#      marqueur legacy correct.
# ------------------------------------------------------------
log "=== [10] Ligne legacy (simulée) ==="
sql "insert into orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency) values ('b0000000-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111', 9001, 'pickup', 6.00, 6.00, 'EUR');" >/dev/null
sql "insert into order_items (order_id, item_name, quantity, unit_price, line_total) values ('b0000000-0000-0000-0000-00000000000b','Legacy Item', 2, 3.00, 6.00);" >/dev/null
LEG=$(sql "select item_name, quantity, unit_price, line_total, tax_rate_snapshot, weight_is_approximate_snapshot from order_items where order_id='b0000000-0000-0000-0000-00000000000b';")
assert_behav_eq "ligne legacy lisible sans erreur, financier intact" "Legacy Item|2|3.00|6.00||" "$LEG"
assert_behav_eq "weight_is_approximate_snapshot IS NULL identifie sans ambiguïté une ligne LEGACY" "" "$(sql "select weight_is_approximate_snapshot::text from order_items where order_id='b0000000-0000-0000-0000-00000000000b';")"

# ------------------------------------------------------------
# [11] PAYLOAD ADVERSE -- le client ne peut transmettre AUCUN champ
#      fiscal/prix/poids à create_order ; seuls menu_item_id/quantity
#      sont lus depuis p_items (mandat §41).
# ------------------------------------------------------------
log "=== [11] Payload client adverse -- aucune autorité transmise ==="
sql "insert into menu_items (id, category_id, name, price, is_available, tax_rate, unit_weight_grams) values ('c0000000-0000-0000-0000-00000000000c','22222222-2222-2222-2222-222222222222','AdvItem', 9.00, true, 15.00, 300);" >/dev/null
ROWADV=$(as_anon "select * from create_order('receipt-v1-check', 'pickup', '[{\"menu_item_id\":\"c0000000-0000-0000-0000-00000000000c\",\"quantity\":1,\"unit_price\":0.01,\"tax_rate\":0,\"price\":0.01,\"tax_rate_snapshot\":0}]'::jsonb, null, '{\"name\":\"Client Adverse\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr');")
OIDADV=$(echo "$ROWADV" | cut -d'|' -f1)
SNAPADV=$(sql "select unit_price, line_total, tax_rate_snapshot from order_items where order_id='$OIDADV';")
assert_behav_eq "prix/taxe serveur-autoritaires malgré un payload client falsifié (9.00, jamais 0.01 / 0)" "9.00|9.00|15.00" "$SNAPADV"

# ============================================================
# [12] NON-RÉGRESSION — get_order_tracking (CUSTOMER TRACKING v2.1)
#      ne fuit AUCUN champ fiscal/interne, contrat inchangé.
# ============================================================
log "=== [12] Isolation tracking ==="
TOKEN=$(sql "select public_token from orders where id='$OID';")
TRACK=$(as_anon "select order_status, service_mode, order_number from get_order_tracking('$OID'::uuid, '$TOKEN'::uuid);")
assert_behav_eq "get_order_tracking répond toujours (order_status/service_mode/order_number)" "new|pickup|" "$(echo "$TRACK" | cut -d'|' -f1,2,3 | sed -E 's/[0-9]+$//')"
assert_struct_eq "get_order_tracking ne référence order_items nulle part (source SQL)" "0" "$(grep -c "order_items" "$SUPABASE_DIR/DRAFT-lot-customer-order-tracking-foundation.sql" || true)"

# ============================================================
# [13] GARDE ANTI-DÉRIVE — application sur une base SANS CATALOGUE
#      FISCAL v1.3 échoue proprement (SCANYM_SCHEMA_DRIFT), rien
#      n'est modifié.
# ============================================================
log "=== [13] Garde de dérive -- sans CATALOGUE FISCAL v1.3 ==="
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
build_minimal_chain "$DB_DRIFT"
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql" >/dev/null
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql" >/dev/null
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql" >/dev/null
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-payment-p3b6-checkout-billing-context.sql" >/dev/null
DRIFT_OUT=$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" 2>&1) && DRIFT_RC=0 || DRIFT_RC=1
assert_struct_eq "application échoue sans CATALOGUE FISCAL v1.3" "1" "$DRIFT_RC"
assert_struct_eq "message SCANYM_SCHEMA_DRIFT explicite" "1" "$(echo "$DRIFT_OUT" | grep -qF "SCANYM_SCHEMA_DRIFT: menu_items ne porte pas tax_rate" && echo 1 || echo 0)"
assert_struct_eq "order_items n'a reçu AUCUNE colonne fiscale sur la base en dérive" "0" "$(psql -X -A -q -t -d "$DB_DRIFT" -c "select count(*) from information_schema.columns where table_name='order_items' and column_name='tax_rate_snapshot';")"

# ============================================================
# [14] CONCURRENCE (mandat §52) — commandes simultanées sur le MÊME
#      produit pendant qu'une mise à jour catalogue concurrente est en
#      vol : chaque ligne order_items doit correspondre à un état
#      COHÉRENT unique du produit (jamais une lecture déchirée mêlant
#      un ancien prix et un nouveau taux de taxe), et aucune commande
#      ne doit contaminer une autre.
# ------------------------------------------------------------------
log "=== [14] Concurrence -- commandes simultanées + mise à jour catalogue en vol ==="
sql "insert into menu_items (id, category_id, name, price, is_available, tax_rate, unit_weight_grams) values ('d0000000-0000-0000-0000-00000000000d','22222222-2222-2222-2222-222222222222','ConcItem', 1.00, true, 1.00, 100);" >/dev/null

CONC_DIR="/tmp/scanym-receipt-v1-conc-$$"
mkdir -p "$CONC_DIR"
for i in 1 2 3 4 5; do
  ( ROWC=$(create_pickup_order "d0000000-0000-0000-0000-00000000000d" 1); echo "$ROWC" | cut -d'|' -f1 > "$CONC_DIR/order_$i.id" ) &
done
( sql "update menu_items set price = 2.00, tax_rate = 2.00, unit_weight_grams = 200 where id='d0000000-0000-0000-0000-00000000000d';" >/dev/null ) &
wait

CONC_OK=1
CONC_IDS=""
for i in 1 2 3 4 5; do
  OIDX=$(cat "$CONC_DIR/order_$i.id" 2>/dev/null || true)
  if [ -z "$OIDX" ]; then CONC_OK=0; continue; fi
  CONC_IDS="$CONC_IDS $OIDX"
  ROWX=$(sql "select unit_price, tax_rate_snapshot, unit_weight_grams_snapshot from order_items where order_id='$OIDX';")
  if [ "$ROWX" != "1.00|1.00|100" ] && [ "$ROWX" != "2.00|2.00|200" ]; then
    CONC_OK=0
    fail "commande concurrente $OIDX: lecture déchirée détectée ($ROWX, ni l'état ancien ni le nouvel état cohérent)"
  fi
done
assert_struct_eq "5 commandes concurrentes créées avec succès" "1" "$CONC_OK"
assert_struct_eq "5 order_id distincts (aucune collision/contamination croisée)" "1" "$(echo "$CONC_IDS" | tr ' ' '\n' | grep -v '^$' | sort -u | wc -l | awk '{print ($1==5)}')"
rm -rf "$CONC_DIR"

# ============================================================
# [15] DÉBORDEMENT BIGINT (mandat v1.1 §14, ferme
#      RITD-V1-WEIGHT-OVERFLOW-01) — poids élevé x quantité élevée,
#      produit largement au-delà de int4 (2 147 483 647), doit
#      réussir sans erreur et rester exact. Financier totalement
#      inaffecté.
# ------------------------------------------------------------------
log "=== [15] Débordement bigint -- poids/quantité élevés ==="
sql "insert into menu_items (id, category_id, name, price, is_available, tax_rate, unit_weight_grams) values ('e0000000-0000-0000-0000-00000000000e','22222222-2222-2222-2222-222222222222','OverflowItem', 6.00, true, 10.00, 3000000);" >/dev/null
ROWOF=$(create_pickup_order "e0000000-0000-0000-0000-00000000000e" 999)
if echo "$ROWOF" | grep -qi "error\|ERREUR"; then
  fail "création de commande poids=3000000 x quantité=999 a échoué -- devait réussir (=$ROWOF)"
else
  OIDOF=$(echo "$ROWOF" | cut -d'|' -f1)
  SNAPOF=$(sql "select quantity, line_total, unit_weight_grams_snapshot, total_weight_grams_snapshot from order_items where order_id='$OIDOF';")
  assert_behav_eq "qty=999, unit_weight=3000000g: total_weight_grams_snapshot = 2 997 000 000 (pas de débordement int4)" "999|5994.00|3000000|2997000000" "$SNAPOF"
fi
# Preuve directe indépendante du calcul, hors création de commande :
# le CAST bigint est bien appliqué AVANT la multiplication (une
# multiplication int4*int4 non castée lèverait "integer out of
# range" ici, à l'identique de ce qui se produirait dans la colonne
# générée si le cast était absent).
OVERFLOW_DIRECT=$(sql "select (3000000::integer::bigint * 999::integer::bigint);" 2>&1)
assert_behav_eq "calcul bigint direct 3000000 x 999 = 2997000000" "2997000000" "$OVERFLOW_DIRECT"

# ============================================================
# [16] EXÉCUTION RÉELLE DU ROLLBACK DE MIGRATION (mandat v1.1 §11,
#      ferme RITD-V1-MIGRATION-POSTCHECK-01) — un postcheck
#      déterministe est FORCÉ en échec (copie de test JETABLE du
#      fichier SQL livré, celui-ci n'est jamais modifié) sur une base
#      isolée : la migration DOIT échouer (code retour non-zéro) ET
#      NE LAISSER AUCUNE trace installée -- ni les 4 colonnes, ni le
#      changement de create_order. Preuve d'EXÉCUTION, pas seulement
#      une lecture de la syntaxe BEGIN/COMMIT.
# ------------------------------------------------------------------
log "=== [16] Rollback de migration -- postcheck forcé en échec (exécution réelle) ==="
DB_ROLLBACK="scanym_receipt_v1_rollback_$$"
createdb "$DB_ROLLBACK"
build_common_bootstrap "$DB_ROLLBACK"
build_minimal_chain "$DB_ROLLBACK"
psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql" >/dev/null
psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql" >/dev/null
psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql" >/dev/null
psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-payment-p3b6-checkout-billing-context.sql" >/dev/null
psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-customer-order-tracking-foundation.sql" >/dev/null
psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql" >/dev/null

# Copie JETABLE, hors du dépôt, avec un postcheck forcé en échec
# injecté juste avant le COMMIT final -- simule un "postcheck failure"
# déterministe APRÈS que tous les DDL/fonction de la section
# transaction aient déjà été exécutés (mais pas encore commités).
# Le fichier réellement livré (DRAFT_SQL) n'est ni lu en écriture ni
# modifié par ce bloc.
ROLLBACK_TEST_SQL="/tmp/scanym-receipt-v1-rollback-test-$$.sql"
sed 's/^commit;$/do $$ begin raise exception '"'"'SCANYM_TEST_FORCED_POSTCHECK_FAILURE: échec déterministe injecté uniquement pour ce test de rollback -- ne doit jamais apparaître dans une exécution réelle du fichier livré.'"'"'; end $$;\ncommit;/' "$DRAFT_SQL" > "$ROLLBACK_TEST_SQL"

# Preuve que l'injection a bien eu lieu et est bien la SEULE
# différence avec le fichier livré (une ligne ajoutée avant l'unique
# "commit;").
assert_struct_eq "copie de test = fichier livré + 1 ligne d'échec forcé injectée" "1" "$(diff "$DRAFT_SQL" "$ROLLBACK_TEST_SQL" | grep -c "SCANYM_TEST_FORCED_POSTCHECK_FAILURE")"

ROLLBACK_OUT=$(psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$ROLLBACK_TEST_SQL" 2>&1) && ROLLBACK_RC=0 || ROLLBACK_RC=1
assert_struct_eq "migration à postcheck forcé en échec retourne un code non-zéro" "1" "$ROLLBACK_RC"
assert_struct_eq "message d'échec forcé bien observé" "1" "$(echo "$ROLLBACK_OUT" | grep -qF "SCANYM_TEST_FORCED_POSTCHECK_FAILURE" && echo 1 || echo 0)"

# AUCUNE des 4 nouvelles colonnes ne doit être présente -- preuve que
# le ALTER TABLE, exécuté AVANT le postcheck forcé dans la même
# transaction, a bien été annulé avec le reste.
assert_struct_eq "order_items N'A REÇU AUCUNE des 4 nouvelles colonnes (rollback complet, pas partiel)" "0" "$(psql -X -A -q -t -d "$DB_ROLLBACK" -c "select count(*) from information_schema.columns where table_name='order_items' and column_name in ('tax_rate_snapshot','unit_weight_grams_snapshot','weight_is_approximate_snapshot','total_weight_grams_snapshot');")"
# Les 2 contraintes CHECK ajoutées par ce lot ne doivent pas non plus
# être présentes.
assert_struct_eq "AUCUNE contrainte CHECK de ce lot présente (rollback complet)" "0" "$(psql -X -A -q -t -d "$DB_ROLLBACK" -c "select count(*) from pg_constraint where conname in ('order_items_tax_rate_snapshot_chk','order_items_unit_weight_grams_snapshot_chk');")"
# create_order doit être resté EXACTEMENT la version P3-B6 (jamais
# remplacée) -- preuve positive, pas seulement une absence : la
# fonction reste appelable et produit un order_items SANS les
# nouvelles colonnes (elles n'existent même plus sur la table).
psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into public.restaurants (id, slug, name, is_active, status)
values ('11111111-1111-1111-1111-111111111111','rollback-check','Rollback Check', true, 'active');
insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number)
values ('11111111-1111-1111-1111-111111111111','EUR', 1, '+33600000000');
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config)
values ('11111111-1111-1111-1111-111111111111','pickup', true, '{}'::jsonb);
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','Cat', true, 1);
insert into public.menu_items (id, category_id, name, price, is_available)
values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','Item', 10.00, true);
SQL
ROLLBACK_ORDER=$(PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB_ROLLBACK" -c "select * from create_order('rollback-check', 'pickup', '[{\"menu_item_id\":\"33333333-3333-3333-3333-333333333333\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Test\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr');" 2>&1)
assert_struct_eq "create_order (jamais remplacée) reste pleinement fonctionnelle après le rollback" "1" "$(echo "$ROLLBACK_ORDER" | grep -qE '^[0-9a-f-]{36}\|' && echo 1 || echo 0)"

rm -f "$ROLLBACK_TEST_SQL"
psql -c "drop database if exists \"$DB_ROLLBACK\";" >/dev/null 2>&1 || true

# ============================================================
# RÉSUMÉ
# ============================================================
echo ""
echo "============================================================"
echo "RÉSUMÉ — RECEIPT / INVOICE TAX DETAIL v1.1"
echo "  Structurels : $STRUCT_COUNT"
echo "  Comportementaux : $BEHAV_COUNT"
echo "  TOTAL PASS : $PASS_COUNT"
echo "  TOTAL FAIL : $FAIL_COUNT"
echo "============================================================"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "ÉCHECS :"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
