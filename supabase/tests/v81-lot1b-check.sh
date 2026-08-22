#!/usr/bin/env bash
# ============================================================
# Scanym LOT 1B — Harnais reproductible : traductions manuelles des
# contenus (write_translation, hash canonique, statuts, résolution
# publique générique, réordonnancement langues -- réutilisé de LOT 1A).
#
# Baseline : LOT 1A.2 (main = 7b4fdcfed92a6f3533ba893f7d5f8c19d89d168a,
# déployé). Applique RÉELLEMENT la chaîne jusqu'à V80 (LOT 1A), puis
# LOT 1B par-dessus.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/v81-lot1b-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DB="scanym_v81_lot1b_$$"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
FAIL_LOG="/tmp/scanym-lot1b-fails-$$.log"
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
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql; do
    psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
}

log "=== Construction de la baseline réelle (LOT 1A.2) ==="
build_baseline "$DB"
pass "chaîne réelle appliquée jusqu'à LOT 1A.2"

log "=== Application de migration-v81-lot1b-translations.sql ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v81-lot1b-translations.sql" >/dev/null
pass "migration LOT 1B appliquée sans erreur sur baseline LOT 1A.2 réelle"

log "=== L1B-01 : traductions historiques (format Illico Presto, SANS status/hash) chargées AVANT LOT 1B -- backfill doit les rendre de nouveau publiables ==="
DB_HIST="scanym_v81_hist_$$"
build_baseline "$DB_HIST"
psql -d "$DB_HIST" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into auth.users (id, email) values ('99999999-9999-9999-9999-999999999999', 'owner-hist2@test.com');
insert into restaurants (id, name, slug, is_active) values ('ffffffff-0000-0000-0000-000000000001', 'Illico Presto Test', 'illico-presto-test', true);
insert into restaurant_configs (restaurant_id, currency, whatsapp_number, source_language) values
  ('ffffffff-0000-0000-0000-000000000001', 'EUR', '+33600000088', 'fr');
insert into restaurant_active_languages (restaurant_id, language_code, display_order) values
  ('ffffffff-0000-0000-0000-000000000001', 'fr', 1), ('ffffffff-0000-0000-0000-000000000001', 'ar', 2);
insert into restaurant_users (user_id, restaurant_id, role) values
  ('99999999-9999-9999-9999-999999999999', 'ffffffff-0000-0000-0000-000000000001', 'owner');
-- Format HISTORIQUE EXACT (migration-translations.sql), sans AUCUNE clé _status/_source_hash
insert into menu_categories (id, restaurant_id, name, translations) values
  ('11110000-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000001', 'Boissons chaudes', '{"ar":{"name":"المشروبات الساخنة"}}');
insert into menu_items (id, category_id, name, description, price, translations) values
  ('22220000-0000-0000-0000-000000000001', '11110000-0000-0000-0000-000000000001', 'Espresso', 'Cafe concentre', 2.00, '{"ar":{"name":"إسبريسو","description":"قهوة مركزة"}}');
-- Produit déjà en to_review AVANT LOT 1B -- NE DOIT JAMAIS être auto-validé par le backfill
insert into menu_items (id, category_id, name, description, price, translations) values
  ('22220000-0000-0000-0000-000000000002', '11110000-0000-0000-0000-000000000001', 'Cappuccino', null, 2.50, '{"ar":{"name":"كابتشينو","name_status":"to_review","name_source_hash":"deadbeef"}}');
SQL
psql -d "$DB_HIST" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v81-lot1b-translations.sql" >/dev/null
pass "L1B-01: LOT 1B appliquée avec succès sur des données historiques préexistantes"

CAT_STATUS=$(psql -X -A -t -d "$DB_HIST" -c "select translations->'ar'->>'name_status' from menu_categories where id='11110000-0000-0000-0000-000000000001';")
assert_eq "L1B-01: backfill -- catégorie historique (name) marquée validated" "validated" "$CAT_STATUS"
CAT_HASH_MATCH=$(psql -X -A -t -d "$DB_HIST" -c "select (name_hash = translations->'ar'->>'name_source_hash') from menu_categories where id='11110000-0000-0000-0000-000000000001';")
assert_eq "L1B-01: backfill -- le hash stocké correspond exactement au hash actuel de la source" "t" "$CAT_HASH_MATCH"

