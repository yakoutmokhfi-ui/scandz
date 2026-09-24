#!/usr/bin/env bash
# ============================================================
# Scanym — TRANSLATIONS MANAGEMENT v2
# Harnais PostgreSQL reproductible pour
# supabase/DRAFT-lot-translations-management-v2.sql (+ -rollback.sql).
#
# Prouve, sur une base RÉELLE (jamais par lecture de source) :
#   [A] structure : colonnes ajoutées, hash GÉNÉRÉ, aucune table,
#       aucun trigger, extensions additives des lectures ;
#   [B] sécurité de write_translation pour les 2 NOUVEAUX types
#       (mandat §5) : anonyme refusé, membre non autorisé refusé,
#       staff refusé, owner/manager acceptés, opérateur accepté,
#       cross-tenant refusé, substitution d'entité refusée, type et
#       champ invalides refusés, langue source refusée, langue
#       inactive refusée ;
#   [C] privilèges : aucun droit PUBLIC/anon nouveau, aucune écriture
#       directe en table, search_path explicite ;
#   [D] comportement : hash toujours relu côté serveur, « stale »
#       jamais stocké, traduction lisible par les lectures marchand
#       et publiques ;
#   [E] rollback : retire tout et restaure les signatures antérieures.
#
# Usage, depuis la racine du dépôt :
#   sudo -u postgres bash supabase/tests/translations-management-v2-check.sh
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$ROOT/supabase"
LOT="$S/DRAFT-lot-translations-management-v2.sql"
ROLLBACK="$S/DRAFT-lot-translations-management-v2-rollback.sql"
DB="scanym_tm2_$$"
TMP="$(mktemp -d /tmp/scanym-tm2-XXXXXX)"

PASS=0
FAIL=0
FAIL_LOG="$TMP/fails.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $*"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

sql()    { psql -X -A -q -t -d "$DB" -c "$1" 2>"$TMP/err.txt"; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >"$TMP/out.txt" 2>"$TMP/err.txt"; echo $?; }
err()    { cat "$TMP/err.txt" 2>/dev/null; }

as_user()    { PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
                 -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
                 -c "$2" 2>"$TMP/err.txt"; }
as_user_rc() { PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
                 -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
                 -c "$2" >"$TMP/out.txt" 2>"$TMP/err.txt"; echo $?; }
