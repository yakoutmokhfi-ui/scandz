#!/usr/bin/env bash
# ============================================================
# Scanym — CATALOGUE / SUBCATEGORIES v1.1 — REMEDIATION — harnais SQL
# réel (PostgreSQL réel, aucune simulation), exécuté en tant
# qu'utilisateur système postgres (authentification peer).
#
# Objet : prouver la fermeture des 3 findings de l'audit Work
# indépendant sur CATALOGUE / SUBCATEGORIES BACKOFFICE v1
# (candidat HEAD 9140e4c352a9ce2ca40be76e39c91e2b8ef2efaf) :
#   - CAT-SUB-V1-INTEGRITY-01 (HIGH)   -- immutabilité category_id
#   - CAT-SUB-V1-ACL-01       (MEDIUM) -- SELECT explicite
#   - CAT-SUB-V1-PUBLIC-GROUPING-01 (MEDIUM) -- correctif TypeScript
#     pur, aucune incidence SQL, testé séparément (voir
#     tests/v139-catalogue-public-grouping-order.test.ts et
#     tests/v138c-menuview-subcategories.dom.test.ts) -- non répété ici.
#
# Construit la MÊME chaîne complète que le harnais v1
# (catalogue-subcategories-backoffice-v1-check.sh), applique le lot v1,
# PUIS ce harnais :
#   [A] démontre D'ABORD que le bug CAT-SUB-V1-INTEGRITY-01 est réel
#       sur v1 SEUL (l'UPDATE direct de category_id RÉUSSIT) -- mandat
#       §8 : "demonstrate the bad UPDATE would have succeeded on v1
#       and now fails on v1.1" ;
#   [B] applique ENSUITE DRAFT-lot-catalogue-subcategories-backoffice-
#       v1-1-remediation.sql sur la MÊME base ;
#   [C] reprouve que le même UPDATE échoue désormais, sur une
#       sous-catégorie inutilisée ET sur une sous-catégorie utilisée,
#       en direct SQL ET sous service_role/bypassrls (tenant boundary
#       via SQL privilégié direct) ;
#   [D] prouve l'ACL explicite (anon/authenticated SELECT réussit,
#       restaurant inactif/tenant tiers masqués par RLS, écritures
#       toujours refusées).
# ============================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRAFT_SQL_V1="$SUPABASE_DIR/DRAFT-lot-catalogue-subcategories-backoffice-v1.sql"
DRAFT_SQL_V1_1="$SUPABASE_DIR/DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql"
DB="scanym_subcat_v11_$$"

PASS=0
FAIL=0
log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); log "FAIL: $1"; }

cleanup() {
  dropdb --if-exists "$DB" >/dev/null 2>&1
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-subcat-v11-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-subcat-v11-out-$$.txt 2>/tmp/scanym-subcat-v11-err-$$.txt; echo $?; }

as_authenticated() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    2>/tmp/scanym-subcat-v11-err-$$.txt
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-subcat-v11-out-$$.txt 2>/tmp/scanym-subcat-v11-err-$$.txt
  echo $?
}
as_anon() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-subcat-v11-err-$$.txt
}
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-subcat-v11-out-$$.txt 2>/tmp/scanym-subcat-v11-err-$$.txt
  echo $?
}
# service_role : rôle privilégié bypassrls -- prouve que le trigger
# d'immutabilité (Finding 1) s'applique MÊME quand RLS est
# entièrement contourné, contrairement à une policy RLS qui ne
# s'appliquerait jamais à ce rôle.
as_service_role_rc() {
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-subcat-v11-out-$$.txt 2>/tmp/scanym-subcat-v11-err-$$.txt
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
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-receipt-invoice-tax-detail-v1.sql" >/dev/null
}