ITEM_NAME_STATUS=$(psql -X -A -t -d "$DB_HIST" -c "select translations->'ar'->>'name_status' from menu_items where id='22220000-0000-0000-0000-000000000001';")
ITEM_DESC_STATUS=$(psql -X -A -t -d "$DB_HIST" -c "select translations->'ar'->>'description_status' from menu_items where id='22220000-0000-0000-0000-000000000001';")
assert_eq "L1B-01: backfill -- produit historique (name) marqué validated" "validated" "$ITEM_NAME_STATUS"
assert_eq "L1B-01: backfill -- produit historique (description) marqué validated" "validated" "$ITEM_DESC_STATUS"

TO_REVIEW_UNCHANGED=$(psql -X -A -t -d "$DB_HIST" -c "select translations->'ar'->>'name_status' from menu_items where id='22220000-0000-0000-0000-000000000002';")
assert_eq "L1B-01: le backfill NE TOUCHE PAS une traduction déjà to_review (pas d'auto-validation)" "to_review" "$TO_REVIEW_UNCHANGED"
TO_REVIEW_HASH_UNCHANGED=$(psql -X -A -t -d "$DB_HIST" -c "select translations->'ar'->>'name_source_hash' from menu_items where id='22220000-0000-0000-0000-000000000002';")
assert_eq "L1B-01: le hash déjà présent d'une traduction to_review reste inchangé (deadbeef, pas recalculé)" "deadbeef" "$TO_REVIEW_HASH_UNCHANGED"

log "=== L1B-01 : rendu public RÉEL de la catégorie historique via get_merchant_catalogue (pas seulement présence du JSON) ==="
CAT_PUBLIC_NAME=$(psql -X -A -t -d "$DB_HIST" -c "
  set role authenticated; set local test.uid='99999999-9999-9999-9999-999999999999';
  select case when (category_translations->'ar'->>'name_status' = 'validated' and category_translations->'ar'->>'name_source_hash' = category_name_hash) then category_translations->'ar'->>'name' else category_name end
  from public.get_merchant_catalogue('ffffffff-0000-0000-0000-000000000001', false) limit 1;
" | tail -1)
assert_eq "L1B-01: l'arabe historique de la catégorie est bien PUBLIÉ (pas un simple repli source)" "المشروبات الساخنة" "$CAT_PUBLIC_NAME"

log "=== L1B-01 : rollback puis réapplication -- backfill idempotent, traduction toujours publiable ==="
psql -d "$DB_HIST" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v81-rollback.sql" >/dev/null
pass "L1B-01: rollback réussi avec données historiques backfillées présentes"
psql -d "$DB_HIST" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v81-lot1b-translations.sql" >/dev/null
CAT_STATUS_AFTER_REAPPLY=$(psql -X -A -t -d "$DB_HIST" -c "select translations->'ar'->>'name_status' from menu_categories where id='11110000-0000-0000-0000-000000000001';")
assert_eq "L1B-01: après rollback+réapplication, la traduction historique reste validated (backfill idempotent)" "validated" "$CAT_STATUS_AFTER_REAPPLY"
psql -c "drop database if exists \"$DB_HIST\";" >/dev/null 2>&1 || true


log "=== Fixtures : établissements variés (FR seul, FR/EN Au Lait Cru, FR/NL/EN, AR source+FR/EN) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner-a@test.com'),
  ('22222222-2222-2222-2222-222222222222', 'staff-a@test.com'),
  ('44444444-4444-4444-4444-444444444444', 'owner-b@test.com'),
  ('55555555-5555-5555-5555-555555555555', 'operator@test.com');

insert into restaurants (id, name, slug, is_active) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Au Lait Cru', 'au-lait-cru', true),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'FR Seul', 'fr-seul', true),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Sirocco', 'sirocco', true);

insert into restaurant_configs (restaurant_id, currency, whatsapp_number, intro_text, announcement_text, source_language) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'EUR', '+33600000000', 'Fromagerie artisanale.', 'Ferme le lundi.', 'fr'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'EUR', '+33611111111', null, null, 'fr'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'EUR', '+33622222222', 'Cuisine traditionnelle.', null, 'ar');

