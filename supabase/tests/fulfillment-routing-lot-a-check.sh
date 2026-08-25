#!/usr/bin/env bash
# ============================================================
# Scanym — FULFILLMENT ROUTING LOT A / A.1 — Harnais PostgreSQL
# jetable (supabase/DRAFT-lot-fulfillment-routing-model.sql).
#
# LOT A.1 (contre-audit Work, aucun SQL exécuté en Production) —
# corrections/ajouts apportés à ce harnais par rapport à Lot A :
#   FRA-A-01 (HIGH)   : 10 scénarios obligatoires pour zone_prefixes
#                       (array vide/valide accepté ; NULL, vide,
#                       blanc-seul, mélange valide+invalide rejetés).
#   FRA-A-02 (MEDIUM) : service_role reçoit désormais BYPASSRLS
#                       (convention Supabase réelle) et des tests
#                       CRUD RÉELS (pas seulement le bit ACL) prouvant
#                       qu'il peut écrire malgré la RLS SELECT-only.
#   FRA-A-03 (MEDIUM) : matrice ACL complète (4 rôles × 8 privilèges),
#                       AUCUNE assertion via `OR current_user`.
#
# Couvre (mission Lot A §20 + Lot A.1) : Schema, Cardinalité, FK, Zone
# (10 scénarios FRA-A-01), Fallback, Display order, RLS (tenant A /
# tenant B / anon / authenticated non-membre / service_role CRUD réel),
# Privileges (matrice ACL déterministe complète, simulation GRANT ALL
# préalable comme v82a4-privilege-check.sh), Aucune donnée tenant.
#
# Baseline : chaîne réelle complète jusqu'à LOT 2B.1 (même patron que
# supabase/tests/alc-sm-04-check.sh) + application du DRAFT en fin de
# chaîne. AUCUNE exécution contre Supabase Production.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/fulfillment-routing-lot-a-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql"
DB="scanym_fra_check_$$"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
FAIL_LOG="/tmp/scanym-fra-fails-$$.log"
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

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }
sql_as() {
  local role="$1" query="$2"
  PGOPTIONS="-c role=$role" psql -X -A -q -t -d "$DB" -c "$query"
}

# ------------------------------------------------------------------
# Baseline : identique au patron déjà audité (alc-sm-04-check.sh /
# v84-lot2b1-check.sh) — chaîne réelle jusqu'à LOT 2B.1, 3 tenants
# réels seedés et actifs.
# ------------------------------------------------------------------
log "Construction baseline $DB..."
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
-- FRA-A-02 (Lot A.1) : service_role doit pouvoir écrire (contrat
-- SELECT/INSERT/UPDATE/DELETE) malgré la policy RLS SELECT-only de
-- restaurant_sale_mode_fulfillments -- exactement comme sur un vrai
-- projet Supabase, où service_role porte l'attribut BYPASSRLS au
-- niveau plateforme. Les rôles étant globaux au cluster PostgreSQL
-- (pas par base), cet ALTER est exécuté INCONDITIONNELLEMENT (pas
-- seulement dans le "if not exists" ci-dessus) pour garantir l'état
-- correct même si service_role existait déjà sans BYPASSRLS suite à
-- l'exécution d'un autre harnais de ce dépôt dans le même cluster.
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

# ------------------------------------------------------------------
# Empreinte AVANT application du DRAFT (preuve additivité / §22) :
# compte de lignes de toutes les tables existantes + liste des RPC.
# ------------------------------------------------------------------
BEFORE_TABLES=$(sql "select string_agg(tablename || ':' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text, '|' order by tablename) from pg_tables where schemaname='public';")
BEFORE_ROUTINES=$(sql "select string_agg(proname, ',' order by proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';")

log "Application du DRAFT fulfillment routing lot A..."
DRAFT_RC=0
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-fra-draft-apply-$$.log 2>&1 || DRAFT_RC=$?
assert_rc "DRAFT s'applique sans erreur sur baseline propre" 0 "$DRAFT_RC"
if [ "$DRAFT_RC" != "0" ]; then
  cat /tmp/scanym-fra-draft-apply-$$.log
fi
rm -f /tmp/scanym-fra-draft-apply-$$.log

# ------------------------------------------------------------------
# Réexécution : le préflight doit bloquer une double application
# (table déjà existante) plutôt que de silencieusement dupliquer ou
# planter à mi-chemin sans message clair.
# ------------------------------------------------------------------
REAPPLY_RC=0
REAPPLY_OUT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" 2>&1) || REAPPLY_RC=$?
assert_rc "réexécution du DRAFT échoue proprement (préflight anti-double-application)" 1 "$([ "$REAPPLY_RC" != "0" ] && echo 1 || echo 0)"
if echo "$REAPPLY_OUT" | grep -q "SCANYM_SCHEMA_DRIFT"; then
  pass "réexécution : message d'erreur explicite SCANYM_SCHEMA_DRIFT"
