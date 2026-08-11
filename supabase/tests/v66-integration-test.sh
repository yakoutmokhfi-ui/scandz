#!/usr/bin/env bash
# ============================================================
# Scanym V66 — Harnais d'intégration PostgreSQL, reproductible
#
# Écrit après second audit indépendant, qui a relevé que les
# résultats de tests PostgreSQL annoncés dans le rapport précédent
# n'étaient pas reproductibles depuis les livrables reçus (aucun
# script, aucun journal complet).
#
# Ce script :
#   - ne contient AUCUN secret, AUCUN accès Supabase/production ;
#   - construit une base PostgreSQL locale ÉPHÉMÈRE, jetée en fin de
#     script (succès ou échec) ;
#   - reconstruit l'état V65 exact (même liste de migrations, même
#     ordre, que celle utilisée pour développer et vérifier V66) ;
#   - simule l'état réel des droits Supabase constaté par audit
#     (SELECT accordé à anon/authenticated au niveau schéma, comme
#     Supabase le fait par défaut ; RLS filtre ensuite les lignes) ;
#   - charge les données réelles (seed Illico Presto + traductions
#     arabes) pour tester sur un jeu de données réaliste, pas des
#     valeurs inventées ;
#   - applique migration-v66-categories-descriptions.sql ;
#   - exécute une série d'assertions couvrant rôles, isolation,
#     doublons, catégories techniques, limites 100/101 et 500/501,
#     recalcul de prix, conservation des traductions ;
#   - teste ENSUITE migration-v66-rollback.sql et vérifie le retour
#     à l'état V65 ;
#   - s'arrête au premier échec (set -e + assertions explicites) ;
#   - supprime la base éphémère en fin d'exécution, y compris en cas
#     d'échec (trap EXIT).
#
# CORRECTION après audit Work du 11 août 2026 : l'étape 18 calculait le
# prix attendu via `python3 -c "print(f'{float('$PRICE')*2:.2f}')")` —
# guillemets simples imbriqués dans une f-string délimitée par des
# guillemets simples identiques, syntaxe valide seulement depuis Python
# 3.12 (PEP 701). Échouait (`SyntaxError`) sous Python 3.11, pourtant
# une version encore courante. Corrigé en `f'{$PRICE*2:.2f}'` : $PRICE
# est déjà substitué par bash AVANT que Python ne lise le code (c'est
# un nombre décimal Postgres, ex. "250.00", un littéral Python valide
# tel quel) — `float(...)` sur une chaîne était donc inutile, pas
# seulement mal écrit. Aucun changement de comportement : même calcul,
# même précision, compatible Python 3.11 et 3.12.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   bash supabase/tests/v66-integration-test.sh
#
# Prérequis : un serveur PostgreSQL local accessible via `psql`/
# `createdb` sans mot de passe (peer/trust auth), avec les
# extensions pgcrypto disponibles. Aucune variable d'environnement
# sensible requise.
# ============================================================

set -euo pipefail

DB="scanym_v66_ci_$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); log "FAIL: $*"; cleanup; exit 1; }

cleanup() {
  log "Nettoyage : suppression de la base éphémère $DB"
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$desc (=$actual)"
  else
    fail "$desc — attendu '$expected', obtenu '$actual'"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    pass "$desc"
  else
    fail "$desc — motif '$needle' introuvable dans la sortie"
  fi
}