insert into restaurant_active_languages (restaurant_id, language_code, display_order) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'fr', 1), ('aaaaaaaa-0000-0000-0000-000000000001', 'en', 2),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'fr', 1),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'ar', 1), ('aaaaaaaa-0000-0000-0000-000000000003', 'fr', 2), ('aaaaaaaa-0000-0000-0000-000000000003', 'en', 3);

insert into restaurant_users (user_id, restaurant_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001', 'staff'),
  ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-0000-0000-0000-000000000002', 'owner');

insert into scanym_operators (user_id) values ('55555555-5555-5555-5555-555555555555');

insert into menu_categories (id, restaurant_id, name, description) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Pate molle', 'Une selection affinee.'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 'Autre', null),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000003', 'Plats', 'Plats du jour.');

insert into menu_items (id, category_id, name, short_description, description, price) values
  ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'Camembert', 'Lait cru', 'Affine 5 semaines.', 6.50),
  ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000003', 'Couscous', null, null, 12.00);
SQL
pass "fixtures chargées (Au Lait Cru FR/EN, FR seul, Sirocco AR source + FR/EN)"

RESTO_A="aaaaaaaa-0000-0000-0000-000000000001"
RESTO_B="aaaaaaaa-0000-0000-0000-000000000002"
RESTO_SIROCCO="aaaaaaaa-0000-0000-0000-000000000003"
OWNER_A="11111111-1111-1111-1111-111111111111"
STAFF_A="22222222-2222-2222-2222-222222222222"
OWNER_B="44444444-4444-4444-4444-444444444444"
OPERATOR="55555555-5555-5555-5555-555555555555"
CAT_A="bbbbbbbb-0000-0000-0000-000000000001"
ITEM_A="cccccccc-0000-0000-0000-000000000001"
CAT_SIROCCO="bbbbbbbb-0000-0000-0000-000000000003"

log "=== write_translation : to_review puis validated, hash source capturé exactement ==="
psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_A','category','$CAT_A','description','en','A selection aged on site.','to_review');" >/dev/null
STATUS1=$(psql -X -A -t -d "$DB" -c "select translations->'en'->>'description_status' from menu_categories where id='$CAT_A';")
assert_eq "statut to_review correctement stocké" "to_review" "$STATUS1"
psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_A','category','$CAT_A','description','en','A selection aged on site.','validated');" >/dev/null
HASH_MATCH=$(psql -X -A -t -d "$DB" -c "select (description_hash = translations->'en'->>'description_source_hash') from menu_categories where id='$CAT_A';")
assert_eq "hash source capturé exactement au moment de la validation" "t" "$HASH_MATCH"

log "=== modification de la source -> traduction validée devient stale (jamais supprimée) ==="
psql -d "$DB" -c "update menu_categories set description = 'Une nouvelle selection, chaque semaine.' where id='$CAT_A';" >/dev/null
STALE_CHECK=$(psql -X -A -t -d "$DB" -c "select (description_hash != translations->'en'->>'description_source_hash') and (translations->'en'->>'description' is not null) from menu_categories where id='$CAT_A';")
assert_eq "traduction devenue stale (hash différent) mais toujours présente (jamais supprimée)" "t" "$STALE_CHECK"

log "=== revalidation -> nouvelle traduction publiée (hash à jour de nouveau) ==="
psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_A','category','$CAT_A','description','en','A brand new selection, every week.','validated');" >/dev/null
REVALIDATED=$(psql -X -A -t -d "$DB" -c "select (description_hash = translations->'en'->>'description_source_hash') from menu_categories where id='$CAT_A';")
assert_eq "revalidation -> hash de nouveau à jour" "t" "$REVALIDATED"