as_anon_rc() { PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" \
                 >"$TMP/out.txt" 2>"$TMP/err.txt"; echo $?; }

assert_eq()      { if [ "$2" = "$3" ]; then pass "$1 (=$3)"; else fail "$1 — attendu '$2', obtenu '$3'"; fi }
assert_ok()      { if [ "$2" -eq 0 ]; then pass "$1 (rc=0)"; else fail "$1 — attendu rc=0, obtenu rc=$2 : $(err)"; fi }
assert_denied()  { if [ "$2" -ne 0 ]; then pass "$1 (refusé)"; else fail "$1 — attendu un refus, obtenu rc=0"; fi }
assert_err_has() { if err | grep -qF "$2"; then pass "$1"; else fail "$1 — message attendu '$2', obtenu : $(err)"; fi }

# ------------------------------------------------------------
# Chaîne de migration réelle
# ------------------------------------------------------------
MINIMAL_CHAIN="schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql"
REST_CHAIN="migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql migration-v72-hardening.sql migration-v73-hardening.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql DRAFT-lot-payment-p1-foundation.sql DRAFT-lot-merchant-delivery-pricing.sql DRAFT-lot-orders-service-role-select-hardening.sql DRAFT-lot-catalogue-operator-authorization-v1.sql DRAFT-lot-catalogue-import-commit-idempotency-v1-1.sql DRAFT-lot-catalogue-vat-completeness-guard-v1.sql DRAFT-lot-operator-catalogue-reset-v1.sql DRAFT-lot-catalogue-collections-tags-foundation-v1.sql DRAFT-lot-delivery-delay-customer-notice-v1.sql DRAFT-lot-translations-operator-authorization-v1.sql"

log "=== [SETUP] base $DB + chaîne complète ==="
psql -c "create database \"$DB\";" >/dev/null 2>&1
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
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

for f in $MINIMAL_CHAIN; do
  if ! psql -d "$DB" -v ON_ERROR_STOP=1 -f "$S/$f" >/dev/null 2>"$TMP/chain.txt"; then
    log "FATAL en appliquant $f : $(tail -3 "$TMP/chain.txt")"; exit 1
  fi
  psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in $REST_CHAIN; do
  if ! psql -d "$DB" -v ON_ERROR_STOP=1 -f "$S/$f" >/dev/null 2>"$TMP/chain.txt"; then
    log "FATAL en appliquant $f : $(tail -5 "$TMP/chain.txt")"; exit 1
  fi
done

# ------------------------------------------------------------
# Empreintes AVANT le lot (non-dérive des fonctions préexistantes)
# ------------------------------------------------------------
BEFORE_CREATE_ORDER="$(sql "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order' limit 1;")"
BEFORE_ASSERT_ROLE="$(sql "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='assert_restaurant_asset_role' limit 1;")"
BEFORE_UPD_STATUS="$(sql "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='update_order_status' limit 1;")"
BEFORE_TABLES="$(sql "select count(*) from information_schema.tables where table_schema='public';")"
BEFORE_TRIGGERS="$(sql "select count(*) from information_schema.triggers where trigger_schema='public';")"

log "=== [SETUP] fixture deux établissements ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$TMP/fixture.txt" <<'SQL'
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001','owner-a@test.local'),
  ('aaaaaaaa-0000-0000-0000-000000000002','manager-a@test.local'),
  ('aaaaaaaa-0000-0000-0000-000000000003','staff-a@test.local'),
  ('bbbbbbbb-0000-0000-0000-000000000001','owner-b@test.local'),
  ('cccccccc-0000-0000-0000-000000000001','operateur@test.local'),
  ('dddddddd-0000-0000-0000-000000000001','etranger@test.local');

insert into public.restaurants (id, slug, name, is_active, status) values
  ('11111111-1111-1111-1111-111111111111','tm2-a','Au lait cru', true, 'active'),
  ('22222222-2222-2222-2222-222222222222','tm2-b','Sanaa Cookies', true, 'active');

insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number, source_language)
values
  ('11111111-1111-1111-1111-111111111111','EUR', 1, '+33600000000', 'fr'),
  ('22222222-2222-2222-2222-222222222222','EUR', 1, '+33600000001', 'fr');

insert into public.restaurant_active_languages (restaurant_id, language_code, display_order) values
  ('11111111-1111-1111-1111-111111111111','fr',1),
  ('11111111-1111-1111-1111-111111111111','en',2),
  ('22222222-2222-2222-2222-222222222222','fr',1),
  ('22222222-2222-2222-2222-222222222222','en',2);

insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','owner'),
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','manager'),
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000003','staff'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-0000-0000-0000-000000000001','owner');

insert into public.menu_categories (id, restaurant_id, name, is_active, display_order) values
  ('aa111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','Fromages', true, 1),
  ('bb222222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222222','Gâteaux', true, 1);

insert into public.menu_subcategories (id, category_id, name, display_order) values
  ('aa333333-3333-3333-3333-333333333333','aa111111-1111-1111-1111-111111111111','Chèvres', 1),
  ('bb444444-4444-4444-4444-444444444444','bb222222-2222-2222-2222-222222222222','Fondants', 1);

insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, customer_text, config) values
  ('11111111-1111-1111-1111-111111111111','pickup', true, 'Retrait sous 2 h.', '{}'::jsonb),
  ('22222222-2222-2222-2222-222222222222','pickup', true, 'Retrait sous 24 h.', '{}'::jsonb);
SQL
if [ -s "$TMP/fixture.txt" ] && grep -qi "error" "$TMP/fixture.txt"; then
  log "FATAL fixture : $(cat "$TMP/fixture.txt")"; exit 1
fi