seed_smoke_restaurant() {
  local dbname="$1"
  psql -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into public.restaurants (id, slug, name, is_active, status)
values ('11111111-1111-1111-1111-111111111111','subcat-v11-check','Subcat V11 Check', true, 'active');
insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number)
values ('11111111-1111-1111-1111-111111111111','EUR', 1, '+33600000000');
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config)
values
  ('11111111-1111-1111-1111-111111111111','delivery', true, '{"delivery_zone_prefixes": ["75"], "delivery_min_items": 0}'::jsonb),
  ('11111111-1111-1111-1111-111111111111','pickup', true, '{}'::jsonb),
  ('11111111-1111-1111-1111-111111111111','table', true, '{}'::jsonb);
insert into auth.users (id, email) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner@test.local');
insert into public.restaurant_users (restaurant_id, user_id, role)
values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');
-- Restaurant INACTIF (is_active=false) -- doit rester invisible pour anon.
insert into public.restaurants (id, slug, name, is_active, status)
values ('44444444-4444-4444-4444-444444444444','subcat-v11-inactive','Subcat V11 Inactive', false, 'active');
insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number)
values ('44444444-4444-4444-4444-444444444444','EUR', 1, '+33600000001');
-- Restaurant TIERS (autre tenant, NON encore public -- status
-- 'onboarding', is_active=true) -- ni la policy "publique" (exige
-- status='active') ni la policy "membre" (le propriétaire du
-- restaurant sous test n'y a aucun rôle) ne doivent laisser passer sa
-- sous-catégorie pour un commerçant tiers. Ne pas utiliser un
-- restaurant tiers status='active' ici : le catalogue public de ce
-- dépôt est délibérément visible à quiconque (y compris authenticated
-- non-membre) dès qu'un établissement est actif -- ce n'est PAS une
-- fuite, c'est la fonctionnalité "carte publique" elle-même (même
-- policy "to public" que menu_categories/menu_items). Le test
-- d'isolation tenant pertinent porte donc sur un établissement
-- tiers PAS ENCORE actif/public.
insert into public.restaurants (id, slug, name, is_active, status)
values ('55555555-5555-5555-5555-555555555555','subcat-v11-third-party','Subcat V11 Third Party', true, 'onboarding');
insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number)
values ('55555555-5555-5555-5555-555555555555','EUR', 1, '+33600000002');
insert into auth.users (id, email) values ('cccccccc-cccc-cccc-cccc-cccccccccccc','thirdparty@test.local');
insert into public.restaurant_users (restaurant_id, user_id, role)
values ('55555555-5555-5555-5555-555555555555','cccccccc-cccc-cccc-cccc-cccccccccccc','owner');
-- Catégorie "Fromages" (mandat, exemple canonique) sous test.
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','Fromages', true, 1);
-- Catégorie "Boissons".
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','Boissons', true, 2);
-- Catégorie du restaurant INACTIF -- ses sous-catégories ne doivent
-- jamais apparaître publiquement.
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('66666666-6666-6666-6666-666666666666','44444444-4444-4444-4444-444444444444','Cat Inactive Resto', true, 1);
-- Catégorie du restaurant TIERS.
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('77777777-7777-7777-7777-777777777777','55555555-5555-5555-5555-555555555555','Cat Tiers', true, 1);
SQL
}

OWNER_UID='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
OTHER_UID='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
THIRDPARTY_UID='cccccccc-cccc-cccc-cccc-cccccccccccc'
CAT_FROMAGES='22222222-2222-2222-2222-222222222222'
CAT_BOISSONS='33333333-3333-3333-3333-333333333333'
CAT_INACTIVE_RESTO='66666666-6666-6666-6666-666666666666'
CAT_TIERS='77777777-7777-7777-7777-777777777777'