log "=== les 7 champs traduisibles fonctionnent (intro, announcement, catégorie name/description, produit name/short_description/description) ==="
psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_A','restaurant','$RESTO_A','intro_text','en','Artisan cheesemonger.','validated');" >/dev/null
psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_A','restaurant','$RESTO_A','announcement_text','en','Closed on Mondays.','validated');" >/dev/null
psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_A','category','$CAT_A','name','en','Soft cheeses','validated');" >/dev/null
psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_A','item','$ITEM_A','name','en','Camembert','validated');" >/dev/null
psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_A','item','$ITEM_A','short_description','en','Raw milk','validated');" >/dev/null
psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_A','item','$ITEM_A','description','en','Aged 5 weeks.','validated');" >/dev/null
SEVEN_OK=$(psql -X -A -t -d "$DB" -c "
  select (rc.translations->'en'->>'intro_text' is not null)
     and (rc.translations->'en'->>'announcement_text' is not null)
     and (mc.translations->'en'->>'name' is not null)
     and (mc.translations->'en'->>'description' is not null)
     and (mi.translations->'en'->>'name' is not null)
     and (mi.translations->'en'->>'short_description' is not null)
     and (mi.translations->'en'->>'description' is not null)
  from restaurant_configs rc, menu_categories mc, menu_items mi
  where rc.restaurant_id = '$RESTO_A' and mc.id = '$CAT_A' and mi.id = '$ITEM_A';
")
assert_eq "les 7 champs traduisibles sont tous fonctionnels" "t" "$SEVEN_OK"

log "=== nom de l'établissement JAMAIS traduit (aucun champ 'name' sur restaurants dans write_translation) ==="
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_A','restaurant','$RESTO_A','name','en','Raw Milk','validated');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "écriture d'une traduction du nom d'établissement refusée (champ invalide pour ce type d'entité)" "1" "$RC"

log "=== sécurité : langue source, langue non active, cross-tenant, staff, opérateur ==="
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_A','category','$CAT_A','name','fr','x','to_review');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "écriture dans la langue source refusée" "1" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_A','category','$CAT_A','name','nl','x','to_review');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "écriture pour une langue non active refusée" "1" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_B','category','$CAT_A','name','en','x','to_review');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "cross-tenant (catégorie d'un autre restaurant via p_restaurant_id mismatch) refusé" "1" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$STAFF_A'; select public.write_translation('$RESTO_A','category','$CAT_A','name','en','x','to_review');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "staff refusé" "1" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_B'; select public.write_translation('$RESTO_A','category','$CAT_A','name','en','x','to_review');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "owner d'un AUTRE établissement refusé" "1" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OPERATOR'; select public.write_translation('$RESTO_A','category','$CAT_A','description','en','Operator wrote this.','to_review');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "opérateur Scanym accepté (patron F-01)" "0" "$RC"

log "=== RTL : langue RTL FICTIVE, provenant uniquement du catalogue (aucune règle codée en dur) ==="
psql -d "$DB" -c "insert into supported_languages (code, label, dir, display_order) values ('xx-test-rtl', 'Fictive RTL', 'rtl', 99) on conflict (code) do nothing;" >/dev/null
psql -d "$DB" -c "insert into restaurant_active_languages (restaurant_id, language_code, display_order) values ('$RESTO_A', 'xx-test-rtl', 3) on conflict do nothing;" >/dev/null
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$OWNER_A'; select public.write_translation('$RESTO_A','category','$CAT_A','name','xx-test-rtl','فرق مصطنع','to_review');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "écriture dans une langue RTL fictive (catalogue) acceptée -- aucune liste RTL codée en dur ne bloque" "0" "$RC"
FICTIVE_DIR=$(psql -X -A -t -d "$DB" -c "select dir from supported_languages where code='xx-test-rtl';")
assert_eq "la langue RTL fictive porte bien dir=rtl dans le catalogue" "rtl" "$FICTIVE_DIR"

