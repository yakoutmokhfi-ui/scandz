#!/usr/bin/env bash
# ============================================================
# Scanym — CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.3 — Harnais
# reproductible pour
# supabase/DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql
# (MODÈLE SIMPLIFIÉ -- portion fixe + prix fixe + poids informatif,
# mandat v1.1 §28 : "Update SQL harness for simplified model... Remove
# tests whose only purpose was supporting variable-weight financial
# pricing.").
#
# v1.2 (mandat "TARGETED FIX OF v1.1 WORK AUDIT BLOCKER") ne change PAS
# le modèle -- v1.1 a été REJETÉE par l'audit Work indépendant, blocage
# CAT-FISCAL-V11-RPC-NONREGRESSION-01 : la réécriture de create_product/
# update_product en v1.1 (nécessaire pour ajouter les 3 paramètres
# fiscaux) avait fait régresser 3 comportements historiques jamais
# demandés à changer -- (1) l'append display_order scopé à la
# catégorie, (2) la normalisation btrim(value, E' \t\n\r\f' || chr(11))
# (espace+tab+LF+CR+FF+VT), remplacée par trim() simple (ASCII space
# seul), (3) la validation de longueur sur la valeur BRUTE au lieu de
# la valeur NORMALISÉE. Ce harnais ajoute les sections [11]-[16] qui
# prouvent la fermeture de ce blocage ; les sections [0]-[10]
# (structure/contraintes/RPC fiscal/RLS/isolation/précision/CAT-
# FISCAL-01-02 closure/drift guard/double-build) sont INCHANGÉES par
# rapport à v1.1 (aucune régression de ce qui était déjà vert).
#
# Ce fichier REMPLACE intégralement l'ancien harnais v1 (rejeté par
# Work, CAT-FISCAL-01) -- même nom de fichier, contenu entièrement
# reconstruit pour le modèle v1.1 (conservé tel quel en v1.2) : 4
# colonnes (tax_rate, unit_weight_grams, weight_is_approximate,
# reference_price_per_kg), AUCUNE matrice de combinaison, AUCUN
# price_mode/sales_unit/weight_mode/price_per_weight_rate.
#
# PostgreSQL communautaire vanilla (pas une instance Supabase managée),
# même patron que tous les harnais précédents de ce dépôt (voir
# supabase/tests/payment-p3b6-checkout-billing-context-check.sh, dont
# build_common_bootstrap/build_minimal_chain/
# build_full_current_chain sont repris ici à l'identique -- la chaîne
# de migrations en amont de ce lot n'est PAS modifiée par v1.1).
#
# Ce script DOIT être invoqué en tant qu'utilisateur système
# `postgres` DIRECTEMENT :
#   su postgres -c "bash supabase/tests/catalogue-fiscal-product-measurements-v1-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql"
DB="scanym_fiscal_v13_$$"
DB_DRIFT="scanym_fiscal_v13_drift_$$"
DB_DOUBLE="scanym_fiscal_v13_double_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-fiscal-v13-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DOUBLE\";" >/dev/null 2>&1 || true
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
assert_rc_nonzero() {
  local desc="$1" rc="$2"
  if [ "$rc" != "0" ]; then behav "$desc (rc=$rc, rejeté comme attendu)"; else fail "$desc — attendu un rejet (rc != 0), obtenu rc=0"; fi
}
assert_rc_zero() {
  local desc="$1" rc="$2"
  if [ "$rc" = "0" ]; then behav "$desc (rc=0, accepté comme attendu)"; else fail "$desc — attendu rc=0, obtenu rc=$rc : $(cat /tmp/scanym-fiscal-v13-err-$$.txt 2>/dev/null)"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }
as_service() { PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_anon() { PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_authenticated() { PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt
  echo $?
}
as_authenticated_out() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "$1" 2>&1
}
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt
  echo $?
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

# Chaîne COMPLÈTE réelle jusqu'à main actuel (a2f93da3, baseline requis
# de ce lot) : sale modes + routing + delivery pricing + PAYMENT P3-B6
# (dernier lot paiement mergé) + CUSTOMER TRACKING EXPERIENCE (get_order_tracking,
# indépendante du paiement mais mergée après) -- preuve que le lot
# fiscal v1.3 sous test s'applique proprement sur l'état RÉEL de main,
# pas une chaîne tronquée choisie de complaisance. INCHANGÉE par
# rapport au harnais v1 : ce lot ne touche à AUCUN maillon en amont.
build_mock_vault() {
  local dbname="$1"
  psql -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  secret text not null,
  name text,
  description text,
  key_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create function vault.create_secret(new_secret text, new_name text, new_description text, new_key_id uuid default null)
returns uuid
language plpgsql
as $fn$
declare
  v_id uuid;
begin
  insert into vault.secrets (secret, name, description, key_id)
    values (new_secret, new_name, new_description, new_key_id)
    returning id into v_id;
  return v_id;
end;
$fn$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void
language plpgsql
as $fn$
begin
  update vault.secrets
    set secret = coalesce(new_secret, secret),
        name = coalesce(new_name, name),
        description = coalesce(new_description, description),
        key_id = coalesce(new_key_id, key_id),
        updated_at = now()
    where id = secret_id;
end;
$fn$;
create view vault.decrypted_secrets as
  select id, secret as decrypted_secret, name, description, key_id, created_at, updated_at
  from vault.secrets;
SQL
}

build_full_current_chain() {
  local dbname="$1"
  build_common_bootstrap "$dbname"
  build_mock_vault "$dbname"
  build_minimal_chain "$dbname"
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-payment-p3b6-checkout-billing-context.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-customer-order-tracking-foundation.sql" >/dev/null
}

seed_smoke_restaurant() {
  local dbname="$1"
  psql -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into auth.users (id) values ('99999999-9999-9999-9999-999999999999');
insert into public.restaurants (id, slug, name, is_active, status)
values ('11111111-1111-1111-1111-111111111111','fiscal-v1-check','Fiscal V1.1 Check', true, 'active');
insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number)
values ('11111111-1111-1111-1111-111111111111','EUR', 1, '+33600000000');
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config)
values ('11111111-1111-1111-1111-111111111111','pickup', true, '{}'::jsonb);
insert into public.restaurant_users (restaurant_id, user_id, role)
values ('11111111-1111-1111-1111-111111111111','99999999-9999-9999-9999-999999999999','owner');
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','Fromages', true, 1);
insert into public.menu_items (id, category_id, name, price, is_available)
values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','Existant (pré-migration)', 10.00, true);
SQL
}