# Opérateur Scanym (mécanisme déjà en place) -- table dédiée.
OPERATOR_TABLE="$(sql "select to_regclass('public.scanym_operators');")"
if [ -n "$OPERATOR_TABLE" ]; then
  psql -d "$DB" -c "insert into public.scanym_operators (user_id) values ('cccccccc-0000-0000-0000-000000000001') on conflict do nothing;" >/dev/null 2>&1
fi

log "=== [LOT] application de TRANSLATIONS MANAGEMENT v2 ==="
if ! psql -d "$DB" -v ON_ERROR_STOP=1 -f "$LOT" >/dev/null 2>"$TMP/lot.txt"; then
  log "FATAL application du lot : $(tail -5 "$TMP/lot.txt")"; exit 1
fi
pass "[A] le lot s'applique en une transaction sur la chaîne réelle"

# ------------------------------------------------------------
# [A] STRUCTURE
# ------------------------------------------------------------
assert_eq "[A] menu_subcategories.translations (jsonb) ajoutée" "jsonb" \
  "$(sql "select data_type from information_schema.columns where table_schema='public' and table_name='menu_subcategories' and column_name='translations';")"
assert_eq "[A] menu_subcategories.name_hash est GÉNÉRÉE" "ALWAYS" \
  "$(sql "select is_generated from information_schema.columns where table_schema='public' and table_name='menu_subcategories' and column_name='name_hash';")"
assert_eq "[A] le hash est bien calculé par la base (md5 du nom source)" "t" \
  "$(sql "select (name_hash = md5(name)) from public.menu_subcategories where id='aa333333-3333-3333-3333-333333333333';")"
assert_eq "[A] restaurant_sale_modes.id ajoutée (identifiant stable, unique)" "1" \
  "$(sql "select count(*) from pg_indexes where schemaname='public' and indexname='idx_restaurant_sale_modes_id';")"
assert_eq "[A] restaurant_sale_modes.customer_text_hash GÉNÉRÉE" "ALWAYS" \
  "$(sql "select is_generated from information_schema.columns where table_schema='public' and table_name='restaurant_sale_modes' and column_name='customer_text_hash';")"
assert_eq "[A] restaurant_sale_mode_fulfillments.translations ajoutée" "jsonb" \
  "$(sql "select data_type from information_schema.columns where table_schema='public' and table_name='restaurant_sale_mode_fulfillments' and column_name='translations';")"
assert_eq "[A] la clé primaire de restaurant_sale_modes est INCHANGÉE" "restaurant_id,mode_code" \
  "$(sql "select string_agg(a.attname, ',' order by k.ord) from pg_constraint c join lateral unnest(c.conkey) with ordinality k(attnum, ord) on true join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum where c.conrelid='public.restaurant_sale_modes'::regclass and c.contype='p';")"
assert_eq "[A] AUCUNE table ajoutée par ce lot" "$BEFORE_TABLES" \
  "$(sql "select count(*) from information_schema.tables where table_schema='public';")"
assert_eq "[A] AUCUN trigger ajouté par ce lot" "$BEFORE_TRIGGERS" \
  "$(sql "select count(*) from information_schema.triggers where trigger_schema='public';")"
assert_eq "[A] get_merchant_catalogue expose subcategory_name_hash + subcategory_translations" "t" \
  "$(sql "select (pg_get_functiondef(p.oid) ilike '%subcategory_name_hash%' and pg_get_functiondef(p.oid) ilike '%subcategory_translations%') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_catalogue';")"
assert_eq "[A] get_merchant_catalogue CONSERVE le bypass opérateur (OB-2 v1.1)" "t" \
  "$(sql "select (pg_get_functiondef(p.oid) ilike '%is_scanym_operator%') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_catalogue';")"

# Non-dérive des fonctions critiques préexistantes.
assert_eq "[A] create_order NON MODIFIÉE par ce lot" "$BEFORE_CREATE_ORDER" \
  "$(sql "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order' limit 1;")"
assert_eq "[A] assert_restaurant_asset_role NON MODIFIÉE" "$BEFORE_ASSERT_ROLE" \
  "$(sql "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='assert_restaurant_asset_role' limit 1;")"