# ============================================================
# [0] BASELINE -- chaîne complète jusqu'au HEAD réel + lot v1 SEUL
#     (v1.1 PAS ENCORE appliqué à ce stade -- requis pour [A]).
# ============================================================
log "=== [0] Construction baseline $DB (chaîne complète + lot v1 SEUL) ==="
createdb "$DB"
build_full_chain_before_lot "$DB"
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL_V1" >/tmp/scanym-subcat-v11-out-$$.txt 2>/tmp/scanym-subcat-v11-err-$$.txt; echo $?)
if [ "$RC" -eq 0 ]; then
  pass "Application propre du lot v1 (baseline requise pour v1.1)"
else
  fail "Application du lot v1 a échoué (rc=$RC) -- voir /tmp/scanym-subcat-v11-err-$$.txt"
  cat /tmp/scanym-subcat-v11-err-$$.txt
fi
seed_smoke_restaurant "$DB"

SUBCAT_UNUSED=$(as_authenticated "$OWNER_UID" "select create_subcategory('$CAT_FROMAGES','Chèvres');" | tr -d ' ')
[ -n "$SUBCAT_UNUSED" ] && pass "sous-catégorie 'Chèvres' créée (inutilisée à ce stade) (=$SUBCAT_UNUSED)" || fail "création de la sous-catégorie a échoué"

PID_CHAROLAIS=$(as_authenticated "$OWNER_UID" "select create_product('$CAT_FROMAGES','Charolais','Chèvre AOP',7.50,null,null,null,false,'$SUBCAT_UNUSED');" | tr -d ' ')
[ -n "$PID_CHAROLAIS" ] && pass "produit 'Charolais' rattaché à Chèvres (sous-catégorie désormais UTILISÉE)" || fail "rattachement du produit a échoué"

# ============================================================
# [A] PREUVE DU BUG -- mandat §8 : "demonstrate the bad UPDATE would
#     have succeeded on v1 and now fails on v1.1". Sur v1 SEUL
#     (v1.1 pas encore appliqué), un UPDATE direct de category_id doit
#     RÉUSSIR -- ceci est la preuve empirique que
#     CAT-SUB-V1-INTEGRITY-01 est un bug réel, pas une hypothèse.
# ============================================================
log "=== [A] Preuve du bug sur v1 SEUL (avant remédiation) ==="

RC=$(sql_rc "update public.menu_subcategories set category_id='$CAT_BOISSONS' where id='$SUBCAT_UNUSED';")
[ "$RC" -eq 0 ] && pass "BUG CONFIRMÉ (v1 seul) : UPDATE direct category_id RÉUSSIT sur une sous-catégorie UTILISÉE -- Charolais reste lié, incohérent" || fail "UPDATE category_id a échoué alors que le bug v1 devrait le permettre (=$RC) -- voir err : $(cat /tmp/scanym-subcat-v11-err-$$.txt)"

R=$(sql "select category_id from public.menu_subcategories where id='$SUBCAT_UNUSED';")
[ "$R" = "$CAT_BOISSONS" ] && pass "confirmation : Chèvres est maintenant rattachée à Boissons (incohérence réelle et persistée) (=$R)" || fail "category_id inattendu après le bug (=$R)"

R=$(sql "select category_id from public.menu_items where id='$PID_CHAROLAIS';")
[ "$R" = "$CAT_FROMAGES" ] && pass "confirmation du dégât : Charolais reste category_id=Fromages, mais pointe vers une sous-catégorie maintenant dans Boissons (incohérence structurelle démontrée) (=$R)" || fail "état du produit inattendu (=$R)"

# Remise en état AVANT d'appliquer v1.1 (retour à l'état sain, comme si
# le bug n'avait jamais été exploité -- v1.1 doit ensuite EMPÊCHER toute
# récidive).
sql "update public.menu_subcategories set category_id='$CAT_FROMAGES' where id='$SUBCAT_UNUSED';" >/dev/null
R=$(sql "select category_id from public.menu_subcategories where id='$SUBCAT_UNUSED';")
[ "$R" = "$CAT_FROMAGES" ] && pass "remise en état propre avant application de v1.1 (=$R)" || fail "remise en état a échoué (=$R)"