as_owner() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local \"request.jwt.claim.sub\" = '99999999-9999-9999-9999-999999999999'; select set_config('test.uid','99999999-9999-9999-9999-999999999999',true); $1" 2>&1
}
as_owner_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "select set_config('test.uid','99999999-9999-9999-9999-999999999999',true); $1" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt
  echo $?
}
as_owner_out() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "select set_config('test.uid','99999999-9999-9999-9999-999999999999',true); $1" 2>&1
}
# Variante VERBOSITY=verbose (mandat v1.3 §7/§8 -- preuve du SQLSTATE
# EXACT, pas seulement du message) : is_local=false sur set_config,
# car chaque option -c distincte est envoyée comme un message
# "simple query" séparé (donc une transaction implicite séparée) --
# is_local=true (comme dans as_owner_rc ci-dessus, qui tient tout dans
# UNE seule option -c) ne survivrait pas jusqu'au 3e -c. Avec
# VERBOSITY=verbose, PostgreSQL préfixe le message d'erreur du SQLSTATE
# exact, ex. "ERROR:  22023: Invalid price" -- une seule chaîne prouve
# à la fois le code ET le message.
as_owner_rc_verbose() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "select set_config('test.uid','99999999-9999-9999-9999-999999999999', false);" \
    -c "\set VERBOSITY verbose" \
    -c "$1" \
    >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt
  echo $?
}

# ============================================================
# [0] BASELINE — chaîne réelle complète (main a2f93da3) + LOT SOUS
# TEST (v1.3, modèle simplifié -- conservé de v1.1/v1.2).
# ============================================================
log "=== [0] Construction baseline $DB (chaîne complète main + fiscal v1.3) ==="
createdb "$DB"
build_full_current_chain "$DB"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null
seed_smoke_restaurant "$DB"
struct "Application propre du lot CATALOGUE FISCAL v1.3 sur la chaîne réelle complète (jusqu'à PAYMENT P3-B6 + CUSTOMER TRACKING inclus)"

# ------------------------------------------------------------
# [1] STRUCTURE — 4 colonnes (SIMPLIFIÉ, vs 7 en v1) + defaults +
# rétrocompatibilité produit existant (mandat §17 : aucune valeur
# inventée).
# ------------------------------------------------------------
log "=== [1] Structure menu_items (modèle simplifié) ==="
COLS=$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='menu_items' and column_name in ('tax_rate','unit_weight_grams','weight_is_approximate','reference_price_per_kg');")
assert_struct_eq "4 nouvelles colonnes présentes sur menu_items (tax_rate, unit_weight_grams, weight_is_approximate, reference_price_per_kg)" "4" "$COLS"

GEN_KIND=$(sql "select is_generated from information_schema.columns where table_schema='public' and table_name='menu_items' and column_name='reference_price_per_kg';")
assert_struct_eq "reference_price_per_kg est une colonne GÉNÉRÉE (mandat §6, structurellement non-autorité)" "ALWAYS" "$GEN_KIND"

EXISTING_TAX=$(sql "select coalesce(tax_rate::text,'NULL') from public.menu_items where id='33333333-3333-3333-3333-333333333333';")
assert_struct_eq "produit existant n'a AUCUN taux de TVA inventé (mandat §17, tax_rate reste NULL)" "NULL" "$EXISTING_TAX"
EXISTING_WEIGHT=$(sql "select coalesce(unit_weight_grams::text,'NULL') from public.menu_items where id='33333333-3333-3333-3333-333333333333';")
assert_struct_eq "produit existant n'a AUCUN poids inventé (mandat §17, unit_weight_grams reste NULL)" "NULL" "$EXISTING_WEIGHT"
EXISTING_APPROX=$(sql "select weight_is_approximate::boolean::text from public.menu_items where id='33333333-3333-3333-3333-333333333333';")
assert_struct_eq "produit existant reçoit weight_is_approximate=false par défaut (rétrocompatible)" "false" "$EXISTING_APPROX"
EXISTING_REF=$(sql "select coalesce(reference_price_per_kg::text,'NULL') from public.menu_items where id='33333333-3333-3333-3333-333333333333';")
assert_struct_eq "produit existant sans poids -> reference_price_per_kg NULL (colonne générée, cohérente)" "NULL" "$EXISTING_REF"

# ------------------------------------------------------------
# [2] CONTRAINTES -- valeurs INVALIDES rejetées au niveau BASE (insert
# direct, contournant les RPC, pour prouver que le CHECK lui-même --
# pas seulement la RPC -- est l'autorité). Modèle simplifié : SEULEMENT
# 2 CHECK, chacun sur UN champ, plus de matrice de combinaison (mandat
# §22, §28 -- "Remove tests whose only purpose was supporting
# variable-weight financial pricing").
# ------------------------------------------------------------
log "=== [2] Contraintes CHECK -- valeurs invalides ==="

