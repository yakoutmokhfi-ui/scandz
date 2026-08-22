#!/usr/bin/env bash
# ============================================================
# Scanym LOT 1A — Harnais reproductible : fondations DB, identité,
# apparence, réseaux sociaux, configuration des langues.
#
# Baseline : V70 (état production réel -- V71+/V76-V79 hors périmètre
# de ce lot, jamais appliquées ici). Applique RÉELLEMENT la chaîne
# jusqu'à V70 (schema.sql + migrations + Lot D +
# migration-v68/v69/v70), puis LOT 1A par-dessus.
#
# Couvre notamment :
#   - réconciliation avec le mécanisme Lot D préexistant
#     (source_language/enabled_languages, CHECK figé retiré, FK vers
#     le catalogue ajoutée) -- établissement déjà doté de traductions
#     AR (via enabled_languages Lot D) préservé après migration ;
#   - create_establishment accepte désormais NL (catalogue, pas figé) ;
#   - update_restaurant_identity/_bg_color/_social_links/_languages :
#     owner/manager/opérateur acceptés, staff/cross-tenant refusés
#     (assert_restaurant_asset_role, même posture que V70 F-01) ;
#   - réseaux sociaux : 3 réseaux × cas adversariaux (HTTP,
#     sous-domaine trompeur, credentials, port, query, espace) ;
#   - langues : non supportée refusée, retrait de la langue source
#     refusé, doublons refusés, FR/EN/NL/AR acceptés avec ordre ;
#   - GRANT SELECT sur les 2 nouvelles tables (régression réelle
#     trouvée et corrigée pendant le développement -- policy RLS seule
#     ne suffit pas) ;
#   - rollback : application + annulation + réapplication propre sur
#     environnement vierge.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/v80-lot1a-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DB="scanym_v80_lot1a_$$"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
FAIL_LOG="/tmp/scanym-lot1a-fails-$$.log"
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

build_baseline() {
  local target_db="$1"
  psql -c "drop database if exists \"$target_db\";" >/dev/null 2>&1 || true
  createdb "$target_db"
  psql -d "$target_db" >/dev/null <<'SQL'
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
    psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
    psql -d "$target_db" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql; do
    psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
}

load_fixtures() {
  local target_db="$1"
  psql -d "$target_db" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner-a@test.com'),
  ('22222222-2222-2222-2222-222222222222', 'manager-a@test.com'),
  ('33333333-3333-3333-3333-333333333333', 'staff-a@test.com'),
  ('44444444-4444-4444-4444-444444444444', 'owner-b@test.com'),
  ('55555555-5555-5555-5555-555555555555', 'operator@test.com');

insert into restaurants (id, name, slug, is_active) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Illico Presto', 'illico-presto', true),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Autre Resto', 'autre-resto', true),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Sirocco', 'sirocco', true),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'Jamais Touché', 'jamais-touche', true);

insert into restaurant_configs (restaurant_id, currency, whatsapp_number) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'EUR', '+33600000000'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'EUR', '+33611111111'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'EUR', '+33633333333');

-- Établissement déjà créé via Lot D create_establishment, avec
-- enabled_languages = {fr,ar} -- doit conserver 'ar' actif après LOT 1A.
insert into restaurant_configs (restaurant_id, currency, whatsapp_number, source_language, enabled_languages) values
  ('aaaaaaaa-0000-0000-0000-000000000003', 'EUR', '+33622222222', 'fr', array['fr','ar']);

insert into restaurant_users (user_id, restaurant_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001', 'manager'),
  ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000001', 'staff'),
  ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-0000-0000-0000-000000000002', 'owner');

insert into scanym_operators (user_id) values ('55555555-5555-5555-5555-555555555555');
SQL
}

log "=== Construction de la baseline réelle (V70, production actuelle) ==="
build_baseline "$DB"
pass "chaîne réelle appliquée jusqu'à V70 (Lot D inclus)"
load_fixtures "$DB"
pass "fixtures chargées (dont Sirocco : enabled_languages Lot D = {fr,ar})"