# ============================================================
# [B] APPLICATION DE LA REMÉDIATION v1.1 sur la MÊME base.
# ============================================================
log "=== [B] Application de DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql ==="

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL_V1_1" >/tmp/scanym-subcat-v11-out-$$.txt 2>/tmp/scanym-subcat-v11-err-$$.txt; echo $?)
if [ "$RC" -eq 0 ]; then
  pass "Application propre du lot v1.1 (remédiation) sur la base où le bug a été démontré"
else
  fail "Application du lot v1.1 a échoué (rc=$RC) -- voir err"
  cat /tmp/scanym-subcat-v11-err-$$.txt
fi

# ============================================================
# [C] CAT-SUB-V1-INTEGRITY-01 -- LE MÊME UPDATE ÉCHOUE MAINTENANT.
# ============================================================
log "=== [C] CAT-SUB-V1-INTEGRITY-01 -- immutabilité après remédiation ==="

# C1. Sous-catégorie UTILISÉE (Chèvres, avec Charolais) -- exactement
# le même UPDATE qu'en [A], doit maintenant échouer.
RC=$(sql_rc "update public.menu_subcategories set category_id='$CAT_BOISSONS' where id='$SUBCAT_UNUSED';")
[ "$RC" -ne 0 ] && pass "APRÈS v1.1 : le MÊME UPDATE category_id sur une sous-catégorie UTILISÉE échoue désormais (rc=$RC)" || fail "APRÈS v1.1 : l'UPDATE a réussi à tort (régression du correctif)"
grep -q "SCANYM_SUBCATEGORY_CATEGORY_IMMUTABLE" /tmp/scanym-subcat-v11-err-$$.txt && pass "message SCANYM_SUBCATEGORY_CATEGORY_IMMUTABLE explicite (sous-catégorie utilisée)" || fail "message d'erreur inattendu : $(cat /tmp/scanym-subcat-v11-err-$$.txt)"

R=$(sql "select category_id from public.menu_subcategories where id='$SUBCAT_UNUSED';")
[ "$R" = "$CAT_FROMAGES" ] && pass "category_id inchangé après le rejet (rollback de l'UPDATE lui-même) (=$R)" || fail "category_id a changé malgré le rejet (=$R)"

# C2. Sous-catégorie NON UTILISÉE (aucun produit) -- doit être refusée
# EXACTEMENT pareil (immutabilité = propriété de la ligne, pas
# seulement de ses lignes filles -- mandat explicite).
SUBCAT_EMPTY=$(as_authenticated "$OWNER_UID" "select create_subcategory('$CAT_FROMAGES','Pâtes pressées');" | tr -d ' ')
RC=$(sql_rc "update public.menu_subcategories set category_id='$CAT_BOISSONS' where id='$SUBCAT_EMPTY';")
[ "$RC" -ne 0 ] && pass "UPDATE category_id sur une sous-catégorie NON UTILISÉE échoue également (rc=$RC)" || fail "UPDATE a réussi sur une sous-catégorie non utilisée (régression)"
grep -q "SCANYM_SUBCATEGORY_CATEGORY_IMMUTABLE" /tmp/scanym-subcat-v11-err-$$.txt && pass "message explicite (sous-catégorie non utilisée)" || fail "message d'erreur inattendu (non utilisée)"

# C3. UPDATE vers la MÊME valeur (no-op logique) -- ne doit PAS être
# bloqué : le trigger compare `is distinct from`, un UPDATE qui ne
# change rien reste légitime (ex. un ORM qui réécrit toutes les
# colonnes sans changer category_id).
RC=$(sql_rc "update public.menu_subcategories set category_id='$CAT_FROMAGES' where id='$SUBCAT_EMPTY';")
[ "$RC" -eq 0 ] && pass "UPDATE vers la MÊME valeur de category_id reste autorisé (no-op logique, pas une réassignation) (rc=$RC)" || fail "UPDATE no-op a été bloqué à tort"