assert_eq "[A] update_order_status NON MODIFIÉE" "$BEFORE_UPD_STATUS" \
  "$(sql "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='update_order_status' limit 1;")"

# ------------------------------------------------------------
# [C] PRIVILÈGES
# ------------------------------------------------------------
assert_eq "[C] write_translation NON exécutable par public" "f" \
  "$(sql "select has_function_privilege('public','public.write_translation(uuid, text, uuid, text, text, text, text, text)','execute');")"
assert_eq "[C] write_translation NON exécutable par anon" "f" \
  "$(sql "select has_function_privilege('anon','public.write_translation(uuid, text, uuid, text, text, text, text, text)','execute');")"
assert_eq "[C] write_translation exécutable par authenticated" "t" \
  "$(sql "select has_function_privilege('authenticated','public.write_translation(uuid, text, uuid, text, text, text, text, text)','execute');")"
assert_eq "[C] aucune écriture directe anon/authenticated sur les 3 tables du lot" "0" \
  "$(sql "select count(*) from information_schema.role_table_grants where table_schema='public' and table_name in ('menu_subcategories','restaurant_sale_modes','restaurant_sale_mode_fulfillments') and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE');")"
assert_eq "[C] les 6 fonctions du lot fixent search_path" "6" \
  "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('write_translation','get_merchant_catalogue','get_merchant_delivery_method_notices','get_merchant_delivery_fulfillment_pricing','get_restaurant_public_sale_modes','get_restaurant_public_delivery_fulfillments') and p.proconfig::text like '%search_path=%';")"

# ------------------------------------------------------------
# [B] SÉCURITÉ DE write_translation -- NOUVEAUX TYPES
# ------------------------------------------------------------
W_SUB="select public.write_translation('11111111-1111-1111-1111-111111111111','subcategory','aa333333-3333-3333-3333-333333333333','name','en','Goat cheeses','validated');"

assert_denied "[B] appelant ANONYME (rôle anon) refusé" "$(as_anon_rc "$W_SUB")"
assert_denied "[B] authentifié SANS rattachement refusé" "$(as_user_rc 'dddddddd-0000-0000-0000-000000000001' "$W_SUB")"
assert_denied "[B] rôle STAFF refusé (comportement inchangé)" "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000003' "$W_SUB")"
assert_ok "[B] OWNER accepté" "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "$W_SUB")"
assert_ok "[B] MANAGER accepté" "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000002' "$W_SUB")"
if [ -n "$OPERATOR_TABLE" ]; then
  assert_ok "[B] OPÉRATEUR Scanym accepté (comportement inchangé)" \
    "$(as_user_rc 'cccccccc-0000-0000-0000-000000000001' "$W_SUB")"
fi

# Cross-tenant : la sous-catégorie de B écrite sous le tenant A.
assert_denied "[B] sous-catégorie d'un AUTRE établissement refusée (substitution)" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','subcategory','bb444444-4444-4444-4444-444444444444','name','en','Hack','validated');")"
assert_err_has "[B] ... avec un message d'entité introuvable (jamais une fuite)" "Subcategory not found for this restaurant"
assert_denied "[B] owner de A écrivant SUR le tenant B refusé" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('22222222-2222-2222-2222-222222222222','subcategory','bb444444-4444-4444-4444-444444444444','name','en','Hack','validated');")"

assert_denied "[B] type d'entité invalide refusé" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','menu','aa333333-3333-3333-3333-333333333333','name','en','X','validated');")"
assert_denied "[B] champ invalide pour une sous-catégorie refusé" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','subcategory','aa333333-3333-3333-3333-333333333333','description','en','X','validated');")"
assert_err_has "[B] ... message explicite" "Invalid field for entity type subcategory"
assert_denied "[B] écriture dans la LANGUE SOURCE refusée" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','subcategory','aa333333-3333-3333-3333-333333333333','name','fr','Chèvres','validated');")"
assert_denied "[B] langue NON ACTIVE refusée" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','subcategory','aa333333-3333-3333-3333-333333333333','name','ar','أجبان','validated');")"
assert_denied "[B] statut arbitraire refusé ('stale' n'est jamais écrit)" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','subcategory','aa333333-3333-3333-3333-333333333333','name','en','X','stale');")"