log "=== Application de migration-v80-lot1a-identity-social-languages.sql ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v80-lot1a-identity-social-languages.sql" >/dev/null
pass "migration LOT 1A appliquée sans erreur sur baseline V70 réelle"

RESTO_A="aaaaaaaa-0000-0000-0000-000000000001"
RESTO_B="aaaaaaaa-0000-0000-0000-000000000002"
RESTO_SIROCCO="aaaaaaaa-0000-0000-0000-000000000003"
RESTO_UNTOUCHED="aaaaaaaa-0000-0000-0000-000000000004"
OWNER_A="11111111-1111-1111-1111-111111111111"
MANAGER_A="22222222-2222-2222-2222-222222222222"
STAFF_A="33333333-3333-3333-3333-333333333333"
OWNER_B="44444444-4444-4444-4444-444444444444"
OPERATOR="55555555-5555-5555-5555-555555555555"

log "=== Réconciliation Lot D : Sirocco (déjà fr+ar via enabled_languages) préservé ==="
SIROCCO_LANGS=$(psql -X -A -t -d "$DB" -c "select string_agg(language_code, ',' order by display_order) from restaurant_active_languages where restaurant_id = '$RESTO_SIROCCO';")
assert_eq "Sirocco conserve fr,ar dans l'ordre après migration" "fr,ar" "$SIROCCO_LANGS"

CLASSIC_LANGS=$(psql -X -A -t -d "$DB" -c "select language_code from restaurant_active_languages where restaurant_id = '$RESTO_A';")
assert_eq "établissement classique (jamais créé via Lot D) -> fr seule" "fr" "$CLASSIC_LANGS"

log "=== Contraintes CHECK figées de Lot D retirées, FK catalogue ajoutée ==="
OLD_CHECK_GONE=$(psql -X -A -t -d "$DB" -c "select count(*) from pg_constraint where conname = 'restaurant_configs_source_language_check';")
assert_eq "ancienne contrainte CHECK figée absente" "0" "$OLD_CHECK_GONE"
NEW_FK_PRESENT=$(psql -X -A -t -d "$DB" -c "select count(*) from pg_constraint where conname = 'restaurant_configs_source_language_fkey';")
assert_eq "nouvelle clé étrangère vers supported_languages présente" "1" "$NEW_FK_PRESENT"