# C4. Défense en profondeur -- tentative sous service_role/bypassrls
# (rôle privilégié qui contourne TOUTES les policies RLS). Cette
# migration (comme toutes celles de ce dépôt, patron explicite/jamais
# implicite) n'accorde AUCUN privilège de table direct à service_role
# sur menu_subcategories -- un premier filet ("permission denied for
# table"), mais qui ne prouve rien sur LE TRIGGER lui-même. Pour isoler
# et démontrer spécifiquement que le trigger d'immutabilité -- pas
# seulement l'absence de GRANT -- est la protection réelle contre un
# accès privilégié/direct, on accorde ICI, dans le test uniquement
# (JAMAIS dans la migration), un GRANT UPDATE temporaire à service_role,
# puis on prouve que le trigger bloque quand même la réassignation, y
# compris sous un rôle bypassrls qui contourne RLS : la preuve que
# "tenant boundary cannot be broken through privileged/direct SQL" ne
# dépend donc JAMAIS de RLS ni d'un GRANT absent, mais du trigger
# lui-même, qui s'applique à toute ligne affectée quel que soit
# l'appelant.
# Le test accorde SELECT+UPDATE (une clause WHERE exige SELECT en plus
# d'UPDATE en PostgreSQL) -- sans quoi l'échec observé serait un simple
# "permission denied" antérieur à toute évaluation du trigger, ce qui
# ne prouverait rien sur le trigger lui-même.
sql "grant select, update on public.menu_subcategories to service_role;" >/dev/null
RC=$(as_service_role_rc "update public.menu_subcategories set category_id='$CAT_BOISSONS' where id='$SUBCAT_UNUSED';")
[ "$RC" -ne 0 ] && pass "service_role (bypassrls, MÊME avec un GRANT SELECT+UPDATE temporaire de test) ne peut PAS réassigner category_id -- le trigger n'est jamais soumis à RLS ni à son contournement (rc=$RC)" || fail "service_role a pu réassigner category_id -- faille de frontière tenant via SQL privilégié"
grep -q "SCANYM_SUBCATEGORY_CATEGORY_IMMUTABLE" /tmp/scanym-subcat-v11-err-$$.txt && pass "message explicite sous service_role également (le trigger, pas seulement l'absence de GRANT, est la protection)" || { fail "message d'erreur inattendu sous service_role"; cat /tmp/scanym-subcat-v11-err-$$.txt; }
sql "revoke select, update on public.menu_subcategories from service_role;" >/dev/null

# C5. Tentative de réassignation VERS UN AUTRE TENANT (restaurant
# tiers, via sa catégorie) -- doit échouer de façon identique, en SQL
# direct superutilisateur (aucune fenêtre de contournement).
RC=$(sql_rc "update public.menu_subcategories set category_id='$CAT_TIERS' where id='$SUBCAT_UNUSED';")
[ "$RC" -ne 0 ] && pass "réassignation vers la catégorie d'un AUTRE tenant (restaurant tiers) refusée (rc=$RC)" || fail "réassignation inter-tenant acceptée à tort -- faille de frontière tenant"

# C6. Concurrence/course : un UPDATE de category_id DANS une
# transaction explicite doit échouer AVANT tout commit -- démontre
# qu'il n'existe aucune fenêtre "vérifier puis écrire" exploitable
# (le trigger BEFORE UPDATE s'exécute dans la MÊME transaction que la
# tentative, jamais après ; un ROLLBACK explicite confirme qu'aucun
# état partiel n'a pu être observé par un tiers).
RC=$(sql_rc "begin; update public.menu_subcategories set category_id='$CAT_BOISSONS' where id='$SUBCAT_UNUSED'; commit;")
[ "$RC" -ne 0 ] && pass "UPDATE dans une transaction explicite échoue également avant tout commit (aucune fenêtre de course) (rc=$RC)" || fail "UPDATE en transaction explicite a réussi à tort"
R=$(sql "select category_id from public.menu_subcategories where id='$SUBCAT_UNUSED';")
[ "$R" = "$CAT_FROMAGES" ] && pass "aucun état intermédiaire n'a pu être persisté (category_id toujours Fromages) (=$R)" || fail "état incohérent détecté après la tentative en transaction (=$R)"