# Textes client : les 2 sources, avec vérification de tenant.
SM_A="$(sql "select id from public.restaurant_sale_modes where restaurant_id='11111111-1111-1111-1111-111111111111' and mode_code='pickup';")"
SM_B="$(sql "select id from public.restaurant_sale_modes where restaurant_id='22222222-2222-2222-2222-222222222222' and mode_code='pickup';")"
assert_ok "[B] message client d'un mode de vente : owner accepté" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','customer_notice','$SM_A','customer_text','en','Pickup within 2 hours.','validated');")"
assert_denied "[B] message client d'un AUTRE établissement refusé" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','customer_notice','$SM_B','customer_text','en','Hack','validated');")"
assert_err_has "[B] ... message d'entité introuvable" "Customer notice not found for this restaurant"
assert_denied "[B] champ invalide pour un message client refusé" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','customer_notice','$SM_A','name','en','X','validated');")"

# Types PRÉEXISTANTS : comportement inchangé.
assert_ok "[B] type 'restaurant' (préexistant) toujours accepté" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','restaurant','11111111-1111-1111-1111-111111111111','intro_text','en','Artisan cheese shop','to_review');")"
assert_denied "[B] champ invalide pour 'restaurant' toujours refusé" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','restaurant','11111111-1111-1111-1111-111111111111','name','en','X','to_review');")"

# ------------------------------------------------------------
# [D] COMPORTEMENT
# ------------------------------------------------------------
assert_eq "[D] la traduction de sous-catégorie est stockée dans le MÊME modèle JSONB" "Goat cheeses" \
  "$(sql "select translations->'en'->>'name' from public.menu_subcategories where id='aa333333-3333-3333-3333-333333333333';")"
assert_eq "[D] le hash écrit est celui RELU EN BASE, jamais fourni par l'appelant" "t" \
  "$(sql "select (translations->'en'->>'name_source_hash') = name_hash from public.menu_subcategories where id='aa333333-3333-3333-3333-333333333333';")"
assert_eq "[D] le statut stocké est 'validated' (jamais 'stale')" "validated" \
  "$(sql "select translations->'en'->>'name_status' from public.menu_subcategories where id='aa333333-3333-3333-3333-333333333333';")"

# Renommage de la source -> le hash change, la traduction devient
# PÉRIMÉE par comparaison (dérivée), sans qu'aucune écriture n'ait lieu.
sql "update public.menu_subcategories set name='Chèvres frais' where id='aa333333-3333-3333-3333-333333333333';" >/dev/null
assert_eq "[D] après renommage : hash courant != hash stocké (stale DÉRIVÉ)" "f" \
  "$(sql "select (translations->'en'->>'name_source_hash') = name_hash from public.menu_subcategories where id='aa333333-3333-3333-3333-333333333333';")"
assert_eq "[D] ... et le statut STOCKÉ n'a pas été modifié" "validated" \
  "$(sql "select translations->'en'->>'name_status' from public.menu_subcategories where id='aa333333-3333-3333-3333-333333333333';")"

assert_eq "[D] get_merchant_catalogue renvoie le hash et les traductions de la sous-catégorie" "t" \
  "$(as_user 'aaaaaaaa-0000-0000-0000-000000000001' "select bool_or(subcategory_translations->'en'->>'name' = 'Goat cheeses') from public.get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false);")"
assert_eq "[D] la lecture marchand des messages client expose id, hash et traductions" "t" \
  "$(as_user 'aaaaaaaa-0000-0000-0000-000000000001' "select bool_or(sale_mode_id is not null and customer_text_hash is not null and translations->'en'->>'customer_text' = 'Pickup within 2 hours.') from public.get_merchant_delivery_method_notices('11111111-1111-1111-1111-111111111111');")"