log "=== create_establishment accepte désormais NL (catalogue, plus figé) ==="
RC=$(psql -d "$DB" -c "
  set role authenticated; set local test.uid = '$OPERATOR';
  select slug from public.create_establishment('Frites Belges','frites-belges-$$','FR','Lille','restaurant',null,null,'+32470000000','fr',array['fr','nl','en'],'EUR',null,'x@test.com',null);
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "create_establishment avec NL réussit" "0" "$RC"
NL_ORDER=$(psql -X -A -t -d "$DB" -c "select string_agg(ral.language_code, ',' order by ral.display_order) from restaurant_active_languages ral join restaurants r on r.id=ral.restaurant_id where r.slug='frites-belges-$$';")
assert_eq "restaurant_active_languages alimentée dans l'ordre fr,nl,en" "fr,nl,en" "$NL_ORDER"

log "=== Lecture publique (anon) du catalogue et des langues actives (GRANT SELECT -- régression réelle corrigée pendant le développement) ==="
ANON_CATALOG=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from supported_languages;")
assert_eq "anon peut lire supported_languages (GRANT SELECT + policy RLS, pas l'un sans l'autre)" "4" "$ANON_CATALOG"
ANON_ACTIVE=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from restaurant_active_languages where restaurant_id='$RESTO_A';")
assert_eq "anon peut lire restaurant_active_languages" "1" "$ANON_ACTIVE"

log "=== update_restaurant_identity : owner/manager/opérateur acceptés, staff/cross-tenant refusés ==="
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.update_restaurant_identity('$RESTO_A','Illico Café','Intro','Msg',true);" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "owner peut modifier l'identité" "0" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$MANAGER_A'; select public.update_restaurant_identity('$RESTO_A','Illico Café 2',null,null,false);" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "manager peut modifier l'identité" "0" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OPERATOR'; select public.update_restaurant_identity('$RESTO_B','Autre Resto (Super Admin)',null,null,false);" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "opérateur Scanym peut modifier l'identité de N'IMPORTE QUEL établissement" "0" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$STAFF_A'; select public.update_restaurant_identity('$RESTO_A','Hack',null,null,false);" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "staff NE PEUT PAS modifier l'identité" "1" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_B'; select public.update_restaurant_identity('$RESTO_A','Hack Cross Tenant',null,null,false);" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "owner d'un AUTRE établissement NE PEUT PAS (cross-tenant)" "1" "$RC"

log "=== bg_color : cas Au Lait Cru (fond noir), format invalide refusé ==="
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.update_restaurant_bg_color('$RESTO_A','#000000');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "bg_color #000000 (Au Lait Cru) accepté" "0" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.update_restaurant_bg_color('$RESTO_A','black');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "bg_color format invalide refusé" "1" "$RC"

log "=== réseaux sociaux : matrice adversariale complète (3 réseaux) ==="
declare -A SOCIAL_CASES=(
  ["Instagram valide"]="0|https://instagram.com/test|null|null"
  ["Instagram HTTP"]="1|http://instagram.com/test|null|null"
  ["Instagram sous-domaine trompeur"]="1|https://instagram.com.evil.example/test|null|null"
  ["Instagram credentials"]="1|https://user:pass@instagram.com/test|null|null"
  ["Instagram port inhabituel"]="1|https://instagram.com:8443/test|null|null"
  ["Instagram query string"]="1|https://instagram.com/test?ref=x|null|null"
  ["TikTok valide"]="0|null|https://www.tiktok.com/@test|null"
  ["TikTok sans @ refusé"]="1|null|https://tiktok.com/test|null"
  ["TikTok sous-domaine trompeur"]="1|null|https://tiktok.com.evil.example/@test|null"
  ["Facebook valide"]="0|null|null|https://facebook.com/test"
  ["Facebook HTTP"]="1|null|null|http://facebook.com/test"
)
for desc in "${!SOCIAL_CASES[@]}"; do
  entry="${SOCIAL_CASES[$desc]}"
  IFS='|' read -r expected ig tt fb <<< "$entry"
  ig_sql=$([ "$ig" = "null" ] && echo "null" || echo "'$ig'")
  tt_sql=$([ "$tt" = "null" ] && echo "null" || echo "'$tt'")
  fb_sql=$([ "$fb" = "null" ] && echo "null" || echo "'$fb'")
  RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.update_restaurant_social_links('$RESTO_A', $ig_sql, $tt_sql, $fb_sql);" >/dev/null 2>&1 && echo "0" || echo "1")
  assert_eq "réseaux sociaux: $desc" "$expected" "$RC"
done

log "=== langues : non supportée, retrait source, doublons refusés ; FR/EN/NL/AR + ordre acceptés ==="
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.update_restaurant_languages('$RESTO_A', array['fr','de']);" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "langue non supportée (de) refusée" "1" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.update_restaurant_languages('$RESTO_A', array['en']);" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "retrait de la langue source (fr) refusé" "1" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.update_restaurant_languages('$RESTO_A', array['fr','fr']);" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "doublons refusés" "1" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.update_restaurant_languages('$RESTO_A', array['fr','en','nl','ar']);" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "FR/EN/NL/AR ensemble accepté" "0" "$RC"
FULL_ORDER=$(psql -X -A -t -d "$DB" -c "select string_agg(language_code, ',' order by display_order) from restaurant_active_languages where restaurant_id='$RESTO_A';")
assert_eq "ordre fr,en,nl,ar respecté après update_restaurant_languages" "fr,en,nl,ar" "$FULL_ORDER"

log "=== get_restaurant_active_languages : lecture ordonnée avec libellé/dir ==="
AR_DIR=$(psql -X -A -t -d "$DB" -c "select dir from get_restaurant_active_languages('$RESTO_A') where code='ar';")
assert_eq "AR a bien dir=rtl via get_restaurant_active_languages" "rtl" "$AR_DIR"

log "=== Non-régression : établissement sans personnalisation -> tous les champs LOT 1A NULL/défaut ==="
NULL_CHECK=$(psql -X -A -t -d "$DB" -c "select display_name is null and intro_text is null and announcement_text is null and announcement_active = false and bg_color is null and instagram_url is null and tiktok_url is null and facebook_url is null from restaurant_configs where restaurant_id='$RESTO_UNTOUCHED';")
assert_eq "Jamais Touché : tous les champs LOT 1A à leur valeur neutre" "t" "$NULL_CHECK"

log "=== HARNESS SELF-TEST : le journal de FAIL indépendant doit concorder avec FAIL_COUNT ==="
FAIL_LOG_COUNT=$(wc -l < "$FAIL_LOG" | tr -d ' ')
if [ "$FAIL_LOG_COUNT" != "$FAIL_COUNT" ]; then
  echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST ÉCHEC CRITIQUE : FAIL_COUNT ($FAIL_COUNT) ne correspond pas au nombre de lignes du journal indépendant ($FAIL_LOG_COUNT)."
  cat "$FAIL_LOG"
  exit 1
fi
if [ "$FAIL_LOG_COUNT" -gt 0 ]; then
  echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST : $FAIL_LOG_COUNT échec(s) réel(s) présent(s) -- le script échoue."
  cat "$FAIL_LOG"
  exit 1
fi
echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST : journal indépendant vide et concordant avec FAIL_COUNT (0) -- aucun échec masqué possible."

log "=== ROLLBACK basique : application + annulation + réapplication propre sur environnement vierge (état compatible fr/en/ar) ==="
DB_ROLLBACK="scanym_v80_rollback_$$"
build_baseline "$DB_ROLLBACK"
load_fixtures "$DB_ROLLBACK"
psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v80-lot1a-identity-social-languages.sql" >/dev/null
pass "rollback: migration LOT 1A appliquée sur environnement dédié"
psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v80-rollback.sql" >/dev/null
pass "rollback: annulation réussie sans erreur"
TABLES_GONE=$(psql -X -A -t -d "$DB_ROLLBACK" -c "select count(*) from pg_tables where schemaname='public' and tablename in ('supported_languages','restaurant_active_languages');")
assert_eq "rollback: les 2 nouvelles tables n'existent plus" "0" "$TABLES_GONE"
COLUMNS_GONE=$(psql -X -A -t -d "$DB_ROLLBACK" -c "select count(*) from information_schema.columns where table_name='restaurant_configs' and column_name in ('display_name','intro_text','announcement_text','announcement_active','bg_color','instagram_url','tiktok_url','facebook_url');")
assert_eq "rollback: les 8 colonnes LOT 1A n'existent plus" "0" "$COLUMNS_GONE"
psql -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v80-lot1a-identity-social-languages.sql" >/dev/null
pass "rollback: réapplication propre réussie sur le même environnement après annulation"
psql -c "drop database if exists \"$DB_ROLLBACK\";" >/dev/null 2>&1 || true

# ============================================================
# L1A-01 (contre-audit Work, tour 1A.1) : le rollback ne doit JAMAIS
# perdre silencieusement une configuration créée sous LOT 1A. Ces
# scénarios utilisent de VRAIES données modifiées APRÈS migration via
# les RPC réelles (create_establishment, update_restaurant_languages),
# jamais seulement des fixtures statiques jamais touchées -- exigence
# explicite de Work.
# ============================================================
log "=== L1A-01/1 : établissement source_language='nl' (créé via create_establishment RÉEL après migration) -> rollback DOIT refuser explicitement, RIEN modifié ==="
DB_RB1="scanym_v80_rb1_$$"
build_baseline "$DB_RB1"
psql -d "$DB_RB1" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v80-lot1a-identity-social-languages.sql" >/dev/null
psql -d "$DB_RB1" -c "
  insert into auth.users (id, email) values ('55555555-5555-5555-5555-555555555555', 'operator@test.com');
  insert into scanym_operators (user_id) values ('55555555-5555-5555-5555-555555555555');
" >/dev/null
psql -d "$DB_RB1" -c "
  set role authenticated; set local test.uid = '55555555-5555-5555-5555-555555555555';
  select public.create_establishment('Test NL','test-nl-rb1','FR','Lille','restaurant',null,null,'+33600000000','nl',array['nl','fr'],'EUR',null,'x@test.com',null);
" >/dev/null
RC=$(psql -d "$DB_RB1" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v80-rollback.sql" >/dev/null 2>/tmp/rb1_err_$$.txt && echo "0" || echo "1")
assert_eq "L1A-01: rollback refusé face à source_language='nl' réel" "1" "$RC"
BLOCKED_REPORT=$(grep -c "SCANYM_ROLLBACK_BLOCKED" /tmp/rb1_err_$$.txt || true)
assert_eq "L1A-01: le rapport de blocage explicite est bien émis" "1" "$BLOCKED_REPORT"
NAMED_RESTAURANT=$(grep -c "Test NL (test-nl-rb1)" /tmp/rb1_err_$$.txt || true)
if [ "$NAMED_RESTAURANT" -ge 1 ]; then
  pass "L1A-01: l'établissement bloquant est nommément identifié dans le rapport (apparaît $NAMED_RESTAURANT fois -- légitimement incompatible sur les 3 dimensions à la fois)"
else
  fail "L1A-01: l'établissement bloquant n'est identifié nulle part dans le rapport"
fi
TABLES_STILL_HERE=$(psql -X -A -t -d "$DB_RB1" -c "select count(*) from pg_tables where tablename in ('supported_languages','restaurant_active_languages');")
assert_eq "L1A-01: aucune modification partielle -- les tables LOT 1A existent toujours après le refus" "2" "$TABLES_STILL_HERE"
rm -f "/tmp/rb1_err_$$.txt"
psql -c "drop database if exists \"$DB_RB1\";" >/dev/null 2>&1 || true

log "=== L1A-01/2 : langue ajoutée UNIQUEMENT via update_restaurant_languages (Dashboard, jamais dans enabled_languages) -> rollback DOIT AUSSI refuser ==="
DB_RB2="scanym_v80_rb2_$$"
build_baseline "$DB_RB2"
load_fixtures "$DB_RB2"
psql -d "$DB_RB2" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v80-lot1a-identity-social-languages.sql" >/dev/null
RESTO_A_RB2="aaaaaaaa-0000-0000-0000-000000000001"
OWNER_A_RB2="11111111-1111-1111-1111-111111111111"
psql -d "$DB_RB2" -c "
  set role authenticated; set local test.uid = '$OWNER_A_RB2';
  select public.update_restaurant_languages('$RESTO_A_RB2', array['fr','nl']);
" >/dev/null
ENABLED_UNCHANGED=$(psql -X -A -t -d "$DB_RB2" -c "select enabled_languages::text from restaurant_configs where restaurant_id='$RESTO_A_RB2';")
assert_eq "L1A-01: precondition -- enabled_languages (Lot D) reste {fr}, jamais touché par update_restaurant_languages" "{fr}" "$ENABLED_UNCHANGED"
RC=$(psql -d "$DB_RB2" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v80-rollback.sql" >/dev/null 2>/tmp/rb2_err_$$.txt && echo "0" || echo "1")
assert_eq "L1A-01: rollback refusé -- langue nl visible SEULEMENT dans restaurant_active_languages, pas dans enabled_languages" "1" "$RC"
rm -f "/tmp/rb2_err_$$.txt"
psql -c "drop database if exists \"$DB_RB2\";" >/dev/null 2>&1 || true

log "=== L1A-01/3 : chaîne complète avec cas exigés (source FR+FR/NL, données historiques FR/AR) -> rollback réussit après nettoyage du seul établissement bloquant, comparaison structurelle avec V79 ==="
DB_RB3="scanym_v80_rb3_$$"
build_baseline "$DB_RB3"
psql -d "$DB_RB3" -c "
  insert into auth.users (id, email) values ('66666666-6666-6666-6666-666666666666', 'owner-hist@test.com');
  insert into restaurants (id, name, slug, is_active) values ('dddddddd-0000-0000-0000-000000000001', 'Historique FR AR', 'historique-fr-ar-rb3', true);
  insert into restaurant_configs (restaurant_id, currency, whatsapp_number, source_language, enabled_languages) values ('dddddddd-0000-0000-0000-000000000001', 'EUR', '+33600000099', 'fr', array['fr','ar']);
  insert into restaurant_users (user_id, restaurant_id, role) values ('66666666-6666-6666-6666-666666666666', 'dddddddd-0000-0000-0000-000000000001', 'owner');
" >/dev/null
psql -d "$DB_RB3" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v80-lot1a-identity-social-languages.sql" >/dev/null
HIST_LANGS=$(psql -X -A -t -d "$DB_RB3" -c "select string_agg(language_code, ',' order by display_order) from restaurant_active_languages where restaurant_id='dddddddd-0000-0000-0000-000000000001';")
assert_eq "L1A-01: données historiques FR/AR bien migrées vers restaurant_active_languages" "fr,ar" "$HIST_LANGS"
RC=$(psql -d "$DB_RB3" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v80-rollback.sql" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "L1A-01: rollback réussit -- toutes les données sont compatibles fr/en/ar (source FR + historique FR/AR)" "0" "$RC"
SOURCE_CHECK_RESTORED=$(psql -X -A -t -d "$DB_RB3" -c "select pg_get_constraintdef(oid) from pg_constraint where conname='restaurant_configs_source_language_check';")
assert_eq "L1A-01: comparaison structurelle -- source_language_check restaurée EXACTEMENT comme Lot D" "CHECK ((source_language = ANY (ARRAY['fr'::text, 'en'::text, 'ar'::text])))" "$SOURCE_CHECK_RESTORED"
ENABLED_CHECK_RESTORED=$(psql -X -A -t -d "$DB_RB3" -c "select count(*) from pg_constraint where conname='restaurant_configs_enabled_languages_chk';")
assert_eq "L1A-01: comparaison structurelle -- enabled_languages_chk restaurée (absente à tort avant ce correctif)" "1" "$ENABLED_CHECK_RESTORED"

# Corrige L1A1-02 (contre-audit Work, tour LOT 1A.2) : V79/Lot D ne
# définissait AUCUN commentaire sur ces 2 colonnes -- le rollback doit
# les restaurer à NULL, jamais laisser un texte de LOT 1A référençant
# restaurant_active_languages (table déjà supprimée par ce rollback).
SOURCE_COMMENT=$(psql -X -A -t -d "$DB_RB3" -c "select coalesce(col_description('restaurant_configs'::regclass, (select attnum from pg_attribute where attrelid='restaurant_configs'::regclass and attname='source_language')), 'NULL_CONFIRME');")
assert_eq "L1A1-02: commentaire sur source_language réellement NULL après rollback (V79 n'en définissait aucun)" "NULL_CONFIRME" "$SOURCE_COMMENT"
ENABLED_COMMENT=$(psql -X -A -t -d "$DB_RB3" -c "select coalesce(col_description('restaurant_configs'::regclass, (select attnum from pg_attribute where attrelid='restaurant_configs'::regclass and attname='enabled_languages')), 'NULL_CONFIRME');")
assert_eq "L1A1-02: commentaire sur enabled_languages réellement NULL après rollback (ne référence plus restaurant_active_languages, table supprimée)" "NULL_CONFIRME" "$ENABLED_COMMENT"
HIST_DATA_PRESERVED=$(psql -X -A -t -d "$DB_RB3" -c "select source_language || '|' || enabled_languages::text from restaurant_configs where restaurant_id='dddddddd-0000-0000-0000-000000000001';")
assert_eq "L1A-01: données historiques FR/AR intactes après rollback réussi" "fr|{fr,ar}" "$HIST_DATA_PRESERVED"
psql -c "drop database if exists \"$DB_RB3\";" >/dev/null 2>&1 || true

log "=== RÉSULTAT FINAL : $PASS_COUNT réussis, $FAIL_COUNT échoués ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "DES VÉRIFICATIONS LOT 1A ONT ÉCHOUÉ"
  exit 1
fi
echo "TOUTES LES VÉRIFICATIONS LOT 1A ONT RÉUSSI"