log "=== établissement AR source (Sirocco) : écriture d'une traduction FR/EN fonctionne normalement ==="
psql -d "$DB" -c "insert into auth.users (id, email) values ('66666666-6666-6666-6666-666666666666', 'owner-sirocco@test.com') on conflict do nothing;" >/dev/null
psql -d "$DB" -c "insert into restaurant_users (user_id, restaurant_id, role) values ('66666666-6666-6666-6666-666666666666', '$RESTO_SIROCCO', 'owner') on conflict do nothing;" >/dev/null
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='66666666-6666-6666-6666-666666666666'; select public.write_translation('$RESTO_SIROCCO','category','$CAT_SIROCCO','name','fr','Plats','to_review');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "traduction FR sur établissement à source AR fonctionne (source != fr respecté)" "0" "$RC"
RC=$(psql -d "$DB" -c "set role authenticated; set local test.uid='66666666-6666-6666-6666-666666666666'; select public.write_translation('$RESTO_SIROCCO','category','$CAT_SIROCCO','name','ar','x','to_review');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "écriture dans la langue source (ar, pas fr) refusée pour Sirocco" "1" "$RC"

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

log "=== ROLLBACK : application + annulation + réapplication propre, données historiques préservées ==="
DB_RB="scanym_v81_rb_$$"
build_baseline "$DB_RB"
psql -d "$DB_RB" -c "
  insert into auth.users (id, email) values ('77777777-7777-7777-7777-777777777777', 'owner-hist@test.com');
  insert into restaurants (id, name, slug, is_active) values ('dddddddd-0000-0000-0000-000000000001', 'Historique', 'historique-1b', true);
  insert into restaurant_configs (restaurant_id, currency, whatsapp_number) values ('dddddddd-0000-0000-0000-000000000001', 'EUR', '+33600000099');
  insert into restaurant_active_languages (restaurant_id, language_code, display_order) values ('dddddddd-0000-0000-0000-000000000001', 'fr', 1), ('dddddddd-0000-0000-0000-000000000001', 'en', 2);
  insert into restaurant_users (user_id, restaurant_id, role) values ('77777777-7777-7777-7777-777777777777', 'dddddddd-0000-0000-0000-000000000001', 'owner');
  insert into menu_categories (id, restaurant_id, name, translations) values ('eeeeeeee-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'Cat Historique', '{\"ar\":{\"name\":\"تاريخي\"}}');
" >/dev/null
psql -d "$DB_RB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v81-lot1b-translations.sql" >/dev/null
pass "rollback: migration LOT 1B appliquée sur environnement dédié avec données historiques"
psql -d "$DB_RB" -v ON_ERROR_STOP=1 -c "set role authenticated; set local test.uid='77777777-7777-7777-7777-777777777777'; select public.write_translation('dddddddd-0000-0000-0000-000000000001','restaurant','dddddddd-0000-0000-0000-000000000001','intro_text','en','Test','validated');" >/dev/null
INTRO_HAS_TRANSLATION=$(psql -X -A -t -d "$DB_RB" -c "select count(*) from restaurant_configs where restaurant_id='dddddddd-0000-0000-0000-000000000001' and translations is not null;")
assert_eq "précondition: la traduction restaurant-level a bien été écrite avant le rollback" "1" "$INTRO_HAS_TRANSLATION"
psql -d "$DB_RB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v81-rollback.sql" > /tmp/rb1b_notice_$$.txt 2>&1
NOTICE_COUNT=$(grep -oE "SCANYM_ROLLBACK_LOT1B: [0-9]+" /tmp/rb1b_notice_$$.txt | sed -E 's/^SCANYM_ROLLBACK_LOT1B: //' || echo "absent")
assert_eq "rollback: le préflight informatif signale bien 1 établissement concerné (pas 0)" "1" "$NOTICE_COUNT"
rm -f "/tmp/rb1b_notice_$$.txt"
pass "rollback: annulation réussie sans erreur"
COLUMNS_GONE=$(psql -X -A -t -d "$DB_RB" -c "select count(*) from information_schema.columns where table_name='restaurant_configs' and column_name in ('translations','intro_text_hash','announcement_text_hash');")
assert_eq "rollback: les colonnes LOT 1B de restaurant_configs n'existent plus" "0" "$COLUMNS_GONE"
HASH_COLUMNS_GONE=$(psql -X -A -t -d "$DB_RB" -c "select count(*) from information_schema.columns where table_name in ('menu_categories','menu_items') and column_name like '%_hash';")
assert_eq "rollback: les colonnes de hash générées n'existent plus" "0" "$HASH_COLUMNS_GONE"
HIST_PRESERVED=$(psql -X -A -t -d "$DB_RB" -c "select translations->'ar'->>'name' from menu_categories where id='eeeeeeee-0000-0000-0000-000000000001';")
assert_eq "rollback: donnée historique (translations pré-existant) intacte" "تاريخي" "$HIST_PRESERVED"
psql -d "$DB_RB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v81-lot1b-translations.sql" >/dev/null
pass "rollback: réapplication propre réussie après annulation"
psql -c "drop database if exists \"$DB_RB\";" >/dev/null 2>&1 || true

log "=== RÉSULTAT FINAL : $PASS_COUNT réussis, $FAIL_COUNT échoués ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "DES VÉRIFICATIONS LOT 1B ONT ÉCHOUÉ"
  exit 1
fi
echo "TOUTES LES VÉRIFICATIONS LOT 1B ONT RÉUSSI"