# C7. Cohérence produit/sous-catégorie/catégorie intacte après TOUTES
# ces tentatives échouées -- get_merchant_catalogue reste stable.
R=$(as_authenticated "$OWNER_UID" "select count(*) from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where category_id='$CAT_FROMAGES' and subcategory_id='$SUBCAT_UNUSED';")
[ "$R" = "1" ] && pass "get_merchant_catalogue : Charolais toujours correctement rattaché à Chèvres/Fromages après toutes les tentatives (=$R)" || fail "incohérence détectée dans get_merchant_catalogue après les tentatives (=$R)"

# C8. Les RPC create_subcategory/update_subcategory (qui ne touchent
# jamais category_id, cf. lecture du code v1) continuent de fonctionner
# normalement -- le trigger ne doit JAMAIS interférer avec l'usage
# légitime documenté au mandat.
RC=$(as_authenticated_rc "$OWNER_UID" "select update_subcategory('$SUBCAT_UNUSED','Chèvres AOP',9);")
[ "$RC" -eq 0 ] && pass "update_subcategory (renommage/ordre, ne touche jamais category_id) continue de fonctionner normalement" || fail "update_subcategory a été bloqué à tort par le nouveau trigger"

# ============================================================
# [D] CAT-SUB-V1-ACL-01 -- SELECT explicite anon/authenticated.
# ============================================================
log "=== [D] CAT-SUB-V1-ACL-01 -- ACL SELECT explicite ==="

# D1. Privilège de TABLE (pas seulement policy RLS) présent.
R=$(sql "select has_table_privilege('anon','public.menu_subcategories','SELECT');")
[ "$R" = "t" ] && pass "anon a désormais le privilège de TABLE SELECT explicite sur menu_subcategories (=$R)" || fail "anon n'a pas SELECT sur menu_subcategories (=$R)"
R=$(sql "select has_table_privilege('authenticated','public.menu_subcategories','SELECT');")
[ "$R" = "t" ] && pass "authenticated a désormais le privilège de TABLE SELECT explicite (=$R)" || fail "authenticated n'a pas SELECT (=$R)"

# D2. anon peut effectivement lire une sous-catégorie du restaurant
# actif via la requête publique (simulateur PostgREST : SELECT direct
# sous rôle anon, la policy RLS "lecture publique sous-categories
# actives" doit maintenant s'appliquer réellement, plus de "permission
# denied for table" en amont).
RC=$(as_anon_rc "select id from public.menu_subcategories where id='$SUBCAT_UNUSED';")
[ "$RC" -eq 0 ] && pass "anon : SELECT sur menu_subcategories du restaurant ACTIF s'exécute sans erreur (rc=$RC)" || fail "anon : SELECT échoue encore (rc=$RC) -- err : $(cat /tmp/scanym-subcat-v11-err-$$.txt)"
R=$(as_anon "select id from public.menu_subcategories where id='$SUBCAT_UNUSED';")
[ "$R" = "$SUBCAT_UNUSED" ] && pass "anon : la ligne autorisée est bien retournée, pas juste 'aucune erreur' (=$R)" || fail "anon : la ligne attendue n'a pas été retournée (=$R)"

# D3. authenticated (le propriétaire) peut lire également.
RC=$(as_authenticated_rc "$OWNER_UID" "select id from public.menu_subcategories where id='$SUBCAT_UNUSED';")
[ "$RC" -eq 0 ] && pass "authenticated (propriétaire) : SELECT réussit (rc=$RC)" || fail "authenticated : SELECT échoue (rc=$RC)"