else
  fail "réexécution : message d'erreur explicite absent — sortie: $REAPPLY_OUT"
fi

# Empreinte des tables PRÉEXISTANTES immédiatement après application
# du DRAFT, AVANT toute insertion de test ci-dessous (cardinalité,
# RLS, etc.) -- capturée ici pour que la comparaison finale
# d'additivité (§22) ne soit pas polluée par les mutations que CE
# harnais lui-même effectue plus loin (insert restaurant_users, delete
# restaurant_sale_modes pour le test de cascade...).
AFTER_DRAFT_TABLES_SAME=$(sql "select string_agg(tablename || ':' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text, '|' order by tablename) from pg_tables where schemaname='public' and tablename <> 'restaurant_sale_mode_fulfillments';")

# ==================================================================
# SCHEMA
# ==================================================================
assert_eq "table restaurant_sale_mode_fulfillments existe" "t" "$(sql "select exists(select 1 from pg_tables where schemaname='public' and tablename='restaurant_sale_mode_fulfillments');")"

for col_type in "id:uuid" "restaurant_id:uuid" "mode_code:text" "fulfillment_code:text" "provider:text" "zone_prefixes:ARRAY" "is_fallback:boolean" "min_items:integer" "customer_text:text" "display_order:integer" "enabled:boolean" "config:jsonb"; do
  col="${col_type%%:*}"; typ="${col_type##*:}"
  actual=$(sql "select data_type from information_schema.columns where table_schema='public' and table_name='restaurant_sale_mode_fulfillments' and column_name='$col';")
  assert_eq "colonne $col a le type attendu ($typ)" "$typ" "$actual"
done