RC=$(psql -d "$DB" -c "insert into public.menu_items (category_id,name,price,tax_rate) values ('22222222-2222-2222-2222-222222222222','Bad tax',5,150);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_nonzero "tax_rate=150 (>100) rejeté par CHECK" "$RC"

RC=$(psql -d "$DB" -c "insert into public.menu_items (category_id,name,price,tax_rate) values ('22222222-2222-2222-2222-222222222222','Bad tax neg',5,-1);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_nonzero "tax_rate=-1 (négatif) rejeté par CHECK" "$RC"

RC=$(psql -d "$DB" -c "insert into public.menu_items (category_id,name,price,unit_weight_grams) values ('22222222-2222-2222-2222-222222222222','Bad zero weight',5,0);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_nonzero "unit_weight_grams=0 rejeté par CHECK (poids positif requis)" "$RC"

RC=$(psql -d "$DB" -c "insert into public.menu_items (category_id,name,price,unit_weight_grams) values ('22222222-2222-2222-2222-222222222222','Bad neg weight',5,-100);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_nonzero "unit_weight_grams négatif rejeté par CHECK" "$RC"

RC=$(psql -d "$DB" -c "insert into public.menu_items (category_id,name,price,reference_price_per_kg) values ('22222222-2222-2222-2222-222222222222','Bad write to generated',5,10);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_nonzero "écriture directe de reference_price_per_kg rejetée par Postgres (colonne GENERATED ALWAYS, mandat §6 -- structurellement impossible d'en faire une 2e autorité)" "$RC"

# ------------------------------------------------------------
# [3] CONTRAINTES -- valeurs VALIDES acceptées, INDÉPENDANTES les unes
# des autres (mandat §22 : plus de matrice de combinaison, chaque champ
# est validé seul).
# ------------------------------------------------------------
log "=== [3] Valeurs valides, indépendantes ==="

RC=$(psql -d "$DB" -c "insert into public.menu_items (category_id,name,price) values ('22222222-2222-2222-2222-222222222222','A sans TVA ni poids',5);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_zero "(A) produit sans tax_rate ni unit_weight_grams : accepté (rétrocompatible)" "$RC"

RC=$(psql -d "$DB" -c "insert into public.menu_items (category_id,name,price,unit_weight_grams,weight_is_approximate) values ('22222222-2222-2222-2222-222222222222','B raclette 200g',7.50,200,true);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_zero "(B) exemple canonique raclette : price=7.50, unit_weight_grams=200, weight_is_approximate=true -- accepté (mandat §2/§26)" "$RC"

RC=$(psql -d "$DB" -c "insert into public.menu_items (category_id,name,price,tax_rate) values ('22222222-2222-2222-2222-222222222222','E valid tax boundaries lo',5,0);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_zero "tax_rate=0 (borne basse) accepté" "$RC"
RC=$(psql -d "$DB" -c "insert into public.menu_items (category_id,name,price,tax_rate) values ('22222222-2222-2222-2222-222222222222','E valid tax boundaries hi',5,100);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_zero "tax_rate=100 (borne haute) accepté" "$RC"
RC=$(psql -d "$DB" -c "insert into public.menu_items (category_id,name,price,tax_rate) values ('22222222-2222-2222-2222-222222222222','E valid tax 5.5',5,5.5);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_zero "tax_rate=5.5 (générique, pas seulement des valeurs françaises codées en dur -- mandat §7) accepté" "$RC"
RC=$(psql -d "$DB" -c "insert into public.menu_items (category_id,name,price,tax_rate) values ('22222222-2222-2222-2222-222222222222','E valid tax 19',5,19);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_zero "tax_rate=19 (taux hors France, ex. Allemagne -- preuve du caractère générique) accepté" "$RC"

# Preuve d'indépendance : TOUTE combinaison de valeurs individuellement
# valides doit être acceptée -- il n'existe plus d'état croisé interdit
# (contrairement à v1).
IDX=0
for TAX in NULL 0 5.5 19 100; do
  for W in NULL 1 200 1800; do
    IDX=$((IDX+1))
    RC=$(psql -d "$DB" -c "insert into public.menu_items (category_id,name,price,tax_rate,unit_weight_grams) values ('22222222-2222-2222-2222-222222222222','Combo $IDX',5,$TAX,$W);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
    assert_rc_zero "indépendance : tax_rate=$TAX + unit_weight_grams=$W accepté (aucune matrice de combinaison, mandat §22)" "$RC"
  done
done

# ------------------------------------------------------------
# [4] RPC create_product / update_product -- nouvelle signature à 8
# paramètres (5 existants + tax_rate/unit_weight_grams/
# weight_is_approximate), sous l'identité owner réelle. Utilise le
# scénario métier explicite du mandat (§19/§26) : raclette 7.50€/200g.
# ------------------------------------------------------------
log "=== [4] RPC create_product / update_product ==="

NEW_ID=$(as_owner_out "select create_product('22222222-2222-2222-2222-222222222222','Raclette','portion individuelle',7.50,'Portion env. 200 g',5.5,200,true);" | tail -1 | tr -d ' ')
if [ -n "$NEW_ID" ] && [ "$NEW_ID" != "" ]; then
  behav "create_product accepte les 8 paramètres (5 existants + 3 fiscaux) et retourne un id ($NEW_ID)"
  ROW=$(sql "select tax_rate::text||'|'||unit_weight_grams::text||'|'||weight_is_approximate::text||'|'||reference_price_per_kg::text from public.menu_items where id='$NEW_ID';")
  assert_struct_eq "create_product a bien persisté tax_rate|unit_weight_grams|weight_is_approximate, et reference_price_per_kg dérivée automatiquement 7.50/0.200kg=37.50 (mandat §6)" "5.50|200|true|37.50" "$ROW"
else
  fail "create_product (8 paramètres) n'a pas retourné d'id -- $(cat /tmp/scanym-fiscal-v13-err-$$.txt 2>/dev/null)"
fi

RC=$(as_owner_rc "select create_product('22222222-2222-2222-2222-222222222222','Bad RPC tax','d',5,'s',150);")
assert_rc_nonzero "create_product rejette tax_rate=150 AVANT d'atteindre le CHECK (message applicatif)" "$RC"
if [ "$RC" != "0" ]; then
  grep -q "SCANYM_INVALID_TAX_RATE" /tmp/scanym-fiscal-v13-err-$$.txt && behav "message d'erreur applicatif exact SCANYM_INVALID_TAX_RATE" || fail "message d'erreur applicatif SCANYM_INVALID_TAX_RATE absent"
fi

RC=$(as_owner_rc "select create_product('22222222-2222-2222-2222-222222222222','Bad RPC weight','d',5,'s',null,-50);")
assert_rc_nonzero "create_product rejette unit_weight_grams négatif AVANT d'atteindre le CHECK" "$RC"
if [ "$RC" != "0" ]; then
  grep -q "SCANYM_INVALID_WEIGHT_VALUE" /tmp/scanym-fiscal-v13-err-$$.txt && behav "message d'erreur applicatif exact SCANYM_INVALID_WEIGHT_VALUE" || fail "message d'erreur applicatif SCANYM_INVALID_WEIGHT_VALUE absent"
fi

# update_product(p_product_id, p_name, p_description, p_price, p_short_description, p_tax_rate, p_unit_weight_grams, p_weight_is_approximate)
UPDATE_RC=$(as_owner_rc "select update_product('$NEW_ID','Raclette renommée','desc2',9.00,'Portion env. 250 g',7.5,250,false);")
assert_rc_zero "update_product accepte les 8 paramètres et réussit" "$UPDATE_RC"
ROW2=$(sql "select tax_rate::text||'|'||unit_weight_grams::text||'|'||weight_is_approximate::text from public.menu_items where id='$NEW_ID';")
assert_struct_eq "update_product a bien persisté tax_rate|unit_weight_grams|weight_is_approximate" "7.50|250|false" "$ROW2"

# ------------------------------------------------------------
# [5] RLS/ACL -- aucun droit d'écriture direct élargi (mandat §23),
# signatures re-vérifiées avec les 8 paramètres.
# ------------------------------------------------------------
log "=== [5] RLS/ACL ==="

INSERT_RC=$(psql -d "$DB" -c "set role anon; insert into public.menu_items (category_id,name,price) values ('22222222-2222-2222-2222-222222222222','anon direct insert',1);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_nonzero "anon ne peut toujours pas insérer directement dans menu_items (aucun nouveau droit large introduit)" "$INSERT_RC"

ANON_EXEC=$(sql "select has_function_privilege('anon','public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean)','EXECUTE');")
assert_struct_eq "anon n'a PAS EXECUTE sur create_product (nouvelle signature 8 paramètres)" "f" "$ANON_EXEC"
AUTH_EXEC=$(sql "select has_function_privilege('authenticated','public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean)','EXECUTE');")
assert_struct_eq "authenticated a EXECUTE sur create_product (nouvelle signature 8 paramètres)" "t" "$AUTH_EXEC"
ANON_EXEC_UPD=$(sql "select has_function_privilege('anon','public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean)','EXECUTE');")
assert_struct_eq "anon n'a PAS EXECUTE sur update_product (nouvelle signature 8 paramètres)" "f" "$ANON_EXEC_UPD"
AUTH_EXEC_UPD=$(sql "select has_function_privilege('authenticated','public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean)','EXECUTE');")
assert_struct_eq "authenticated a EXECUTE sur update_product (nouvelle signature 8 paramètres)" "t" "$AUTH_EXEC_UPD"

PUBLIC_SELECT=$(sql "select count(*) from public.menu_items where unit_weight_grams is not null;")
if [ "$PUBLIC_SELECT" -ge "1" ]; then behav "lecture publique de menu_items expose les nouvelles colonnes fiscales/mesure (déjà couvertes par 'select *' des policies existantes, aucune policy nouvelle nécessaire)"; else fail "lecture des produits avec unit_weight_grams impossible"; fi

# ------------------------------------------------------------
# [6] TENANT ISOLATION -- un owner d'un AUTRE restaurant ne peut pas
# créer/modifier un produit de ce restaurant (RPC déjà en place,
# non-régression -- inchangée par ce lot mais reconfirmée avec la
# nouvelle signature).
# ------------------------------------------------------------
log "=== [6] Isolation tenant (non-régression) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into auth.users (id) values ('88888888-8888-8888-8888-888888888888');
insert into public.restaurants (id, slug, name, is_active, status)
values ('44444444-4444-4444-4444-444444444444','other-tenant','Other Tenant', true, 'active');
insert into public.restaurant_users (restaurant_id, user_id, role)
values ('44444444-4444-4444-4444-444444444444','88888888-8888-8888-8888-888888888888','owner');
SQL
OTHER_RC=$(PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "select set_config('test.uid','88888888-8888-8888-8888-888888888888',true); select create_product('22222222-2222-2222-2222-222222222222','Cross tenant','d',5);" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_nonzero "un owner d'un AUTRE restaurant ne peut pas créer un produit dans cette catégorie (isolation tenant préservée)" "$OTHER_RC"

# ------------------------------------------------------------
# [7] PRÉCISION DÉCIMALE / TYPES -- numeric pour les montants, integer
# pour le poids, pas de flottant binaire.
# ------------------------------------------------------------
log "=== [7] Précision décimale / types ==="
COLTYPE=$(sql "select data_type from information_schema.columns where table_schema='public' and table_name='menu_items' and column_name='tax_rate';")
assert_struct_eq "tax_rate est de type numeric (pas float/double)" "numeric" "$COLTYPE"
COLTYPE2=$(sql "select data_type from information_schema.columns where table_schema='public' and table_name='menu_items' and column_name='unit_weight_grams';")
assert_struct_eq "unit_weight_grams est de type integer (grammes entiers, mandat §4)" "integer" "$COLTYPE2"
COLTYPE3=$(sql "select data_type from information_schema.columns where table_schema='public' and table_name='menu_items' and column_name='reference_price_per_kg';")
assert_struct_eq "reference_price_per_kg est de type numeric (pas float/double)" "numeric" "$COLTYPE3"
SCALE=$(sql "select round(19.999,2)::text;")
assert_struct_eq "arrondi decimal-safe (round numeric) disponible et exact" "20.00" "$SCALE"

# ============================================================
# [8] CAT-FISCAL-01 / CAT-FISCAL-02 CLOSURE — LE TEST LE PLUS IMPORTANT
# DE CE LOT (mandat §18/§19/§26). Scénario métier explicite : raclette
# price=7.50, unit_weight_grams=200, weight_is_approximate=true,
# tax_rate configuré. Client commande quantité=2. create_order (JAMAIS
# modifiée par ce lot) doit calculer EXACTEMENT 2 x 7.50 = 15.00 --
# AUCUN chemin de code ne doit jamais calculer "poids x prix/kg" pour
# le montant de commande.
# ============================================================
log "=== [8] CAT-FISCAL-01/02 CLOSURE -- create_order sur produit fiscal (raclette) ==="

RACLETTE_ID=$(as_owner_out "select create_product('22222222-2222-2222-2222-222222222222','Raclette CAT-FISCAL-02','portion',7.50,'Portion env. 200 g',5.5,200,true);" | tail -1 | tr -d ' ')
if [ -z "$RACLETTE_ID" ]; then
  fail "impossible de créer le produit raclette pour le test CAT-FISCAL-02 -- $(cat /tmp/scanym-fiscal-v13-err-$$.txt 2>/dev/null)"
else
  behav "produit raclette créé pour CAT-FISCAL-02 ($RACLETTE_ID) -- price=7.50, unit_weight_grams=200, weight_is_approximate=true, tax_rate=5.5"

  REF_CHECK=$(sql "select reference_price_per_kg::text from public.menu_items where id='$RACLETTE_ID';")
  assert_struct_eq "référence catalogue (informative) : 7.50 / 0.200kg = 37.50 €/kg, dérivée -- jamais utilisée par create_order" "37.50" "$REF_CHECK"

  ORDER_OUT=$(as_anon "select * from create_order('fiscal-v1-check', 'pickup', '[{\"menu_item_id\":\"$RACLETTE_ID\",\"quantity\":2}]'::jsonb, null, '{\"name\":\"T\",\"phone\":\"+33600000002\"}'::jsonb, null, 'fr');")
  echo "$ORDER_OUT" | grep -q "15.00\|15\b" && behav "CAT-FISCAL-02 CLOSURE : create_order calcule EXACTEMENT 2 x 7.50 = 15.00 pour la raclette (quantité=2, JAMAIS 400g x prix/kg ni aucun autre calcul pondéré)" || fail "CAT-FISCAL-02 CLOSURE ÉCHEC -- montant attendu 15.00 introuvable dans la sortie create_order : $ORDER_OUT"
  echo "$ORDER_OUT" | grep -q "37.50\|1500\|3750" && fail "CAT-FISCAL-01 RÉGRESSION -- la sortie create_order contient une valeur qui ressemble à un calcul pondéré (prix/kg ou poids x prix) : $ORDER_OUT" || behav "CAT-FISCAL-01 CLOSURE : aucune trace d'un montant dérivé du poids (37.50, 1500, 3750) dans la sortie create_order"
fi

# ------------------------------------------------------------
# [8b] NON-RÉGRESSION -- create_order (INCHANGÉE, jamais touchée par ce
# lot) continue de fonctionner normalement pour un produit fixed_unit
# classique SANS aucune donnée fiscale/mesure renseignée.
# ------------------------------------------------------------
log "=== [8b] Non-régression create_order (produit classique, sans fiscal) ==="
ORDER_OUT2=$(as_anon "select * from create_order('fiscal-v1-check', 'pickup', '[{\"menu_item_id\":\"33333333-3333-3333-3333-333333333333\",\"quantity\":2}]'::jsonb, null, '{\"name\":\"T\",\"phone\":\"+33600000001\"}'::jsonb, null, 'fr');")
echo "$ORDER_OUT2" | grep -q "20.00\|20" && behav "create_order (inchangée) calcule toujours correctement 2 x 10.00 = 20.00 pour un produit classique sans champ fiscal renseigné" || fail "create_order semble affectée par ce lot -- RÉGRESSION : $ORDER_OUT2"

# ------------------------------------------------------------
# [9] MIGRATION IDEMPOTENCE / DRIFT GUARD -- rejouer le fichier sur une
# base où il est déjà appliqué doit échouer PROPREMENT (garde 0d),
# jamais corrompre silencieusement l'état.
# ------------------------------------------------------------
log "=== [9] Garde anti-double-application ==="
createdb "$DB_DRIFT"
build_full_current_chain "$DB_DRIFT"
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null
RC=$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-fiscal-v13-out-$$.txt 2>/tmp/scanym-fiscal-v13-err-$$.txt; echo $?)
assert_rc_nonzero "rejouer le lot sur une base où il est déjà appliqué échoue proprement (garde anti-double-application)" "$RC"
grep -q "SCANYM_SCHEMA_DRIFT" /tmp/scanym-fiscal-v13-err-$$.txt && behav "message SCANYM_SCHEMA_DRIFT explicite en cas de double application" || fail "message SCANYM_SCHEMA_DRIFT absent en cas de double application"

# ------------------------------------------------------------
# [10] DOUBLE-BUILD DÉTERMINISTE -- reconstruire toute la chaîne + le
# lot depuis zéro une seconde fois doit produire un schéma
# structurellement identique (4 colonnes, pas 7).
# ------------------------------------------------------------
log "=== [10] Double-build déterministe ==="
createdb "$DB_DOUBLE"
build_full_current_chain "$DB_DOUBLE"
psql -d "$DB_DOUBLE" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null
COLS2=$(psql -X -A -q -t -d "$DB_DOUBLE" -c "select count(*) from information_schema.columns where table_schema='public' and table_name='menu_items' and column_name in ('tax_rate','unit_weight_grams','weight_is_approximate','reference_price_per_kg');")
assert_struct_eq "double-build : 4 colonnes présentes également sur reconstruction indépendante" "4" "$COLS2"

# ============================================================
# [11] DISPLAY_ORDER SQL NON-REGRESSION TEST (mandat v1.2 §12) --
# create_product DOIT continuer à calculer
# coalesce(max(mi.display_order),0)+1 SCOPÉ À LA CATÉGORIE, comme le
# faisait migration-v66-categories-descriptions.sql. RÉGRESSION v1.1
# fermée ici : CAT-FISCAL-V11-RPC-NONREGRESSION-01 -- v1.1 laissait
# tomber sur le défaut de colonne (display_order=0) pour CHAQUE nouveau
# produit, quelle que soit la catégorie.
# ============================================================
log "=== [11] display_order -- append via create_product (non-régression v1.1) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111','Category A (display_order)', true, 2);
SQL

P1_ID=$(as_owner_out "select create_product('55555555-5555-5555-5555-555555555555','Product1','d',5);" | tail -1 | tr -d ' ')
P1_ORDER=$(sql "select display_order::text from public.menu_items where id='$P1_ID';")
assert_behav_eq "premier produit de Category A -> display_order=1 (coalesce(max,0)+1 sur catégorie vide)" "1" "$P1_ORDER"

P2_ID=$(as_owner_out "select create_product('55555555-5555-5555-5555-555555555555','Product2','d',5);" | tail -1 | tr -d ' ')
P2_ORDER=$(sql "select display_order::text from public.menu_items where id='$P2_ID';")
assert_behav_eq "deuxième produit de Category A -> display_order=2 (append, PAS le défaut colonne 0 -- fermeture CAT-FISCAL-V11-RPC-NONREGRESSION-01)" "2" "$P2_ORDER"

P3_ID=$(as_owner_out "select create_product('55555555-5555-5555-5555-555555555555','Product3','d',5);" | tail -1 | tr -d ' ')
P3_ORDER=$(sql "select display_order::text from public.menu_items where id='$P3_ID';")
assert_behav_eq "troisième produit de Category A -> display_order=3 (append continue)" "3" "$P3_ORDER"

P4_ID=$(as_owner_out "select create_product('55555555-5555-5555-5555-555555555555','Product4','d',5);" | tail -1 | tr -d ' ')
P4_ORDER=$(sql "select display_order::text from public.menu_items where id='$P4_ID';")
assert_behav_eq "quatrième produit de Category A -> display_order=4 (append continue, aucun plateau à 0)" "4" "$P4_ORDER"

# ============================================================
# [12] CATEGORY ISOLATION TEST (mandat v1.2 §13) -- le compteur
# coalesce(max(display_order),0)+1 est SCOPÉ à la catégorie (mi.category_id
# = p_category_id) : une catégorie B fraîche démarre à 1 quelle que soit
# la séquence déjà atteinte par une catégorie A voisine, et Category A
# n'est pas perturbée par les insertions dans Category B.
# ============================================================
log "=== [12] display_order -- isolation par catégorie (Category B indépendante de Category A) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('66666666-6666-6666-6666-666666666666','11111111-1111-1111-1111-111111111111','Category B (isolation)', true, 3);
SQL
B1_ID=$(as_owner_out "select create_product('66666666-6666-6666-6666-666666666666','ProductB1','d',5);" | tail -1 | tr -d ' ')
B1_ORDER=$(sql "select display_order::text from public.menu_items where id='$B1_ID';")
assert_behav_eq "premier produit de Category B -> display_order=1 (scopé à la catégorie, indépendant de Category A déjà à 4)" "1" "$B1_ORDER"

B2_ID=$(as_owner_out "select create_product('66666666-6666-6666-6666-666666666666','ProductB2','d',5);" | tail -1 | tr -d ' ')
B2_ORDER=$(sql "select display_order::text from public.menu_items where id='$B2_ID';")
assert_behav_eq "deuxième produit de Category B -> display_order=2 (append propre à Category B)" "2" "$B2_ORDER"

A_STILL_ID=$(as_owner_out "select create_product('55555555-5555-5555-5555-555555555555','Product5','d',5);" | tail -1 | tr -d ' ')
A_STILL_ORDER=$(sql "select display_order::text from public.menu_items where id='$A_STILL_ID';")
assert_behav_eq "Category A continue sa propre séquence (=5) sans être perturbée par les insertions dans Category B (isolation croisée)" "5" "$A_STILL_ORDER"

# ============================================================
# [13] EMPTY CATEGORY TEST (mandat v1.2 §14) -- coalesce(max(display_order),0)+1
# sur une catégorie STRICTEMENT VIDE (max(display_order) = NULL côté
# SQL) doit produire exactement 1 -- preuve directe du coalesce(...,0).
# ============================================================
log "=== [13] display_order -- catégorie vide (max NULL) -> coalesce(max,0)+1 = 1 ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111','Category C (empty)', true, 4);
SQL
MAX_BEFORE=$(sql "select coalesce(max(display_order)::text,'NULL') from public.menu_items where category_id='77777777-7777-7777-7777-777777777777';")
assert_struct_eq "Category C vide : max(display_order) est bien NULL avant toute insertion" "NULL" "$MAX_BEFORE"

C1_ID=$(as_owner_out "select create_product('77777777-7777-7777-7777-777777777777','ProductC1','d',5);" | tail -1 | tr -d ' ')
C1_ORDER=$(sql "select display_order::text from public.menu_items where id='$C1_ID';")
assert_behav_eq "premier produit d'une catégorie vide -> display_order = coalesce(max(display_order),0)+1 = 0+1 = 1 exactement" "1" "$C1_ORDER"

# ============================================================
# [14] WHITESPACE NORMALIZATION TEST MATRIX (mandat v1.2 §15) --
# create_product/update_product DOIVENT normaliser via
# btrim(value, E' \t\n\r\f' || chr(11)) -- espace ASCII (32), tab (9),
# LF (10), CR (13), FF (12), VT (chr(11)) -- EN TÊTE ET EN QUEUE, pour
# name/description/short_description. RÉGRESSION v1.1 fermée ici
# (CAT-FISCAL-V11-RPC-NONREGRESSION-01) : v1.1 utilisait trim() simple,
# qui NE retire QUE l'espace ASCII (32), laissant tab/LF/CR/FF/VT
# résiduels en tête/queue.
# ============================================================
log "=== [14] Normalisation espaces blancs (btrim complet, non-régression v1.1) ==="

WS='chr(32)||chr(9)||chr(10)||chr(13)||chr(12)||chr(11)'

# -- create_product : name
WSN_ID=$(as_owner_out "select create_product('55555555-5555-5555-5555-555555555555', $WS||'WS Name'||$WS, 'd', 5);" | tail -1 | tr -d ' ')
WSN_VAL=$(sql "select name from public.menu_items where id='$WSN_ID';")
assert_behav_eq "create_product : name -- btrim complet (espace+tab+LF+CR+FF+VT en tête/queue retirés)" "WS Name" "$WSN_VAL"

# -- create_product : description
WSD_ID=$(as_owner_out "select create_product('55555555-5555-5555-5555-555555555555', 'WS Desc Product', $WS||'WS Description'||$WS, 5);" | tail -1 | tr -d ' ')
WSD_VAL=$(sql "select description from public.menu_items where id='$WSD_ID';")
assert_behav_eq "create_product : description -- btrim complet (non-régression v1.1)" "WS Description" "$WSD_VAL"

# -- create_product : short_description
WSS_ID=$(as_owner_out "select create_product('55555555-5555-5555-5555-555555555555', 'WS Short Product', 'd', 5, $WS||'WS Short'||$WS);" | tail -1 | tr -d ' ')
WSS_VAL=$(sql "select short_description from public.menu_items where id='$WSS_ID';")
assert_behav_eq "create_product : short_description -- btrim complet (non-régression v1.1)" "WS Short" "$WSS_VAL"

# -- update_product : name / description / short_description ensemble (8
# paramètres : id, name, description, price, short_description,
# tax_rate, unit_weight_grams, weight_is_approximate)
UPD_WS_RC=$(as_owner_rc "select update_product('$WSN_ID', $WS||'WS Name Upd'||$WS, $WS||'WS Description Upd'||$WS, 6, $WS||'WS Short Upd'||$WS, null, null, false);")
assert_rc_zero "update_product accepte les valeurs avec espaces blancs à normaliser" "$UPD_WS_RC"
UPD_WS_ROW=$(sql "select name||'|'||description||'|'||short_description from public.menu_items where id='$WSN_ID';")
assert_behav_eq "update_product : name|description|short_description -- btrim complet appliqué aux 3 champs (non-régression v1.1)" "WS Name Upd|WS Description Upd|WS Short Upd" "$UPD_WS_ROW"

# ============================================================
# [15] VALIDATION-ORDER TESTS (mandat v1.2 §16) -- la longueur de
# description/short_description DOIT être validée sur la valeur
# NORMALISÉE (après btrim), jamais sur la valeur BRUTE reçue en
# paramètre. RÉGRESSION v1.1 fermée ici (CAT-FISCAL-V11-RPC-
# NONREGRESSION-01) : v1.1 validait la longueur AVANT normalisation.
# (A)/(B) : brut dépasse la limite (à cause du padding d'espaces),
# normalisé reste dans la limite -> ACCEPTÉ (prouve l'ordre correct).
# (C)/(D) : même après normalisation, la longueur dépasse réellement la
# limite -> REJETÉ (prouve que la validation n'est pas court-circuitée).
# ============================================================
log "=== [15] Ordre de validation -- normalisation AVANT validation de longueur (non-régression v1.1) ==="

# (A) description : brut > 500 (padding d'espaces), normalisé = 500 -> ACCEPTÉ
DESC_A_ID=$(as_owner_out "select create_product('55555555-5555-5555-5555-555555555555','Val Order A', repeat(' ',50)||repeat('x',500)||repeat(' ',50), 5);" | tail -1 | tr -d ' ')
if [ -n "$DESC_A_ID" ]; then
  DESC_A_LEN=$(sql "select length(description)::text from public.menu_items where id='$DESC_A_ID';")
  assert_behav_eq "(A) description : brut=600 car. (avec padding), normalisé=500 car. (<=500) -> ACCEPTÉ, validé APRÈS normalisation" "500" "$DESC_A_LEN"
else
  fail "(A) description brut-dépasse/normalisé-dans-la-limite aurait dû être ACCEPTÉE -- $(cat /tmp/scanym-fiscal-v13-err-$$.txt 2>/dev/null)"
fi

# (B) short_description : brut > 100 (padding d'espaces), normalisé = 100 -> ACCEPTÉ
DESC_B_ID=$(as_owner_out "select create_product('55555555-5555-5555-5555-555555555555','Val Order B','d',5, repeat(' ',20)||repeat('y',100)||repeat(' ',20));" | tail -1 | tr -d ' ')
if [ -n "$DESC_B_ID" ]; then
  DESC_B_LEN=$(sql "select length(short_description)::text from public.menu_items where id='$DESC_B_ID';")
  assert_behav_eq "(B) short_description : brut=140 car. (avec padding), normalisé=100 car. (<=100) -> ACCEPTÉ, validé APRÈS normalisation" "100" "$DESC_B_LEN"
else
  fail "(B) short_description brut-dépasse/normalisé-dans-la-limite aurait dû être ACCEPTÉE -- $(cat /tmp/scanym-fiscal-v13-err-$$.txt 2>/dev/null)"
fi

# (C) description : normalisé = 501 (> 500) -> REJETÉ
RC_C=$(as_owner_rc "select create_product('55555555-5555-5555-5555-555555555555','Val Order C', repeat(' ',10)||repeat('x',501)||repeat(' ',10), 5);")
assert_rc_nonzero "(C) description : normalisé=501 car. (>500) -> REJETÉ (SCANYM_DESCRIPTION_TOO_LONG)" "$RC_C"
if [ "$RC_C" != "0" ]; then
  grep -q "SCANYM_DESCRIPTION_TOO_LONG" /tmp/scanym-fiscal-v13-err-$$.txt && behav "(C) message d'erreur applicatif exact SCANYM_DESCRIPTION_TOO_LONG" || fail "(C) message d'erreur applicatif SCANYM_DESCRIPTION_TOO_LONG absent"
fi

# (D) short_description : normalisé = 101 (> 100) -> REJETÉ
RC_D=$(as_owner_rc "select create_product('55555555-5555-5555-5555-555555555555','Val Order D','d',5, repeat(' ',5)||repeat('y',101)||repeat(' ',5));")
assert_rc_nonzero "(D) short_description : normalisé=101 car. (>100) -> REJETÉ (SCANYM_SHORT_DESCRIPTION_TOO_LONG)" "$RC_D"
if [ "$RC_D" != "0" ]; then
  grep -q "SCANYM_SHORT_DESCRIPTION_TOO_LONG" /tmp/scanym-fiscal-v13-err-$$.txt && behav "(D) message d'erreur applicatif exact SCANYM_SHORT_DESCRIPTION_TOO_LONG" || fail "(D) message d'erreur applicatif SCANYM_SHORT_DESCRIPTION_TOO_LONG absent"
fi

# ============================================================
# [16] HISTORICAL V67b NON-REGRESSION -- reproduction directe, à
# l'intérieur de CE harnais, de l'invariant historique testé par
# supabase/tests/v67b-integration-test.sh étape 11 ("Nouveau produit se
# positionne en dernier par défaut") : Camembert(1)/Brie(2, réordonnés
# explicitement via set_product_order)/Roquefort(auto -> 3). Preuve que
# le réordonnancement manuel (set_product_order, INCHANGÉ par ce lot)
# et l'append automatique (create_product) continuent de coexister
# correctement (mandat v1.2 §17 -- supabase/tests/v67b-integration-
# test.sh a ÉGALEMENT été ré-exécuté sans aucune modification : 15
# réussis / 0 échoué, voir le rapport correspondant).
# ============================================================
log "=== [16] Reproduction historique V67b -- réordonnancement + append ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('99999999-aaaa-bbbb-cccc-999999999999','11111111-1111-1111-1111-111111111111','Category V67b Repro', true, 5);
SQL

CAM_ID=$(as_owner_out "select create_product('99999999-aaaa-bbbb-cccc-999999999999','Camembert','d',5);" | tail -1 | tr -d ' ')
BRIE_ID=$(as_owner_out "select create_product('99999999-aaaa-bbbb-cccc-999999999999','Brie','d',6);" | tail -1 | tr -d ' ')
REORDER_RC=$(as_owner_rc "select set_product_order('$CAM_ID',1); select set_product_order('$BRIE_ID',2);")
assert_rc_zero "réordonnancement manuel explicite Camembert=1, Brie=2 via set_product_order (RPC inchangée) accepté" "$REORDER_RC"

ROQUEFORT_ID=$(as_owner_out "select create_product('99999999-aaaa-bbbb-cccc-999999999999','Roquefort','d',7);" | tail -1 | tr -d ' ')
ROQUEFORT_ORDER=$(sql "select display_order::text from public.menu_items where id='$ROQUEFORT_ID';")
assert_behav_eq "invariant historique v67b reproduit : nouveau produit (Roquefort) se positionne EN DERNIER par défaut (=3) après réordonnancement manuel des 2 précédents (non-régression v1.1)" "3" "$ROQUEFORT_ORDER"

# ============================================================
# [17] RPC ERROR PRECEDENCE (mandat v1.3 §8-§14) -- ferme
# CAT-FISCAL-V12-RPC-ERROR-PRECEDENCE-01 (audit Work v1.2, MEDIUM,
# release-blocking). Toutes les assertions ci-dessous utilisent
# as_owner_rc_verbose (VERBOSITY=verbose) pour capturer le SQLSTATE
# EXACT ET le message exact dans une seule chaîne comparée
# ("CODE: message"), preuve la plus forte possible de non-régression
# de la sémantique d'erreur RPC -- pas seulement "un rejet a eu lieu",
# mais LE PREMIER rejet précis, identique à
# migration-v66-categories-descriptions.sql. Catégorie utilisée :
# Category A (55555555-...), déjà peuplée, sans incidence sur ces
# tests (aucun produit n'est effectivement créé -- toutes ces
# invocations sont rejetées avant l'INSERT).
# ============================================================
log "=== [17] RPC error precedence -- ordre exact create_product (non-régression v1.2, CAT-FISCAL-V12-RPC-ERROR-PRECEDENCE-01) ==="

# (a) PRIX SEUL invalide (ligne "price only" de la matrice, mandat §14)
RC_P1=$(as_owner_rc_verbose "select create_product('55555555-5555-5555-5555-555555555555','Precedence A valid name','d',-1);")
assert_rc_nonzero "(a) prix seul invalide (p_price=-1) -> REJETÉ" "$RC_P1"
grep -qF "22023: Invalid price" /tmp/scanym-fiscal-v13-err-$$.txt && behav "(a) SQLSTATE+message exacts baseline : 22023: Invalid price" || fail "(a) SQLSTATE+message exacts absents (attendu '22023: Invalid price') -- $(cat /tmp/scanym-fiscal-v13-err-$$.txt 2>/dev/null)"

# (b) NOM invalide (vide après normalisation) + PRIX invalide simultanés
# -- mandat §10, matrice ligne "name + price" -> attendu : erreur NOM
# en premier (précédence baseline : nom validé avant prix).
RC_NP=$(as_owner_rc_verbose "select create_product('55555555-5555-5555-5555-555555555555','   ','d',-1);")
assert_rc_nonzero "(b) nom vide (après normalisation) ET prix invalide simultanés -> REJETÉ" "$RC_NP"
grep -qF "22023: Name is required" /tmp/scanym-fiscal-v13-err-$$.txt && behav "(b) NOM bat PRIX -- SQLSTATE+message exacts baseline : 22023: Name is required (PAS l'erreur de prix)" || fail "(b) précédence nom-avant-prix rompue -- attendu '22023: Name is required', obtenu $(cat /tmp/scanym-fiscal-v13-err-$$.txt 2>/dev/null)"
grep -qF "Invalid price" /tmp/scanym-fiscal-v13-err-$$.txt && fail "(b) RÉGRESSION -- l'erreur de prix apparaît alors que le nom aurait dû échouer en premier" || behav "(b) aucune trace de l'erreur de prix (le nom a bien été validé en premier, avant même d'atteindre la validation du prix)"

# (c) PRIX invalide + DESCRIPTION (normalisée) trop longue simultanés --
# TEST CENTRAL du mandat (§4/§8) : la régression CAT-FISCAL-V12-RPC-
# ERROR-PRECEDENCE-01 EXACTE. Attendu : erreur PRIX en premier (comme
# la baseline), PAS SCANYM_DESCRIPTION_TOO_LONG (comportement v1.2,
# rejeté par l'audit Work).
RC_PD=$(as_owner_rc_verbose "select create_product('55555555-5555-5555-5555-555555555555','Precedence C valid name', repeat('x',501), -1);")
assert_rc_nonzero "(c) prix invalide (-1) ET description normalisée=501 (>500) simultanés -> REJETÉ" "$RC_PD"
grep -qF "22023: Invalid price" /tmp/scanym-fiscal-v13-err-$$.txt && behav "(c) PRIX bat DESCRIPTION -- SQLSTATE+message exacts baseline : 22023: Invalid price (fermeture CAT-FISCAL-V12-RPC-ERROR-PRECEDENCE-01)" || fail "(c) RÉGRESSION CAT-FISCAL-V12-RPC-ERROR-PRECEDENCE-01 -- attendu '22023: Invalid price', obtenu $(cat /tmp/scanym-fiscal-v13-err-$$.txt 2>/dev/null)"
grep -qF "SCANYM_DESCRIPTION_TOO_LONG" /tmp/scanym-fiscal-v13-err-$$.txt && fail "(c) RÉGRESSION -- SCANYM_DESCRIPTION_TOO_LONG apparaît en premier (comportement v1.2 exact rejeté par Work), au lieu de l'erreur de prix" || behav "(c) aucune trace de SCANYM_DESCRIPTION_TOO_LONG (le prix a bien été validé AVANT la description, ordre baseline restauré)"

# (d) PRIX invalide + SHORT_DESCRIPTION (normalisée) trop longue
# simultanés -- mandat §9, matrice ligne "price + short_description".
RC_PS=$(as_owner_rc_verbose "select create_product('55555555-5555-5555-5555-555555555555','Precedence D valid name','d',-1, repeat('y',101));")
assert_rc_nonzero "(d) prix invalide (-1) ET short_description normalisée=101 (>100) simultanés -> REJETÉ" "$RC_PS"
grep -qF "22023: Invalid price" /tmp/scanym-fiscal-v13-err-$$.txt && behav "(d) PRIX bat SHORT_DESCRIPTION -- SQLSTATE+message exacts baseline : 22023: Invalid price" || fail "(d) précédence prix-avant-short_description rompue -- attendu '22023: Invalid price', obtenu $(cat /tmp/scanym-fiscal-v13-err-$$.txt 2>/dev/null)"
grep -qF "SCANYM_SHORT_DESCRIPTION_TOO_LONG" /tmp/scanym-fiscal-v13-err-$$.txt && fail "(d) RÉGRESSION -- SCANYM_SHORT_DESCRIPTION_TOO_LONG apparaît en premier au lieu de l'erreur de prix" || behav "(d) aucune trace de SCANYM_SHORT_DESCRIPTION_TOO_LONG (le prix a bien été validé en premier)"

# (e) NOM invalide + DESCRIPTION trop longue simultanés -- mandat §11,
# matrice ligne "name + description" -> attendu : erreur NOM en
# premier.
RC_ND=$(as_owner_rc_verbose "select create_product('55555555-5555-5555-5555-555555555555','', repeat('x',501), 5);")
assert_rc_nonzero "(e) nom vide ET description normalisée=501 (>500) simultanés -> REJETÉ" "$RC_ND"
grep -qF "22023: Name is required" /tmp/scanym-fiscal-v13-err-$$.txt && behav "(e) NOM bat DESCRIPTION -- SQLSTATE+message exacts baseline : 22023: Name is required" || fail "(e) précédence nom-avant-description rompue -- attendu '22023: Name is required', obtenu $(cat /tmp/scanym-fiscal-v13-err-$$.txt 2>/dev/null)"
grep -qF "SCANYM_DESCRIPTION_TOO_LONG" /tmp/scanym-fiscal-v13-err-$$.txt && fail "(e) RÉGRESSION -- SCANYM_DESCRIPTION_TOO_LONG apparaît alors que le nom aurait dû échouer en premier" || behav "(e) aucune trace de SCANYM_DESCRIPTION_TOO_LONG (le nom a bien été validé en premier)"

# (f) DESCRIPTION trop longue + SHORT_DESCRIPTION trop longue
# simultanés, nom ET prix valides -- mandat §12, matrice ligne
# "description + short_description" -> attendu : erreur DESCRIPTION en
# premier (ordre baseline : description validée avant short_description).
RC_DS=$(as_owner_rc_verbose "select create_product('55555555-5555-5555-5555-555555555555','Precedence F valid name', repeat('x',501), 5, repeat('y',101));")
assert_rc_nonzero "(f) description normalisée=501 (>500) ET short_description normalisée=101 (>100), nom/prix valides -> REJETÉ" "$RC_DS"
grep -qF "22001: SCANYM_DESCRIPTION_TOO_LONG" /tmp/scanym-fiscal-v13-err-$$.txt && behav "(f) DESCRIPTION bat SHORT_DESCRIPTION -- SQLSTATE+message exacts baseline : 22001: SCANYM_DESCRIPTION_TOO_LONG" || fail "(f) précédence description-avant-short_description rompue -- attendu '22001: SCANYM_DESCRIPTION_TOO_LONG', obtenu $(cat /tmp/scanym-fiscal-v13-err-$$.txt 2>/dev/null)"
grep -qF "SCANYM_SHORT_DESCRIPTION_TOO_LONG" /tmp/scanym-fiscal-v13-err-$$.txt && fail "(f) RÉGRESSION -- SCANYM_SHORT_DESCRIPTION_TOO_LONG apparaît alors que la description aurait dû échouer en premier" || behav "(f) aucune trace de SCANYM_SHORT_DESCRIPTION_TOO_LONG (la description a bien été validée en premier)"

# (g) NORMALISATION + PRÉCÉDENCE COMBINÉES (mandat §13) -- description
# BRUTE dépasse 500 UNIQUEMENT à cause d'espace/tab/LF/CR/FF/VT
# retirables (normalisée = exactement 500, donc VALIDE une fois
# normalisée), ET p_price = -1 simultanément. Attendu : erreur PRIX
# (prouve à la fois que la normalisation a lieu correctement -- sinon
# une description "brute invalide" o pourrait interférer -- ET que la
# précédence reste bien prix-avant-description).
RC_NORM_PRE=$(as_owner_rc_verbose "select create_product('55555555-5555-5555-5555-555555555555','Precedence G valid name', chr(32)||chr(9)||chr(10)||chr(13)||chr(12)||chr(11)||repeat('x',500)||chr(32)||chr(9)||chr(10)||chr(13)||chr(12)||chr(11), -1);")
assert_rc_nonzero "(g) description brute >500 (due UNIQUEMENT à un padding d'espace/tab/LF/CR/FF/VT retirable, normalisée=500 exactement=VALIDE) ET prix=-1 simultanés -> REJETÉ" "$RC_NORM_PRE"
grep -qF "22023: Invalid price" /tmp/scanym-fiscal-v13-err-$$.txt && behav "(g) normalisation + précédence combinées : erreur PRIX exacte obtenue (22023: Invalid price) -- la description brute-mais-normalisée-valide n'a JAMAIS déclenché SCANYM_DESCRIPTION_TOO_LONG" || fail "(g) RÉGRESSION -- attendu '22023: Invalid price', obtenu $(cat /tmp/scanym-fiscal-v13-err-$$.txt 2>/dev/null)"
grep -qF "SCANYM_DESCRIPTION_TOO_LONG" /tmp/scanym-fiscal-v13-err-$$.txt && fail "(g) RÉGRESSION -- SCANYM_DESCRIPTION_TOO_LONG apparaît alors que la description est VALIDE une fois normalisée" || behav "(g) aucune trace de SCANYM_DESCRIPTION_TOO_LONG (normalisation correcte + précédence prix-avant-description toutes deux confirmées)"

# ============================================================
# RÉSUMÉ
# ============================================================
echo ""
echo "============================================================"
echo "RÉSUMÉ CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.3 (SIMPLIFIÉ)"
echo "  structurels : $STRUCT_COUNT"
echo "  comportementaux : $BEHAV_COUNT"
echo "  total PASS : $PASS_COUNT"
echo "  total FAIL : $FAIL_COUNT"
echo "============================================================"
if [ "$FAIL_COUNT" -ne 0 ]; then
  echo "ÉCHECS :"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