# D4. Restaurant INACTIF (is_active=false) -- ses sous-catégories
# restent invisibles pour anon MALGRÉ le nouveau GRANT SELECT (le GRANT
# ouvre le privilège de TABLE, la policy RLS filtre toujours les
# LIGNES -- les deux mécanismes restent bien distincts et cumulatifs).
SUBCAT_INACTIVE=$(sql "insert into public.menu_subcategories (category_id, name, display_order) values ('$CAT_INACTIVE_RESTO','Cachée Resto Inactif',1) returning id;")
R=$(as_anon "select count(*) from public.menu_subcategories where id='$SUBCAT_INACTIVE';")
[ "$R" = "0" ] && pass "anon : sous-catégorie d'un restaurant INACTIF reste invisible malgré le GRANT SELECT (RLS toujours filtrante) (=$R)" || fail "anon a pu voir une sous-catégorie d'un restaurant inactif -- régression RLS (=$R)"

# D5. Restaurant TIERS (autre tenant, PAS ENCORE public --
# status='onboarding') -- ni la policy publique (exige status='active')
# ni la policy membre (aucun rôle du propriétaire testé sur ce
# restaurant) ne doivent laisser passer sa sous-catégorie. Ceci prouve
# l'isolation tenant en lecture authenticated pour un établissement
# réellement privé -- distinct de D4 (restaurant is_active=false) et
# distinct du cas "restaurant tiers mais déjà actif/public", qui EST
# légitimement visible de tous (carte publique, comportement voulu,
# jamais une fuite).
SUBCAT_TIERS=$(sql "insert into public.menu_subcategories (category_id, name, display_order) values ('$CAT_TIERS','Cachée Tenant Tiers',1) returning id;")
R=$(as_authenticated "$OWNER_UID" "select count(*) from public.menu_subcategories where id='$SUBCAT_TIERS';")
[ "$R" = "0" ] && pass "authenticated (propriétaire d'un AUTRE restaurant) : sous-catégorie d'un tenant tiers non-public reste invisible (=$R)" || fail "authenticated a pu voir une sous-catégorie d'un tenant tiers non-public -- fuite inter-tenant (=$R)"
R=$(as_anon "select count(*) from public.menu_subcategories where id='$SUBCAT_TIERS';")
[ "$R" = "0" ] && pass "anon : sous-catégorie d'un tenant tiers non-public (status onboarding) également invisible (=$R)" || fail "anon a pu voir une sous-catégorie d'un tenant tiers non-public (=$R)"

# D6. Écritures directes TOUJOURS refusées pour anon/authenticated
# (le GRANT SELECT n'a JAMAIS élargi les droits d'écriture -- ré-
# vérification explicite par verbe, comme exigé par le mandat).
RC=$(as_anon_rc "insert into public.menu_subcategories (category_id, name) values ('$CAT_FROMAGES','Anon Insert Post-ACL');")
[ "$RC" -ne 0 ] && pass "anon : INSERT toujours refusé après l'ajout du GRANT SELECT (rc=$RC)" || fail "anon a pu INSERT après le correctif ACL -- régression"
RC=$(as_anon_rc "update public.menu_subcategories set name='hack' where id='$SUBCAT_UNUSED';")
[ "$RC" -ne 0 ] && pass "anon : UPDATE toujours refusé après l'ajout du GRANT SELECT (rc=$RC)" || fail "anon a pu UPDATE après le correctif ACL -- régression"
RC=$(as_anon_rc "delete from public.menu_subcategories where id='$SUBCAT_UNUSED';")
[ "$RC" -ne 0 ] && pass "anon : DELETE toujours refusé après l'ajout du GRANT SELECT (rc=$RC)" || fail "anon a pu DELETE après le correctif ACL -- régression"

