#!/usr/bin/env bash
# ============================================================
# Scanym LOT 2B.1 — Harnais reproductible : nouvelle RPC publique
# minimale get_restaurant_public_delivery_info.
#
# Baseline : LOT 2A.4 (vrai main, bd2980a1d3d708f9a51bd72874e9fd2c009b3516,
# Production installée et validée).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/v84-lot2b1-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DB="scanym_v84_lot2b1_$$"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
FAIL_LOG="/tmp/scanym-lot2b1-fails-$$.log"
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

log "=== Construction de la baseline réelle (LOT 2A.4, seeds AVANT LOT 2A pour un backfill correct) ==="
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
pass "chaîne réelle appliquée jusqu'à LOT 2A.4, avec backfill correct (seeds avant LOT 2A)"

log "=== Application de migration-v84-lot2b1-delivery-info-rpc.sql ==="
# Reproduit le risque réel Supabase : un default privilege peut donner
# EXECUTE directement à service_role, indépendamment de PUBLIC.
psql -d "$DB" -c "alter default privileges in schema public grant execute on functions to service_role;" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
pass "migration LOT 2B.1 appliquée sans erreur sur baseline réelle LOT 2A.4"

SANAA_ID=$(psql -X -A -t -d "$DB" -c "select id from restaurants where slug='sanaa-cookies';")
ILLICO_ID=$(psql -X -A -t -d "$DB" -c "select id from restaurants where slug='illico-presto';")

log "=== Les 6 scénarios fonctionnels exacts exigés ==="
RESULT=$(psql -X -A -t -d "$DB" -c "select delivery_zone_prefixes, delivery_min_items, delivery_area_label from public.get_restaurant_public_delivery_info('$SANAA_ID');")
assert_eq "actif + delivery activé -> 3 champs retournés (backfill exact)" "{75,77,78,91,92,93,94,95}|10|Île-de-France" "$RESULT"