assert_eq "[D] la lecture PUBLIQUE expose le texte client traduit (anon)" "t" \
  "$(PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "select bool_or(translations->'en'->>'customer_text' = 'Pickup within 2 hours.') from public.get_restaurant_public_sale_modes('11111111-1111-1111-1111-111111111111');" 2>"$TMP/err.txt")"
assert_eq "[D] la lecture publique n'expose NI provider NI config" "f" \
  "$(sql "select (pg_get_functiondef(p.oid) ilike '%rsm.provider%' or pg_get_functiondef(p.oid) ilike '%rsm.config%') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_restaurant_public_sale_modes';")"
assert_eq "[D] un commerçant ne lit JAMAIS le catalogue d'un autre (inchangé)" "1" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select * from public.get_merchant_catalogue('22222222-2222-2222-2222-222222222222', false);")"

# ------------------------------------------------------------
# [F] v2.1 -- COMPARE-AND-WRITE SUR LE HASH SOURCE ATTENDU
#
# Scénario imposé (mandat §8), joué sur une base RÉELLE, pour un type
# PRÉEXISTANT (item) ET pour les DEUX nouveaux (subcategory,
# customer_notice) :
#   1. entité de source connue -> hash A ;
#   2. on note A ;
#   3. le texte source change -> hash courant B ;
#   4. write_translation avec hash attendu A ;
#   5. l'appel ÉCHOUE ;
#   6. la colonne translations est INCHANGÉE ;
#   7. aucune traduction validée portant B n'a été créée ;
#   8. rappel avec hash attendu B -> succès ;
#   9. le hash STOCKÉ est celui relu par le serveur (B).
# ------------------------------------------------------------
log "=== [F] précondition de hash source (v2.1) ==="

assert_eq "[F] write_translation n'existe qu'en UNE version (aucune surcharge 7 arguments)" "1" \
  "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='write_translation';")"
assert_eq "[F] ... et elle porte 8 arguments dont le dernier a une valeur par défaut" "8|1" \
  "$(sql "select p.pronargs || '|' || p.pronargdefaults from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='write_translation';")"

# --- Produit (type PRÉEXISTANT) -----------------------------------
# `menu_items_availability_requires_tax_rate_chk` (lot VAT) : un
# produit DISPONIBLE doit porter un taux de TVA -- la fixture le
# respecte plutôt que de contourner la contrainte.
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into public.menu_items (id, category_id, name, price, is_available, display_order, tax_rate) values ('cc111111-1111-1111-1111-111111111111','aa111111-1111-1111-1111-111111111111','Tomme de brebis', 12, true, 1, 5.5);" >/dev/null 2>"$TMP/item.txt" || { log "FATAL fixture item : $(cat "$TMP/item.txt")"; exit 1; }
ITEM_HASH_A="$(sql "select name_hash from public.menu_items where id='cc111111-1111-1111-1111-111111111111';")"
assert_ok "[F] item : écriture SANS précondition (compatibilité v2, édition interactive)" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','item','cc111111-1111-1111-1111-111111111111','name','en','Sheep tomme','validated');")"
ITEM_BEFORE="$(sql "select translations::text from public.menu_items where id='cc111111-1111-1111-1111-111111111111';")"

# Le texte source change : le hash GÉNÉRÉ devient B.
sql "update public.menu_items set name='Tomme de brebis affinée' where id='cc111111-1111-1111-1111-111111111111';" >/dev/null
ITEM_HASH_B="$(sql "select name_hash from public.menu_items where id='cc111111-1111-1111-1111-111111111111';")"
if [ "$ITEM_HASH_A" != "$ITEM_HASH_B" ]; then pass "[F] item : le hash source a bien changé (A != B)"; else fail "[F] item : le hash source n'a pas changé"; fi

assert_denied "[F] item : écriture avec le hash ATTENDU PÉRIMÉ (A) REFUSÉE" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','item','cc111111-1111-1111-1111-111111111111','name','en','Aged sheep tomme','validated','$ITEM_HASH_A');")"
assert_err_has "[F] item : refus EXPLICITE et déterministe" "SCANYM_TRANSLATION_SOURCE_CHANGED"
assert_eq "[F] item : la colonne translations est restée INCHANGÉE" "$ITEM_BEFORE" \
  "$(sql "select translations::text from public.menu_items where id='cc111111-1111-1111-1111-111111111111';")"