assert_eq "PK sur id" "t" "$(sql "select exists(select 1 from information_schema.table_constraints where table_schema='public' and table_name='restaurant_sale_mode_fulfillments' and constraint_type='PRIMARY KEY');")"
assert_eq "contrainte unique (restaurant_id, mode_code, display_order) existe" "t" "$(sql "select exists(select 1 from pg_constraint where conname='restaurant_sale_mode_fulfillments_order_unique');")"
assert_eq "FK composite vers restaurant_sale_modes existe" "t" "$(sql "select exists(select 1 from pg_constraint where conname='restaurant_sale_mode_fulfillments_sale_mode_fkey' and contype='f');")"
assert_eq "FK composite porte bien 2 colonnes (restaurant_id, mode_code)" "2" "$(sql "select cardinality(conkey) from pg_constraint where conname='restaurant_sale_mode_fulfillments_sale_mode_fkey';")"
assert_eq "index unique partiel one-fallback existe" "t" "$(sql "select exists(select 1 from pg_indexes where schemaname='public' and indexname='restaurant_sale_mode_fulfillments_one_fallback');")"
assert_eq "index lookup (restaurant_id, mode_code, enabled) existe" "t" "$(sql "select exists(select 1 from pg_indexes where schemaname='public' and indexname='idx_restaurant_sale_mode_fulfillments_lookup');")"
assert_eq "défaut zone_prefixes = tableau vide (pas NULL, pas de préfixe codé en dur)" "t" "$(sql "select column_default like '%\{\}%' from information_schema.columns where table_schema='public' and table_name='restaurant_sale_mode_fulfillments' and column_name='zone_prefixes';")"
assert_eq "défaut is_fallback = false" "t" "$(sql "select column_default like '%false%' from information_schema.columns where table_schema='public' and table_name='restaurant_sale_mode_fulfillments' and column_name='is_fallback';")"
assert_eq "défaut enabled = true" "t" "$(sql "select column_default like '%true%' from information_schema.columns where table_schema='public' and table_name='restaurant_sale_mode_fulfillments' and column_name='enabled';")"
assert_eq "config n'a AUCUN défaut (cohérence avec restaurant_sale_modes.config)" "" "$(sql "select column_default from information_schema.columns where table_schema='public' and table_name='restaurant_sale_mode_fulfillments' and column_name='config';")"
assert_eq "config est nullable" "YES" "$(sql "select is_nullable from information_schema.columns where table_schema='public' and table_name='restaurant_sale_mode_fulfillments' and column_name='config';")"
assert_eq "fulfillment_code n'a AUCUNE énumération CHECK IN(...) (vocabulaire ouvert)" "f" "$(sql "select exists(select 1 from pg_constraint where conrelid='public.restaurant_sale_mode_fulfillments'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%fulfillment_code%in (%');")"

# ==================================================================
# Récupération des tenants réels + prérequis restaurant_sale_modes
# ==================================================================
ILLICO_ID=$(sql "select id from restaurants where slug='illico-presto';")
SANAA_ID=$(sql "select id from restaurants where slug='sanaa-cookies';")
SIROCCO_ID=$(sql "select id from restaurants where slug='le-sirocco';")

assert_eq "backfill LOT 2A a bien créé restaurant_sale_modes(illico, pickup)" "t" "$(sql "select exists(select 1 from restaurant_sale_modes where restaurant_id='$ILLICO_ID' and mode_code='pickup');")"
assert_eq "backfill LOT 2A a bien créé restaurant_sale_modes(sanaa, pickup)" "t" "$(sql "select exists(select 1 from restaurant_sale_modes where restaurant_id='$SANAA_ID' and mode_code='pickup');")"

# ==================================================================
# CARDINALITÉ : plusieurs règles sous le même (restaurant, mode),
# tenants indépendants
# ==================================================================
sql "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order) values ('$ILLICO_ID','pickup','counter_pickup','internal',0);" >/dev/null
sql "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order) values ('$ILLICO_ID','pickup','curbside_pickup','internal',1);" >/dev/null
assert_eq "2 règles indépendantes sous le même (restaurant, mode) autorisées" "2" "$(sql "select count(*) from restaurant_sale_mode_fulfillments where restaurant_id='$ILLICO_ID' and mode_code='pickup';")"

sql "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order) values ('$SANAA_ID','pickup','counter_pickup','internal',0);" >/dev/null
assert_eq "tenant indépendant (Sanaa) peut aussi avoir sa propre règle pickup" "1" "$(sql "select count(*) from restaurant_sale_mode_fulfillments where restaurant_id='$SANAA_ID' and mode_code='pickup';")"
assert_eq "les règles de Sanaa ne comptent pas dans celles d'Illico (isolation logique)" "2" "$(sql "select count(*) from restaurant_sale_mode_fulfillments where restaurant_id='$ILLICO_ID';")"

DUP_ORDER_RC=0
psql -d "$DB" -c "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order) values ('$ILLICO_ID','pickup','dup_order','internal',0);" >/dev/null 2>&1 || DUP_ORDER_RC=$?
assert_rc "display_order dupliqué sous le même (restaurant, mode) refusé" 1 "$([ "$DUP_ORDER_RC" != "0" ] && echo 1 || echo 0)"

NEG_ORDER_RC=0
psql -d "$DB" -c "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order) values ('$ILLICO_ID','pickup','neg_order','internal',-1);" >/dev/null 2>&1 || NEG_ORDER_RC=$?
assert_rc "display_order négatif refusé" 1 "$([ "$NEG_ORDER_RC" != "0" ] && echo 1 || echo 0)"

# Fallback : 1 seul autorisé par (restaurant, mode), absence autorisée
sql "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order, is_fallback) values ('$ILLICO_ID','pickup','fallback_pickup','internal',2,true);" >/dev/null
assert_eq "1er fallback sur (illico, pickup) accepté" "1" "$(sql "select count(*) from restaurant_sale_mode_fulfillments where restaurant_id='$ILLICO_ID' and mode_code='pickup' and is_fallback;")"
DUP_FALLBACK_RC=0
psql -d "$DB" -c "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order, is_fallback) values ('$ILLICO_ID','pickup','second_fallback','internal',3,true);" >/dev/null 2>&1 || DUP_FALLBACK_RC=$?
assert_rc "2e fallback sur le même (restaurant, mode) refusé" 1 "$([ "$DUP_FALLBACK_RC" != "0" ] && echo 1 || echo 0)"
assert_eq "absence de fallback reste possible (Sanaa n'en a aucun)" "0" "$(sql "select count(*) from restaurant_sale_mode_fulfillments where restaurant_id='$SANAA_ID' and mode_code='pickup' and is_fallback;")"

# ==================================================================
# FK : impossible sans restaurant_sale_modes existant ; comportement
# de suppression conforme au design (cascade)
# ==================================================================
FK_MISSING_RC=0
psql -d "$DB" -c "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order) values ('$SIROCCO_ID','nonexistent_mode','x','internal',0);" >/dev/null 2>&1 || FK_MISSING_RC=$?
assert_rc "règle sans restaurant_sale_modes correspondant (mode_code inexistant pour ce tenant) impossible" 1 "$([ "$FK_MISSING_RC" != "0" ] && echo 1 || echo 0)"

FK_RANDOM_TENANT_RC=0
psql -d "$DB" -c "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order) values (gen_random_uuid(),'pickup','x','internal',0);" >/dev/null 2>&1 || FK_RANDOM_TENANT_RC=$?
assert_rc "règle pour un restaurant_id inexistant impossible" 1 "$([ "$FK_RANDOM_TENANT_RC" != "0" ] && echo 1 || echo 0)"

# Suppression de la ligne restaurant_sale_modes parente -> cascade sur
# les règles. Sirocco ne reçoit QUE 'table' via le backfill LOT 2A
# (aucun pickup/delivery configuré pour ce tenant, cf.
# migration-v82-lot2a-sale-modes.sql cas 3/4) -- 'table' est donc le
# seul mode_code réellement disponible pour ce test sur ce tenant.
assert_eq "prérequis cascade : restaurant_sale_modes(sirocco, table) existe" "t" "$(sql "select exists(select 1 from restaurant_sale_modes where restaurant_id='$SIROCCO_ID' and mode_code='table');")"
sql "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order) values ('$SIROCCO_ID','table','to_be_cascaded','internal',0);" >/dev/null
CASCADE_BEFORE=$(sql "select count(*) from restaurant_sale_mode_fulfillments where restaurant_id='$SIROCCO_ID' and mode_code='table';")
sql "delete from restaurant_sale_modes where restaurant_id='$SIROCCO_ID' and mode_code='table';" >/dev/null
CASCADE_AFTER=$(sql "select count(*) from restaurant_sale_mode_fulfillments where restaurant_id='$SIROCCO_ID' and mode_code='table';")
if [ "$CASCADE_BEFORE" = "1" ] && [ "$CASCADE_AFTER" = "0" ]; then
  pass "suppression du sale_mode parent entraîne bien la cascade sur ses règles fulfillment (avant=$CASCADE_BEFORE, après=$CASCADE_AFTER)"
else
  fail "cascade FK non conforme (avant=$CASCADE_BEFORE, après=$CASCADE_AFTER)"
fi

# ==================================================================
# ZONE : tableau vide/nul selon contrat, aucun préfixe codé en dur
# dans le DRAFT lui-même
# ==================================================================
assert_eq "zone_prefixes par défaut = tableau vide (pas NULL)" "0" "$(sql "select coalesce(array_length(zone_prefixes,1),0) from restaurant_sale_mode_fulfillments where restaurant_id='$ILLICO_ID' and mode_code='pickup' and fulfillment_code='counter_pickup';")"
# Exclut les lignes mentionnant server_version_num (ex. "170000",
# "160013") -- des seuils de version PostgreSQL introduits par le
# correctif MAINTAIN (FRA-A-02), pas des préfixes de code postal. Toute
# AUTRE séquence de 5 chiffres resterait détectée normalement.
assert_eq "aucun préfixe de code postal codé en dur dans le fichier DRAFT" "0" "$(grep -v 'server_version_num' "$DRAFT_SQL" | grep -Eic '[0-9]{5}' || true)"
assert_eq "aucune mention de ville (Paris/Lyon/Marseille) dans le fichier DRAFT" "0" "$(grep -Eic 'Paris|Lyon|Marseille' "$DRAFT_SQL" || true)"
assert_eq "helper restaurant_sale_mode_fulfillments_zone_prefixes_valid existe" "t" "$(sql "select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='restaurant_sale_mode_fulfillments_zone_prefixes_valid');")"
assert_eq "helper zone_prefixes est IMMUTABLE" "i" "$(sql "select provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='restaurant_sale_mode_fulfillments_zone_prefixes_valid';")"
assert_eq "helper zone_prefixes N'EST PAS SECURITY DEFINER" "f" "$(sql "select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='restaurant_sale_mode_fulfillments_zone_prefixes_valid';")"
assert_eq "helper zone_prefixes N'A PAS d'EXECUTE pour PUBLIC" "f" "$(sql "select has_function_privilege('public','public.restaurant_sale_mode_fulfillments_zone_prefixes_valid(text[])','EXECUTE');")"
assert_eq "helper zone_prefixes N'A PAS d'EXECUTE pour anon" "f" "$(sql "select has_function_privilege('anon','public.restaurant_sale_mode_fulfillments_zone_prefixes_valid(text[])','EXECUTE');")"
assert_eq "helper zone_prefixes N'A PAS d'EXECUTE pour authenticated" "f" "$(sql "select has_function_privilege('authenticated','public.restaurant_sale_mode_fulfillments_zone_prefixes_valid(text[])','EXECUTE');")"
assert_eq "helper zone_prefixes A EXECUTE pour service_role (strictement nécessaire, sinon les écritures échouent)" "t" "$(sql "select has_function_privilege('service_role','public.restaurant_sale_mode_fulfillments_zone_prefixes_valid(text[])','EXECUTE');")"

# --- FRA-A-01 : 10 scénarios obligatoires, testés en tant que
# service_role (seul rôle avec INSERT sur cette table, cf. FRA-A-02).
# Chaque insertion utilise un display_order dédié pour ne jamais
# entrer en conflit avec la contrainte unique testée plus haut.
zp_insert_as_service_role() {
  local order="$1" arr_sql="$2"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c \
    "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order, zone_prefixes) values ('$SANAA_ID','pickup','zp_test_$order','internal',$order,$arr_sql);"
}

ZP_RC=0; zp_insert_as_service_role 100 "array[]::text[]" >/dev/null 2>&1 || ZP_RC=$?
assert_rc "FRA-A-01.1: ARRAY[]::text[] accepté" 0 "$ZP_RC"

ZP_RC=0; zp_insert_as_service_role 101 "array['75']" >/dev/null 2>&1 || ZP_RC=$?
assert_rc "FRA-A-01.2: ARRAY['75'] accepté" 0 "$ZP_RC"

ZP_RC=0; zp_insert_as_service_role 102 "array['75','77','78']" >/dev/null 2>&1 || ZP_RC=$?
assert_rc "FRA-A-01.3: plusieurs préfixes valides acceptés" 0 "$ZP_RC"

ZP_RC=0; zp_insert_as_service_role 103 "array['']" >/dev/null 2>&1 || ZP_RC=$?
assert_rc "FRA-A-01.4: ARRAY[''] rejeté" 1 "$([ "$ZP_RC" != "0" ] && echo 1 || echo 0)"

ZP_RC=0; zp_insert_as_service_role 104 "array[' ']" >/dev/null 2>&1 || ZP_RC=$?
assert_rc "FRA-A-01.5: ARRAY[' '] (espace) rejeté" 1 "$([ "$ZP_RC" != "0" ] && echo 1 || echo 0)"

ZP_RC=0; zp_insert_as_service_role 105 "array[E'\\t']" >/dev/null 2>&1 || ZP_RC=$?
assert_rc "FRA-A-01.6: élément tabulation-seule rejeté" 1 "$([ "$ZP_RC" != "0" ] && echo 1 || echo 0)"

ZP_RC=0; zp_insert_as_service_role 106 "array[NULL]::text[]" >/dev/null 2>&1 || ZP_RC=$?
assert_rc "FRA-A-01.7: ARRAY[NULL]::text[] rejeté" 1 "$([ "$ZP_RC" != "0" ] && echo 1 || echo 0)"

ZP_RC=0; zp_insert_as_service_role 107 "null" >/dev/null 2>&1 || ZP_RC=$?
assert_rc "FRA-A-01.8: tableau globalement NULL rejeté (not null)" 1 "$([ "$ZP_RC" != "0" ] && echo 1 || echo 0)"

ZP_RC=0; zp_insert_as_service_role 108 "array['75','']" >/dev/null 2>&1 || ZP_RC=$?
assert_rc "FRA-A-01.9: mélange valeur valide + valeur vide rejeté" 1 "$([ "$ZP_RC" != "0" ] && echo 1 || echo 0)"

ZP_RC=0; zp_insert_as_service_role 109 "array['75', NULL]" >/dev/null 2>&1 || ZP_RC=$?
assert_rc "FRA-A-01.10: mélange valeur valide + NULL rejeté" 1 "$([ "$ZP_RC" != "0" ] && echo 1 || echo 0)"

assert_eq "aucune valeur zone_prefixes de test (75/77/78) n'a fuité comme donnée tenant réelle -- lignes de test nettoyées après vérification" "3" "$(sql "select count(*) from restaurant_sale_mode_fulfillments where restaurant_id='$SANAA_ID' and fulfillment_code like 'zp_test_%';")"
sql "delete from restaurant_sale_mode_fulfillments where fulfillment_code like 'zp_test_%';" >/dev/null

# ==================================================================
# RLS
# ==================================================================
# Membre du tenant Illico
ILLICO_USER=$(sql "insert into auth.users (email) values ('member-illico@test.local') returning id;")
sql "insert into restaurant_users (user_id, restaurant_id, role) values ('$ILLICO_USER','$ILLICO_ID','owner');" >/dev/null
# Membre du tenant Sanaa
SANAA_USER=$(sql "insert into auth.users (email) values ('member-sanaa@test.local') returning id;")
sql "insert into restaurant_users (user_id, restaurant_id, role) values ('$SANAA_USER','$SANAA_ID','owner');" >/dev/null
# Utilisateur authentifié mais membre d'AUCUN établissement
ORPHAN_USER=$(sql "insert into auth.users (email) values ('orphan@test.local') returning id;")

AS_ILLICO_MEMBER() { PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$ILLICO_USER'; $1"; }
AS_SANAA_MEMBER()  { PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$SANAA_USER'; $1"; }
AS_ORPHAN()        { PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$ORPHAN_USER'; $1"; }

assert_eq "membre Illico lit SES propres règles (2 pickup + 1 fallback insérés plus haut)" "3" "$(AS_ILLICO_MEMBER "select count(*) from restaurant_sale_mode_fulfillments where restaurant_id='$ILLICO_ID';")"
assert_eq "membre Illico NE VOIT PAS les règles de Sanaa (cross-tenant)" "0" "$(AS_ILLICO_MEMBER "select count(*) from restaurant_sale_mode_fulfillments where restaurant_id='$SANAA_ID';")"
assert_eq "membre Sanaa lit SES propres règles" "1" "$(AS_SANAA_MEMBER "select count(*) from restaurant_sale_mode_fulfillments where restaurant_id='$SANAA_ID';")"
assert_eq "authenticated non-membre d'aucun établissement ne lit aucune règle" "0" "$(AS_ORPHAN "select count(*) from restaurant_sale_mode_fulfillments;")"
assert_eq "anon ne peut pas lire directement (RLS + GRANT)" "0" "$(sql_as anon "select count(*) from restaurant_sale_mode_fulfillments;" 2>/dev/null || echo 0)"

# Mutations directes : conformes au modèle retenu dans ce lot (aucun
# flux applicatif/RPC de mutation n'existe encore -- écritures
# directes doivent rester impossibles pour anon/authenticated).
ANON_INSERT_RC=0
sql_as anon "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order) values ('$ILLICO_ID','pickup','anon_hack','internal',9);" >/dev/null 2>&1 || ANON_INSERT_RC=$?
assert_rc "anon ne peut pas insérer" 1 "$([ "$ANON_INSERT_RC" != "0" ] && echo 1 || echo 0)"

AUTH_INSERT_RC=0
AS_ILLICO_MEMBER "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order) values ('$ILLICO_ID','pickup','member_direct_insert',9);" >/dev/null 2>&1 || AUTH_INSERT_RC=$?
assert_rc "membre authentifié ne peut pas insérer directement (aucune RPC dans ce lot)" 1 "$([ "$AUTH_INSERT_RC" != "0" ] && echo 1 || echo 0)"

AUTH_UPDATE_RC=0
AS_ILLICO_MEMBER "update restaurant_sale_mode_fulfillments set enabled=false where restaurant_id='$ILLICO_ID';" >/dev/null 2>&1 || AUTH_UPDATE_RC=$?
assert_rc "membre authentifié ne peut pas modifier directement" 1 "$([ "$AUTH_UPDATE_RC" != "0" ] && echo 1 || echo 0)"

AUTH_DELETE_RC=0
AS_ILLICO_MEMBER "delete from restaurant_sale_mode_fulfillments where restaurant_id='$ILLICO_ID';" >/dev/null 2>&1 || AUTH_DELETE_RC=$?
assert_rc "membre authentifié ne peut pas supprimer directement" 1 "$([ "$AUTH_DELETE_RC" != "0" ] && echo 1 || echo 0)"

# service_role : CRUD applicatif complet, effectivement fonctionnel
# (pas seulement le bit de privilège -- une vraie insertion/mise à
# jour/suppression réussit, malgré la policy RLS SELECT-only, grâce à
# BYPASSRLS -- FRA-A-02).
SR_INSERT_RC=0
PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order) values ('$ILLICO_ID','pickup','service_role_write_test','internal',20);" >/dev/null 2>&1 || SR_INSERT_RC=$?
assert_rc "service_role PEUT insérer directement (CRUD applicatif, contrat FRA-A-02)" 0 "$SR_INSERT_RC"

SR_UPDATE_RC=0
PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "update restaurant_sale_mode_fulfillments set enabled=false where restaurant_id='$ILLICO_ID' and fulfillment_code='service_role_write_test';" >/dev/null 2>&1 || SR_UPDATE_RC=$?
assert_rc "service_role PEUT modifier directement" 0 "$SR_UPDATE_RC"

SR_DELETE_RC=0
PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "delete from restaurant_sale_mode_fulfillments where restaurant_id='$ILLICO_ID' and fulfillment_code='service_role_write_test';" >/dev/null 2>&1 || SR_DELETE_RC=$?
assert_rc "service_role PEUT supprimer directement" 0 "$SR_DELETE_RC"

SR_TRUNCATE_RC=0
PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "truncate table restaurant_sale_mode_fulfillments;" >/dev/null 2>&1 || SR_TRUNCATE_RC=$?
assert_rc "service_role NE PEUT PAS TRUNCATE (privilège dangereux explicitement interdit, FRA-A-02)" 1 "$([ "$SR_TRUNCATE_RC" != "0" ] && echo 1 || echo 0)"

# ==================================================================
# PRIVILÈGES — matrice ACL complète et déterministe (FRA-A-02/FRA-A-03,
# contre-audit Work) : has_table_privilege réel pour CHAQUE rôle × 8
# privilèges. AUCUNE assertion n'utilise current_user comme preuve de
# substitution pour service_role (défaut FRA-A-02 corrigé ici — le
# harnais Lot A testait auparavant
# `has_table_privilege('service_role',...) OR has_table_privilege(current_user,...)`,
# ce qui rendait le test vrai même si service_role n'avait aucun
# privilège, current_user étant le propriétaire de la table dans ce
# harnais). Chaque rôle est testé DIRECTEMENT, individuellement.
# ==================================================================
PG_VERSION_NUM=$(sql "select current_setting('server_version_num');")
log "Version PostgreSQL du serveur de test : $PG_VERSION_NUM (MAINTAIN introduit en 170000+)"

acl_assert() {
  local role="$1" priv="$2" expected="$3"
  assert_eq "ACL: $role / $priv = $expected (effectif, direct, sans OR current_user)" "$expected" "$(sql "select has_table_privilege('$role','public.restaurant_sale_mode_fulfillments','$priv');")"
}

for role in public anon; do
  for priv in SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER; do
    acl_assert "$role" "$priv" "f"
  done
done

acl_assert authenticated SELECT t
for priv in INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER; do
  acl_assert authenticated "$priv" f
done

acl_assert service_role SELECT t
acl_assert service_role INSERT t
acl_assert service_role UPDATE t
acl_assert service_role DELETE t
for priv in TRUNCATE REFERENCES TRIGGER; do
  acl_assert service_role "$priv" f
done

# MAINTAIN : privilège PostgreSQL 17+, INEXISTANT (erreur
# "unrecognized privilege type") sur PostgreSQL < 17 -- vérifié
# empiriquement dans ce lot. Ce n'est PAS un contournement de
# limitation sandbox : c'est un fait PostgreSQL réel qui s'appliquerait
# identiquement sur toute instance < 17, y compris une Production sur
# cette version. Testé réellement si le serveur le supporte ; sinon
# explicitement journalisé comme NON-APPLICABLE (jamais silencieusement
# omis, jamais compté comme un PASS de complaisance).
if [ "$PG_VERSION_NUM" -ge 170000 ]; then
  for role in public anon authenticated service_role; do
    acl_assert "$role" MAINTAIN f
  done
else
  log "SKIP (non-applicable) : MAINTAIN pour public/anon/authenticated/service_role -- PostgreSQL $PG_VERSION_NUM < 170000, ce privilège n'existe pas sur cette version (ni has_table_privilege ni REVOKE ne le reconnaissent -- vérifié). Le DRAFT gère cela via un bloc conditionnel sur server_version_num. À revalider sur une instance PostgreSQL 17+ si la Production Supabase réelle s'avère être sur cette version (non vérifiable depuis cet environnement, aucun accès Production)."
fi

# Simulation de l'escalade SEC-2A3-01 : GRANT ALL forcé sur les 4
# rôles (y compris service_role désormais, cf. FRA-A-02), puis
# vérification que la ré-application manuelle du bloc REVOKE/GRANT
# exact du DRAFT restaure bien le contrat déterministe complet --
# preuve que ce contrat ne dépend jamais des privilèges par défaut
# d'une plateforme, même dans le pire scénario adverse.
psql -d "$DB" -c "grant all on public.restaurant_sale_mode_fulfillments to public, anon, authenticated, service_role;" >/dev/null
psql -d "$DB" -c "
revoke all on public.restaurant_sale_mode_fulfillments from public, anon, authenticated, service_role;
grant select on public.restaurant_sale_mode_fulfillments to authenticated;
grant select, insert, update, delete on public.restaurant_sale_mode_fulfillments to service_role;
revoke truncate, references, trigger on public.restaurant_sale_mode_fulfillments from public, anon, authenticated, service_role;
" >/dev/null
if [ "$PG_VERSION_NUM" -ge 170000 ]; then
  psql -d "$DB" -c "revoke maintain on table public.restaurant_sale_mode_fulfillments from public, anon, authenticated, service_role;" >/dev/null
fi
assert_eq "post-escalade : anon retombe à SELECT=false" "f" "$(sql "select has_table_privilege('anon','public.restaurant_sale_mode_fulfillments','SELECT');")"
assert_eq "post-escalade : anon retombe à TRUNCATE=false" "f" "$(sql "select has_table_privilege('anon','public.restaurant_sale_mode_fulfillments','TRUNCATE');")"
assert_eq "post-escalade : authenticated retombe à INSERT=false" "f" "$(sql "select has_table_privilege('authenticated','public.restaurant_sale_mode_fulfillments','INSERT');")"
assert_eq "post-escalade : authenticated conserve SELECT=true" "t" "$(sql "select has_table_privilege('authenticated','public.restaurant_sale_mode_fulfillments','SELECT');")"
assert_eq "post-escalade : service_role conserve INSERT=true (contrat FRA-A-02, pas juste hérité de l'escalade)" "t" "$(sql "select has_table_privilege('service_role','public.restaurant_sale_mode_fulfillments','INSERT');")"
assert_eq "post-escalade : service_role retombe à TRUNCATE=false" "f" "$(sql "select has_table_privilege('service_role','public.restaurant_sale_mode_fulfillments','TRUNCATE');")"

# ==================================================================
# AUCUNE DONNÉE TENANT introduite PAR LE DRAFT LUI-MÊME. Les lignes
# présentes dans $DB à ce stade viennent exclusivement des INSERT de
# test explicites ci-dessus (tous visibles dans ce script) -- le
# contrôle robuste et non-ambigu est de confirmer, en lisant le
# fichier DRAFT lui-même, qu'il ne contient AUCUNE instruction INSERT
# INTO restaurant_sale_mode_fulfillments (ni aucun autre tenant réel).
# ==================================================================
INSERT_COUNT_IN_DRAFT=$(grep -Eic "insert +into +public\.restaurant_sale_mode_fulfillments" "$DRAFT_SQL" || true)
assert_eq "le fichier DRAFT ne contient AUCUNE instruction INSERT INTO restaurant_sale_mode_fulfillments" "0" "$INSERT_COUNT_IN_DRAFT"

# ==================================================================
# COMPATIBILITÉ / ADDITIVITÉ (§22) : les tables et RPC préexistantes
# sont inchangées (comptage de lignes identique pour toutes les
# tables préexistantes, liste de fonctions publiques inchangée SAUF
# ajout éventuel -- ce lot n'ajoute aucune fonction).
# ==================================================================
# Lot A.1 ajoute EXACTEMENT une fonction (le helper de validation
# FRA-A-01, strictement nécessaire -- voir justification dans le
# DRAFT), donc BEFORE_ROUTINES + cette seule fonction doit égaler
# AFTER_ROUTINES. Toute AUTRE différence (RPC publique, resolver Lot B,
# etc.) reste détectée normalement -- ce n'est pas un assouplissement
# général du test, seulement la prise en compte du seul ajout légitime
# et documenté de ce lot.
AFTER_ROUTINES=$(sql "select string_agg(proname, ',' order by proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';")
EXPECTED_AFTER_ROUTINES=$(printf '%s\n' "$BEFORE_ROUTINES" "restaurant_sale_mode_fulfillments_zone_prefixes_valid" | tr ',' '\n' | grep -v '^$' | sort | tr '\n' ',' | sed 's/,$//')
AFTER_ROUTINES_SORTED=$(printf '%s' "$AFTER_ROUTINES" | tr ',' '\n' | sort | tr '\n' ',' | sed 's/,$//')
assert_eq "ce lot ajoute EXACTEMENT une fonction (le helper FRA-A-01), aucune autre routine publique" "$EXPECTED_AFTER_ROUTINES" "$AFTER_ROUTINES_SORTED"

# Comptage des tables préexistantes (hors la nouvelle table elle-même)
# inchangé ENTRE juste-avant et juste-après application du DRAFT
# (AFTER_DRAFT_TABLES_SAME, capturé plus haut avant toute insertion de
# test de ce harnais) -- preuve que le DRAFT LUI-MÊME est bien 100%
# additif, indépendamment des mutations que ce script effectue
# ensuite pour ses propres besoins de test.
BEFORE_TABLES_SAME=$(echo "$BEFORE_TABLES" | tr '|' '\n' | grep -v '^restaurant_sale_mode_fulfillments:' | sort | tr '\n' '|')
AFTER_DRAFT_TABLES_SAME_SORTED=$(echo "$AFTER_DRAFT_TABLES_SAME" | tr '|' '\n' | sort | tr '\n' '|')
assert_eq "comptages de lignes des tables préexistantes inchangés par le DRAFT lui-même (additivité stricte)" "$BEFORE_TABLES_SAME" "$AFTER_DRAFT_TABLES_SAME_SORTED"

# ==================================================================
# Résumé
# ==================================================================
log "----------------------------------------------------------"
log "PASS=$PASS_COUNT FAIL=$FAIL_COUNT"
FAIL_LINES=$(wc -l < "$FAIL_LOG" | tr -d ' ')
if [ "$FAIL_LINES" != "$FAIL_COUNT" ]; then
  log "AUTO-CONTROLE INCOHERENT: FAIL_LOG a $FAIL_LINES lignes mais FAIL_COUNT=$FAIL_COUNT"
  exit 2
fi
if [ "$FAIL_COUNT" -eq 0 ]; then
  log "TOUS LES TESTS PASSENT ($PASS_COUNT/$PASS_COUNT)"
  exit 0
else
  log "ECHECS ($FAIL_COUNT) :"
  cat "$FAIL_LOG"
  exit 1
fi