psql -d "$DB" -c "update restaurant_sale_modes set enabled=false where restaurant_id='$SANAA_ID' and mode_code='delivery';" >/dev/null
COUNT=$(psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_delivery_info('$SANAA_ID');")
assert_eq "delivery désactivé -> aucune ligne" "0" "$COUNT"
psql -d "$DB" -c "update restaurant_sale_modes set enabled=true where restaurant_id='$SANAA_ID' and mode_code='delivery';" >/dev/null

COUNT=$(psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_delivery_info('$ILLICO_ID');")
assert_eq "delivery absent de restaurant_sale_modes (illico-presto) -> aucune ligne" "0" "$COUNT"

psql -d "$DB" -c "update restaurants set status='onboarding' where slug='sanaa-cookies';" >/dev/null
COUNT=$(psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_delivery_info('$SANAA_ID');")
assert_eq "onboarding + delivery activé -> aucune ligne" "0" "$COUNT"

psql -d "$DB" -c "update restaurants set status='suspended' where slug='sanaa-cookies';" >/dev/null
COUNT=$(psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_delivery_info('$SANAA_ID');")
assert_eq "suspendu + delivery activé -> aucune ligne" "0" "$COUNT"

psql -d "$DB" -c "update restaurants set status='active', is_active=false where slug='sanaa-cookies';" >/dev/null
COUNT=$(psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_delivery_info('$SANAA_ID');")
assert_eq "inactif + delivery activé -> aucune ligne" "0" "$COUNT"
psql -d "$DB" -c "update restaurants set is_active=true, status='active' where slug='sanaa-cookies';" >/dev/null

log "=== Conversion JSONB -> text[] : les 3 cas limites, jamais NULL ==="
psql -d "$DB" -c "update restaurant_sale_modes set config='{\"delivery_min_items\":5}'::jsonb where restaurant_id='$SANAA_ID' and mode_code='delivery';" >/dev/null
RESULT=$(psql -X -A -t -d "$DB" -c "select delivery_zone_prefixes, (delivery_zone_prefixes is null) from public.get_restaurant_public_delivery_info('$SANAA_ID');")
assert_eq "clé delivery_zone_prefixes absente -> tableau vide, jamais NULL" "{}|f" "$RESULT"

psql -d "$DB" -c "update restaurant_sale_modes set config='{\"delivery_zone_prefixes\":[]}'::jsonb where restaurant_id='$SANAA_ID' and mode_code='delivery';" >/dev/null
RESULT=$(psql -X -A -t -d "$DB" -c "select delivery_zone_prefixes, (delivery_zone_prefixes is null) from public.get_restaurant_public_delivery_info('$SANAA_ID');")
assert_eq "tableau JSON vide -> tableau vide, jamais NULL" "{}|f" "$RESULT"

psql -d "$DB" -c "update restaurant_sale_modes set config=null where restaurant_id='$SANAA_ID' and mode_code='delivery';" >/dev/null
RESULT=$(psql -X -A -t -d "$DB" -c "select delivery_zone_prefixes, (delivery_zone_prefixes is null), delivery_min_items from public.get_restaurant_public_delivery_info('$SANAA_ID');")
assert_eq "config NULL -> tableau vide + min_items=0, jamais d'erreur" "{}|f|0" "$RESULT"

# Remet un config valide pour la suite (restaure le backfill original)
psql -d "$DB" -c "update restaurant_sale_modes set config=jsonb_build_object('delivery_zone_prefixes', array['75','77','78','91','92','93','94','95'], 'delivery_min_items', 10, 'delivery_area_label', 'Île-de-France') where restaurant_id='$SANAA_ID' and mode_code='delivery';" >/dev/null

log "=== Privilèges effectifs (has_function_privilege, pas seulement le texte GRANT) ==="
V=$(psql -X -A -t -d "$DB" -c "select has_function_privilege('anon', 'public.get_restaurant_public_delivery_info(uuid)', 'EXECUTE');")
assert_eq "anon EXECUTE = true" "t" "$V"
V=$(psql -X -A -t -d "$DB" -c "select has_function_privilege('authenticated', 'public.get_restaurant_public_delivery_info(uuid)', 'EXECUTE');")
assert_eq "authenticated EXECUTE = true" "t" "$V"
V=$(psql -X -A -t -d "$DB" -c "select has_function_privilege('service_role', 'public.get_restaurant_public_delivery_info(uuid)', 'EXECUTE');")
assert_eq "service_role EXECUTE = false malgré le default privilege simulé" "f" "$V"
V=$(psql -X -A -t -d "$DB" -c "select has_function_privilege('public', 'public.get_restaurant_public_delivery_info(uuid)', 'EXECUTE');")
assert_eq "PUBLIC EXECUTE = false" "f" "$V"

log "=== Simulation d'un GRANT trop large (comme LOT 2A.4) -- le correctif ne doit jamais être supposé, mais vérifié ==="
psql -d "$DB" -c "grant execute on function public.get_restaurant_public_delivery_info(uuid) to public;" >/dev/null
V=$(psql -X -A -t -d "$DB" -c "select has_function_privilege('public', 'public.get_restaurant_public_delivery_info(uuid)', 'EXECUTE');")
assert_eq "précondition : simulation d'un GRANT excessif bien présente avant nouvelle vérification" "t" "$V"
psql -d "$DB" -c "revoke all on function public.get_restaurant_public_delivery_info(uuid) from public;" >/dev/null
psql -d "$DB" -c "grant execute on function public.get_restaurant_public_delivery_info(uuid) to anon, authenticated;" >/dev/null
V=$(psql -X -A -t -d "$DB" -c "select has_function_privilege('public', 'public.get_restaurant_public_delivery_info(uuid)', 'EXECUTE');")
assert_eq "après re-durcissement manuel : PUBLIC EXECUTE = false de nouveau" "f" "$V"

log "=== Forme du type retourné : jamais provider ni config ==="
OUT_PARAMS=$(psql -X -A -t -d "$DB" -c "select proargnames from pg_proc where proname='get_restaurant_public_delivery_info';")
assert_eq "les paramètres exacts (entrée+sortie), rien de plus" "{p_restaurant_id,delivery_zone_prefixes,delivery_min_items,delivery_area_label}" "$OUT_PARAMS"

log "=== Aucun helper interne : une seule fonction SQL directe ==="
FN_COUNT=$(grep -c "^create function" "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql")
assert_eq "exactement une fonction créée par ce fichier, aucun helper" "1" "$FN_COUNT"
FN_LANG=$(psql -X -A -t -d "$DB" -c "select lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.proname='get_restaurant_public_delivery_info';")
assert_eq "langage SQL simple, pas plpgsql (pas de logique procédurale nécessaire)" "sql" "$FN_LANG"

log "=== HARNESS SELF-TEST : le journal de FAIL indépendant doit concorder avec FAIL_COUNT ==="
FAIL_LOG_COUNT=$(wc -l < "$FAIL_LOG" | tr -d ' ')
if [ "$FAIL_LOG_COUNT" != "$FAIL_COUNT" ]; then
  echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST ÉCHEC CRITIQUE : FAIL_COUNT ($FAIL_COUNT) ne correspond pas au journal indépendant ($FAIL_LOG_COUNT)."
  cat "$FAIL_LOG"
  exit 1
fi
if [ "$FAIL_LOG_COUNT" -gt 0 ]; then
  echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST : $FAIL_LOG_COUNT échec(s) réel(s) -- le script échoue."
  cat "$FAIL_LOG"
  exit 1
fi
echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST : journal indépendant vide et concordant avec FAIL_COUNT (0)."

log "=== RÉSULTAT FINAL : $PASS_COUNT réussis, $FAIL_COUNT échoués ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "DES VÉRIFICATIONS LOT 2B.1 ONT ÉCHOUÉ"
  exit 1
fi
echo "TOUTES LES VÉRIFICATIONS LOT 2B.1 ONT RÉUSSI"