assert_eq "[F] item : AUCUNE traduction validée ne porte le nouveau hash B" "f" \
  "$(sql "select coalesce((translations->'en'->>'name_source_hash') = name_hash, false) from public.menu_items where id='cc111111-1111-1111-1111-111111111111';")"

assert_ok "[F] item : écriture avec le hash ATTENDU COURANT (B) acceptée" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','item','cc111111-1111-1111-1111-111111111111','name','en','Aged sheep tomme','validated','$ITEM_HASH_B');")"
assert_eq "[F] item : le hash STOCKÉ est celui relu par le serveur" "t" \
  "$(sql "select (translations->'en'->>'name_source_hash') = name_hash from public.menu_items where id='cc111111-1111-1111-1111-111111111111';")"
assert_eq "[F] item : la traduction attendue est bien enregistrée" "Aged sheep tomme" \
  "$(sql "select translations->'en'->>'name' from public.menu_items where id='cc111111-1111-1111-1111-111111111111';")"

# --- Sous-catégorie (NOUVEAU type) --------------------------------
SUB_BEFORE="$(sql "select translations::text from public.menu_subcategories where id='aa333333-3333-3333-3333-333333333333';")"
SUB_HASH_STALE="$(sql "select translations->'en'->>'name_source_hash' from public.menu_subcategories where id='aa333333-3333-3333-3333-333333333333';")"
SUB_HASH_NOW="$(sql "select name_hash from public.menu_subcategories where id='aa333333-3333-3333-3333-333333333333';")"
if [ "$SUB_HASH_STALE" != "$SUB_HASH_NOW" ]; then pass "[F] sous-catégorie : source déjà renommée plus haut (hash attendu périmé disponible)"; else fail "[F] sous-catégorie : hash attendu non périmé, scénario invalide"; fi
assert_denied "[F] sous-catégorie : écriture avec hash attendu PÉRIMÉ REFUSÉE" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','subcategory','aa333333-3333-3333-3333-333333333333','name','en','Fresh goat cheeses','validated','$SUB_HASH_STALE');")"
assert_err_has "[F] sous-catégorie : refus explicite" "SCANYM_TRANSLATION_SOURCE_CHANGED"
assert_eq "[F] sous-catégorie : translations INCHANGÉE" "$SUB_BEFORE" \
  "$(sql "select translations::text from public.menu_subcategories where id='aa333333-3333-3333-3333-333333333333';")"
assert_ok "[F] sous-catégorie : écriture avec hash attendu COURANT acceptée" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','subcategory','aa333333-3333-3333-3333-333333333333','name','en','Fresh goat cheeses','validated','$SUB_HASH_NOW');")"
assert_eq "[F] sous-catégorie : hash stocké = hash serveur courant" "t" \
  "$(sql "select (translations->'en'->>'name_source_hash') = name_hash from public.menu_subcategories where id='aa333333-3333-3333-3333-333333333333';")"

# --- Message client (NOUVEAU type) --------------------------------
NOTICE_BEFORE="$(sql "select translations::text from public.restaurant_sale_modes where id='$SM_A';")"
NOTICE_HASH_A="$(sql "select customer_text_hash from public.restaurant_sale_modes where id='$SM_A';")"
sql "update public.restaurant_sale_modes set customer_text='Retrait sous 4 h.' where id='$SM_A';" >/dev/null
assert_denied "[F] message client : écriture avec hash attendu PÉRIMÉ REFUSÉE" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','customer_notice','$SM_A','customer_text','en','Pickup within 4 hours.','validated','$NOTICE_HASH_A');")"
assert_eq "[F] message client : translations INCHANGÉE" "$NOTICE_BEFORE" \
  "$(sql "select translations::text from public.restaurant_sale_modes where id='$SM_A';")"