RC=$(as_authenticated_rc "$OTHER_UID" "insert into public.menu_subcategories (category_id, name) values ('$CAT_FROMAGES','Authenticated Non Autorisé Insert');")
[ "$RC" -ne 0 ] && pass "authenticated non autorisé : INSERT direct toujours refusé (rc=$RC)" || fail "authenticated non autorisé a pu INSERT directement -- régression"
RC=$(as_authenticated_rc "$OTHER_UID" "update public.menu_subcategories set name='hack' where id='$SUBCAT_UNUSED';")
[ "$RC" -ne 0 ] && pass "authenticated non autorisé : UPDATE direct toujours refusé (rc=$RC)" || fail "authenticated non autorisé a pu UPDATE directement -- régression"
RC=$(as_authenticated_rc "$THIRDPARTY_UID" "delete from public.menu_subcategories where id='$SUBCAT_UNUSED';")
[ "$RC" -ne 0 ] && pass "authenticated d'un tenant tiers : DELETE direct toujours refusé (rc=$RC)" || fail "authenticated tiers a pu DELETE directement -- régression"

# D7. anon n'a pas EXECUTE sur la nouvelle fonction trigger (aucune
# surface d'exécution directe accordée par erreur).
R=$(sql "select has_function_privilege('anon','public.enforce_menu_subcategory_category_immutable()','EXECUTE');")
[ "$R" = "f" ] && pass "anon n'a pas EXECUTE sur la fonction du trigger d'immutabilité (=$R)" || fail "anon a EXECUTE sur la fonction du trigger -- surface inattendue (=$R)"

# nettoyage des lignes de test ACL directement insérées (non via RPC)
sql "delete from public.menu_subcategories where id in ('$SUBCAT_INACTIVE','$SUBCAT_TIERS');" >/dev/null

# ============================================================
# [E] GARDE DE DÉRIVE -- v1.1 rejoué sur une base SANS le lot v1 doit
#     échouer explicitement (préflight signature).
# ============================================================
log "=== [E] Garde de dérive -- v1.1 sans v1 ==="

DB_NOV1="${DB}_nov1"
createdb "$DB_NOV1"
build_full_chain_before_lot "$DB_NOV1"
RC=$(psql -d "$DB_NOV1" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL_V1_1" >/tmp/scanym-subcat-v11-out-$$.txt 2>/tmp/scanym-subcat-v11-err-$$.txt; echo $?)
[ "$RC" -ne 0 ] && pass "application de v1.1 SANS v1 échoue explicitement (rc=$RC)" || fail "v1.1 s'est appliqué à tort sans v1"
grep -q "SCANYM_SCHEMA_DRIFT" /tmp/scanym-subcat-v11-err-$$.txt && pass "message SCANYM_SCHEMA_DRIFT explicite (v1.1 sans v1)" || fail "message d'erreur inattendu (v1.1 sans v1)"
dropdb --if-exists "$DB_NOV1" >/dev/null 2>&1

# ============================================================
# [F] DOUBLE APPLICATION DE v1.1 -- refusée explicitement.
# ============================================================
log "=== [F] Garde anti-double-application de v1.1 ==="

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL_V1_1" >/tmp/scanym-subcat-v11-out-$$.txt 2>/tmp/scanym-subcat-v11-err-$$.txt; echo $?)
[ "$RC" -ne 0 ] && pass "double application de v1.1 refusée explicitement (rc=$RC)" || fail "double application de v1.1 acceptée à tort"
grep -q "SCANYM_SCHEMA_DRIFT" /tmp/scanym-subcat-v11-err-$$.txt && pass "message de double-application v1.1 explicite" || fail "message de double-application v1.1 inattendu"

echo ""
echo "============================================================"
echo "RÉSUMÉ — CATALOGUE / SUBCATEGORIES v1.1 — REMEDIATION"
echo "  TOTAL PASS : $PASS"
echo "  TOTAL FAIL : $FAIL"
echo "============================================================"
rm -f /tmp/scanym-subcat-v11-out-$$.txt /tmp/scanym-subcat-v11-err-$$.txt
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