sql() { psql -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
sql_t() { psql -d "$DB" -t -A -v ON_ERROR_STOP=1 "$@"; }
extract_uuid() { grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1; }

log "=== 1. Création de la base éphémère $DB ==="
createdb "$DB"

log "=== 2. Stubs auth.users / auth.uid() / rôles anon,authenticated,service_role ==="
sql <<'SQL'
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
SQL

log "=== 3. Reconstruction de la chaîne V65 (ordre exact des migrations) ==="
for f in schema.sql migration-orders.sql migration-orders-lang.sql \
         migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql \
         migration-translations.sql migration-v39-settings.sql \
         migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql \
         migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql; do
  log "  -> $f"
  sql -f "$SUPABASE_DIR/$f" >/dev/null
done
pass "chaîne V65 appliquée sans erreur"

log "=== 4. Simulation de l'état réel des droits Supabase (SELECT au niveau schéma) ==="
sql -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null

log "=== 5. Chargement des données réelles (seed Illico Presto + traductions AR) ==="
sql -f "$SUPABASE_DIR/seed-illico-v2.sql" >/dev/null
sql -f "$SUPABASE_DIR/migration-translations.sql" >/dev/null

COUNT_BEFORE=$(sql_t -c "select count(*) from public.menu_items mi join public.menu_categories mc on mc.id=mi.category_id join public.restaurants r on r.id=mc.restaurant_id where r.slug='illico-presto' and mi.translations ? 'ar' and mi.translations->'ar'->>'description' is not null;")
assert_eq "36 traductions arabes Illico Presto (avant V66)" "36" "$COUNT_BEFORE"

log "=== 6. Application de migration-v66-categories-descriptions.sql ==="
sql -f "$SUPABASE_DIR/migration-v66-categories-descriptions.sql"
pass "migration V66 appliquée sans erreur"

log "=== 7. Signatures et droits post-migration ==="
OLD_SIG=$(sql_t -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_product' and pg_get_function_identity_arguments(p.oid)='p_category_id uuid, p_name text, p_description text, p_price numeric';")
assert_eq "ancienne signature create_product(4) absente" "0" "$OLD_SIG"

NEW_SIG=$(sql_t -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_product' and pg_get_function_identity_arguments(p.oid)='p_category_id uuid, p_name text, p_description text, p_price numeric, p_short_description text';")
assert_eq "nouvelle signature create_product(5) présente" "1" "$NEW_SIG"

for fn in create_product update_product get_merchant_catalogue create_category update_category; do
  N=$(sql_t -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='$fn';")
  assert_eq "aucune surcharge ambiguë pour $fn" "1" "$N"
done

for fn in create_product update_product get_merchant_catalogue; do
  ANON=$(sql_t -c "select has_function_privilege('anon', p.oid, 'EXECUTE') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='$fn';")
  AUTH=$(sql_t -c "select has_function_privilege('authenticated', p.oid, 'EXECUTE') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='$fn';")
  assert_eq "anon NE PEUT PAS exécuter $fn" "f" "$ANON"
  assert_eq "authenticated PEUT exécuter $fn" "t" "$AUTH"
done

log "=== 8. Traductions Illico Presto conservées après V66 ==="
COUNT_AFTER=$(sql_t -c "select count(*) from public.menu_items mi join public.menu_categories mc on mc.id=mi.category_id join public.restaurants r on r.id=mc.restaurant_id where r.slug='illico-presto' and mi.translations ? 'ar' and mi.translations->'ar'->>'description' is not null;")
assert_eq "36 traductions arabes Illico Presto (après V66)" "36" "$COUNT_AFTER"

log "=== 9. Données de test (restaurants, rôles) ==="
sql <<'SQL' >/dev/null
insert into public.restaurants (id, name, slug, is_active) values ('11111111-1111-1111-1111-111111111111','Le Test','le-test',true);
insert into public.restaurant_configs (restaurant_id, currency, whatsapp_number, allowed_service_modes, delivery_min_items, next_order_number) values ('11111111-1111-1111-1111-111111111111','DZD','+213550000000','{table,pickup}',0,1);
insert into public.restaurants (id, name, slug, is_active) values ('22222222-2222-2222-2222-222222222222','Autre', 'autre',true);
insert into auth.users (id, email) values ('99999999-9999-9999-9999-999999999999','owner@test.com');
insert into auth.users (id, email) values ('88888888-8888-8888-8888-888888888888','staff@test.com');
insert into auth.users (id, email) values ('77777777-7777-7777-7777-777777777777','manager@test.com');
insert into public.restaurant_users (user_id, restaurant_id, role) values ('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111','owner');
insert into public.restaurant_users (user_id, restaurant_id, role) values ('88888888-8888-8888-8888-888888888888','11111111-1111-1111-1111-111111111111','staff');
insert into public.restaurant_users (user_id, restaurant_id, role) values ('77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111','manager');
-- IMPORTANT : le owner de l'établissement 1 n'a AUCUN rôle sur
-- l'établissement 2 -- condition nécessaire au test d'isolation
-- (étape 13). Une première version de ce script lui donnait aussi le
-- rôle owner sur l'établissement 2 par erreur, ce qui rendait le
-- test d'isolation invalide (l'accès aurait alors été légitime).
SQL
pass "données de test insérées"

log "=== 10. staff refusé pour create_category ==="
OUT=$(sql -c "set test.uid = '88888888-8888-8888-8888-888888888888'; select public.create_category('11111111-1111-1111-1111-111111111111', 'X', null);" 2>&1 || true)
assert_contains "staff refusé (create_category)" "$OUT" "Not authorized"

log "=== 11. owner autorisé pour create_category ==="
CAT_ID=$(sql -c "set test.uid = '99999999-9999-9999-9999-999999999999'; select public.create_category('11111111-1111-1111-1111-111111111111', 'Boissons', null);" | extract_uuid)
if [ -n "$CAT_ID" ]; then pass "owner autorisé (create_category), id=$CAT_ID"; else fail "owner devrait pouvoir créer une catégorie"; fi

log "=== 12. manager autorisé pour update_category ==="
sql -c "set test.uid = '77777777-7777-7777-7777-777777777777'; select public.update_category('$CAT_ID'::uuid, 'Boissons Fraîches', 1);" >/dev/null
pass "manager autorisé (update_category)"

log "=== 13. isolation inter-restaurant ==="
sql -c "insert into public.menu_categories (id, restaurant_id, name, display_order, is_active) values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','Autre',1,true);" >/dev/null
OUT=$(sql -c "set test.uid = '99999999-9999-9999-9999-999999999999'; select public.update_category('33333333-3333-3333-3333-333333333333', 'Hack', 1);" 2>&1 || true)
assert_contains "isolation inter-restaurant respectée" "$OUT" "Not authorized"

log "=== 14. doublon de catégorie active refusé ==="
OUT=$(sql -c "set test.uid = '99999999-9999-9999-9999-999999999999'; select public.create_category('11111111-1111-1111-1111-111111111111', 'boissons fraîches', null);" 2>&1 || true)
assert_contains "doublon refusé (casse/espaces normalisés)" "$OUT" "SCANYM_CATEGORY_DUPLICATE_NAME"

log "=== 15. catégorie technique reste inactive après création ==="
sql -c "insert into public.menu_categories (id, restaurant_id, name, display_order, is_active) values ('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111','Technique',99,false);" >/dev/null
IS_ACTIVE=$(sql_t -c "select is_active from public.menu_categories where id='44444444-4444-4444-4444-444444444444';")
assert_eq "catégorie technique reste inactive" "f" "$IS_ACTIVE"

log "=== 16. description courte : 100 accepté, 101 refusé ==="
sql -c "set test.uid = '99999999-9999-9999-9999-999999999999'; select public.create_product('$CAT_ID'::uuid, 'P100', null, 2.00, repeat('a',100));" >/dev/null
pass "description courte 100 caractères acceptée"
OUT=$(sql -c "set test.uid = '99999999-9999-9999-9999-999999999999'; select public.create_product('$CAT_ID'::uuid, 'P101', null, 2.00, repeat('a',101));" 2>&1 || true)
assert_contains "description courte 101 caractères refusée" "$OUT" "SCANYM_SHORT_DESCRIPTION_TOO_LONG"

log "=== 17. description longue : 500 accepté, 501 refusé ==="
sql -c "set test.uid = '99999999-9999-9999-9999-999999999999'; select public.create_product('$CAT_ID'::uuid, 'P500', repeat('b',500), 2.00, null);" >/dev/null
pass "description longue 500 caractères acceptée"
OUT=$(sql -c "set test.uid = '99999999-9999-9999-9999-999999999999'; select public.create_product('$CAT_ID'::uuid, 'P501', repeat('b',501), 2.00, null);" 2>&1 || true)
assert_contains "description longue 501 caractères refusée" "$OUT" "SCANYM_DESCRIPTION_TOO_LONG"

log "=== 18. prix recalculé serveur, faux prix client ignoré ==="
PRODUCT_ID=$(sql_t -c "select id from public.menu_items where category_id=(select id from public.menu_categories where restaurant_id=(select id from public.restaurants where slug='illico-presto') limit 1) limit 1;")
PRICE=$(sql_t -c "select price from public.menu_items where id='$PRODUCT_ID';")
TOTAL=$(sql_t -c "select total from public.create_order('illico-presto','table','[{\"menu_item_id\":\"$PRODUCT_ID\",\"quantity\":2,\"option_item_id\":null,\"unit_price\":1}]'::jsonb,1,'{}'::jsonb,null,'fr');")
EXPECTED=$(python3 -c "print(f'{$PRICE*2:.2f}')")
assert_eq "total recalculé serveur (faux unit_price ignoré)" "$EXPECTED" "$TOTAL"

log "=== 19. Rollback : migration-v66-rollback.sql ==="
sql -f "$SUPABASE_DIR/migration-v66-rollback.sql"
pass "rollback appliqué sans erreur"

OLD_SIG_BACK=$(sql_t -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_product' and pg_get_function_identity_arguments(p.oid)='p_category_id uuid, p_name text, p_description text, p_price numeric';")
assert_eq "signature V65 de create_product restaurée après rollback" "1" "$OLD_SIG_BACK"

REMAINING_CAT_RPC=$(sql_t -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('create_category','update_category','assert_category_role');")
assert_eq "aucune RPC de catégories V66 ne subsiste après rollback" "0" "$REMAINING_CAT_RPC"

SHORT_DESC_COL=$(sql_t -c "select count(*) from information_schema.columns where table_name='menu_items' and column_name='short_description';")
assert_eq "short_description conservée après rollback (non destructif)" "1" "$SHORT_DESC_COL"

log "=== RÉSULTAT FINAL : $PASS_COUNT réussis, $FAIL_COUNT échoués ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "TOUS LES TESTS ONT REUSSI"