NOTICE_HASH_B="$(sql "select customer_text_hash from public.restaurant_sale_modes where id='$SM_A';")"
assert_ok "[F] message client : écriture avec hash attendu COURANT acceptée" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','customer_notice','$SM_A','customer_text','en','Pickup within 4 hours.','validated','$NOTICE_HASH_B');")"
assert_eq "[F] message client : hash stocké = hash serveur courant" "t" \
  "$(sql "select (translations->'en'->>'customer_text_source_hash') = customer_text_hash from public.restaurant_sale_modes where id='$SM_A';")"

# --- La précondition n'affaiblit AUCUNE garde existante ------------
assert_denied "[F] la précondition ne contourne pas l'autorisation (staff refusé même avec bon hash)" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000003' "select public.write_translation('11111111-1111-1111-1111-111111111111','item','cc111111-1111-1111-1111-111111111111','name','en','X','validated','$ITEM_HASH_B');")"
assert_denied "[F] ... ni l'isolation locataire" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','subcategory','bb444444-4444-4444-4444-444444444444','name','en','X','validated','$SUB_HASH_NOW');")"
assert_denied "[F] ... ni l'interdiction d'écrire en langue source" \
  "$(as_user_rc 'aaaaaaaa-0000-0000-0000-000000000001' "select public.write_translation('11111111-1111-1111-1111-111111111111','item','cc111111-1111-1111-1111-111111111111','name','fr','X','validated','$ITEM_HASH_B');")"
assert_eq "[F] aucun droit anon/public sur la NOUVELLE signature" "false|false" \
  "$(sql "select has_function_privilege('public','public.write_translation(uuid, text, uuid, text, text, text, text, text)','execute')::text || '|' || has_function_privilege('anon','public.write_translation(uuid, text, uuid, text, text, text, text, text)','execute')::text;")"

# ------------------------------------------------------------
# [E] ROLLBACK
# ------------------------------------------------------------
log "=== [E] rollback ==="
if psql -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK" >/dev/null 2>"$TMP/rb.txt"; then
  pass "[E] le rollback s'applique en une transaction"
else
  fail "[E] rollback en échec : $(tail -5 "$TMP/rb.txt")"
fi
assert_eq "[E] colonnes du lot retirées" "0" \
  "$(sql "select count(*) from information_schema.columns where table_schema='public' and ((table_name='menu_subcategories' and column_name in ('translations','name_hash')) or (table_name='restaurant_sale_modes' and column_name in ('translations','customer_text_hash','id')) or (table_name='restaurant_sale_mode_fulfillments' and column_name in ('translations','customer_text_hash')));")"
assert_eq "[E] write_translation ne porte plus la précondition v2.1" "f" \
  "$(sql "select (pg_get_functiondef(p.oid) ilike '%p_expected_source_hash%') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='write_translation';")"
assert_eq "[E] une seule version de write_translation subsiste (7 arguments)" "1|7" \
  "$(sql "select count(*)::text || '|' || max(p.pronargs)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='write_translation';")"
assert_eq "[E] write_translation revient à ses 3 types d'origine" "f" \
  "$(sql "select (pg_get_functiondef(p.oid) ilike '%subcategory%') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='write_translation';")"
assert_eq "[E] get_merchant_catalogue revient à 31 colonnes" "31" \
  "$(sql "select array_length(p.proallargtypes,1) - 2 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_catalogue';")"
assert_denied "[E] un rollback répété échoue proprement (fail-closed)" \
  "$(psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK" >/dev/null 2>&1; echo $?)"

log "=== [E] réapplication après rollback ==="
if psql -d "$DB" -v ON_ERROR_STOP=1 -f "$LOT" >/dev/null 2>"$TMP/lot2.txt"; then
  pass "[E] le lot se réapplique après rollback (aller-retour complet)"
else
  fail "[E] réapplication en échec : $(tail -5 "$TMP/lot2.txt")"
fi
assert_denied "[E] une application répétée échoue proprement (déjà appliqué)" \
  "$(psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$LOT" >/dev/null 2>&1; echo $?)"

# ------------------------------------------------------------
echo
log "================= RÉSULTAT ================="
log "PASS: $PASS   FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  log "--- échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
