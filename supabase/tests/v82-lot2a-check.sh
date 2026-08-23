#!/usr/bin/env bash
# ============================================================
# Scanym LOT 2A — Harnais reproductible : modes de vente génériques
# (catalogue extensible, configuration par établissement, champs
# client déclaratifs, adresse structurée, create_order redéfinie).
#
# Baseline : LOT 1B.2 (vrai main, 7b4fdcf...). Applique RÉELLEMENT
# la chaîne complète + les 3 seeds réels (illico-presto, sanaa-cookies,
# le-sirocco) + un établissement par défaut, puis LOT 2A par-dessus.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/v82-lot2a-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DB="scanym_v82_lot2a_$$"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
FAIL_LOG="/tmp/scanym-lot2a-fails-$$.log"
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
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
    psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
  psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-illico-v2.sql" >/dev/null 2>&1
  psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sanaa.sql" >/dev/null 2>&1
  psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sirocco-demo.sql" >/dev/null 2>&1
  psql -d "$target_db" -c "update restaurants set status='active';" >/dev/null 2>&1
  psql -d "$target_db" -c "
    insert into restaurants (id, name, slug, is_active, status) values ('99999999-0000-0000-0000-000000000001', 'Etablissement Par Defaut', 'etablissement-defaut', true, 'active');
    insert into restaurant_configs (restaurant_id, currency, whatsapp_number) values ('99999999-0000-0000-0000-000000000001', 'EUR', '+33600000099');
  " >/dev/null 2>&1
}

log "=== Construction de la baseline réelle (LOT 1B.2 + 3 seeds réels + établissement par défaut) ==="
build_baseline "$DB"
pass "chaîne réelle appliquée jusqu'à LOT 1B.2, avec les 3 établissements réels + 1 par défaut"

log "=== Application de migration-v82-lot2a-sale-modes.sql ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
pass "migration LOT 2A appliquée sans erreur sur baseline réelle (3 établissements + défaut)"

log "=== Backfill : les 4 cas exacts (audités, pas supposés) ==="
ILLICO_MODES=$(psql -X -A -t -d "$DB" -c "select string_agg(rsm.mode_code, ',' order by rsm.display_order) from restaurant_sale_modes rsm join restaurants r on r.id=rsm.restaurant_id where r.slug='illico-presto';")
assert_eq "illico-presto : table+pickup" "table,pickup" "$ILLICO_MODES"

SANAA_MODES=$(psql -X -A -t -d "$DB" -c "select string_agg(rsm.mode_code, ',' order by rsm.display_order) from restaurant_sale_modes rsm join restaurants r on r.id=rsm.restaurant_id where r.slug='sanaa-cookies';")
assert_eq "sanaa-cookies : pickup+delivery (PAS table)" "pickup,delivery" "$SANAA_MODES"

SIROCCO_MODES=$(psql -X -A -t -d "$DB" -c "select string_agg(rsm.mode_code, ',' order by rsm.display_order) from restaurant_sale_modes rsm join restaurants r on r.id=rsm.restaurant_id where r.slug='le-sirocco';")
assert_eq "le-sirocco : table seul" "table" "$SIROCCO_MODES"

DEFAULT_MODES=$(psql -X -A -t -d "$DB" -c "select string_agg(mode_code, ',') from restaurant_sale_modes where restaurant_id='99999999-0000-0000-0000-000000000001';")
assert_eq "établissement par défaut (onboarding standard) : table seul" "table" "$DEFAULT_MODES"

SIROCCO_OVERRIDES=$(psql -X -A -t -d "$DB" -c "select count(*) from restaurant_sale_mode_field_requirements o join restaurants r on r.id=o.restaurant_id where r.slug='le-sirocco';")
assert_eq "le-sirocco : aucune surcharge (comportement catalogue par défaut déjà correct)" "0" "$SIROCCO_OVERRIDES"

log "=== create_order : les 4 cas de champs requis (illico nom seul, sanaa strict, catalogue défaut, room service) ==="
ILLICO_ITEM=$(psql -X -A -t -d "$DB" -c "select mi.id from menu_items mi join menu_categories mc on mc.id=mi.category_id join restaurants r on r.id=mc.restaurant_id where r.slug='illico-presto' and mi.is_available and mc.is_active limit 1;")
SANAA_ITEM=$(psql -X -A -t -d "$DB" -c "select mi.id from menu_items mi join menu_categories mc on mc.id=mi.category_id join restaurants r on r.id=mc.restaurant_id where r.slug='sanaa-cookies' and mi.is_available and mc.is_active limit 1;")

RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'pickup', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Karim\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "illico-presto pickup: nom SEUL accepté (surcharge)" "0" "$RC"

RC=$(psql -d "$DB" -c "select public.create_order('sanaa-cookies', 'pickup', '[{\"menu_item_id\":\"$SANAA_ITEM\",\"quantity\":10}]'::jsonb, null, '{\"name\":\"Yakout\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "sanaa-cookies pickup: nom SEUL refusé (surcharge exige tout)" "1" "$RC"
RC=$(psql -d "$DB" -c "select public.create_order('sanaa-cookies', 'pickup', '[{\"menu_item_id\":\"$SANAA_ITEM\",\"quantity\":10}]'::jsonb, null, '{\"name\":\"Yakout\",\"phone\":\"0612345678\",\"email\":\"y@test.com\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "sanaa-cookies pickup: nom+téléphone+email accepté" "0" "$RC"

RC=$(psql -d "$DB" -c "select public.create_order('sanaa-cookies', 'delivery', '[{\"menu_item_id\":\"$SANAA_ITEM\",\"quantity\":10}]'::jsonb, null, '{\"name\":\"Yakout\",\"address\":\"10 rue de Paris, 75001 Paris\",\"phone\":\"0612345678\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "sanaa-cookies delivery: sans email refusé (surcharge exige aussi email)" "1" "$RC"
RC=$(psql -d "$DB" -c "select order_number from public.create_order('sanaa-cookies', 'delivery', '[{\"menu_item_id\":\"$SANAA_ITEM\",\"quantity\":10}]'::jsonb, null, '{\"name\":\"Yakout\",\"address\":\"10 rue de Paris, 75001 Paris\",\"phone\":\"0612345678\",\"email\":\"y@test.com\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "sanaa-cookies delivery: tous champs + zone valide + min articles accepté" "0" "$RC"

log "=== adresse structurée alimentée en parallèle de l'historique, jamais désynchronisée ==="
ADDR_MATCH=$(psql -X -A -t -d "$DB" -c "select (o.delivery_address = oda.formatted_address) from orders o join order_delivery_address oda on oda.order_id=o.id join restaurants r on r.id=o.restaurant_id where r.slug='sanaa-cookies' and o.service_mode='delivery' order by o.created_at desc limit 1;")
assert_eq "adresse structurée = adresse historique (une seule vérité par commande)" "t" "$ADDR_MATCH"

log "=== zone/minimum d'articles toujours appliqués (comportement historique préservé) ==="
RC=$(psql -d "$DB" -c "select public.create_order('sanaa-cookies', 'delivery', '[{\"menu_item_id\":\"$SANAA_ITEM\",\"quantity\":10}]'::jsonb, null, '{\"name\":\"X\",\"address\":\"1 rue X, 12345 Ailleurs\",\"phone\":\"0600000000\",\"email\":\"x@test.com\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "zone hors périmètre refusée" "1" "$RC"
RC=$(psql -d "$DB" -c "select public.create_order('sanaa-cookies', 'delivery', '[{\"menu_item_id\":\"$SANAA_ITEM\",\"quantity\":2}]'::jsonb, null, '{\"name\":\"X\",\"address\":\"1 rue X, 75001 Paris\",\"phone\":\"0600000000\",\"email\":\"x@test.com\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "sous le minimum d'articles refusé" "1" "$RC"

log "=== nouveaux modes catalogue : Click & Collect (one_of) et Room Service (activés à la volée pour test) ==="
psql -d "$DB" -c "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order) select id, 'click_collect', true, 3 from restaurants where slug='illico-presto';" >/dev/null
psql -d "$DB" -c "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order) select id, 'room_service', true, 4 from restaurants where slug='illico-presto' on conflict do nothing;" >/dev/null

RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'click_collect', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Sam\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "Click & Collect: nom+téléphone (sans email) accepté" "0" "$RC"
RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'click_collect', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Sam\",\"email\":\"sam@test.com\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "Click & Collect: nom+email (sans téléphone) accepté" "0" "$RC"
RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'click_collect', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Sam\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "Click & Collect: ni téléphone ni email refusé" "1" "$RC"

RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'room_service', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"X\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "room service sans numéro de chambre refusé" "1" "$RC"
RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'room_service', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"X\",\"room_number\":\"305\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "room service avec numéro de chambre accepté" "0" "$RC"

log "=== mode non activé pour l'établissement -> refusé (isolation par établissement) ==="
RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'delivery', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"X\",\"address\":\"1 rue X, 75001 Paris\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "mode delivery non activé pour illico-presto refusé" "1" "$RC"

log "=== non-régression : table/pickup toujours fonctionnels après tous les changements ==="
RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'table', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, 5, '{}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "table avec numéro toujours acceptée (non-régression)" "0" "$RC"
RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'table', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "table sans numéro toujours refusée (non-régression)" "1" "$RC"

log "=== L2A1-01 (contre-audit Work 2e tour) : catalogue global reste public, tables tenant deviennent STRICTEMENT privées ==="
ANON_CATALOG=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from sale_mode_catalog;")
assert_eq "anon peut lire sale_mode_catalog (référence globale, jamais privée)" "5" "$ANON_CATALOG"
ANON_MODES_DIRECT=$(PGOPTIONS='-c role=anon' psql -d "$DB" -c "select count(*) from restaurant_sale_modes;" 2>&1 | grep -c "permission denied" || true)
assert_eq "anon NE PEUT PLUS lire restaurant_sale_modes directement (permission denied, plus de USING (true))" "1" "$ANON_MODES_DIRECT"
ANON_REQS_DIRECT=$(PGOPTIONS='-c role=anon' psql -d "$DB" -c "select count(*) from restaurant_sale_mode_field_requirements;" 2>&1 | grep -c "permission denied" || true)
assert_eq "anon NE PEUT PLUS lire restaurant_sale_mode_field_requirements directement" "1" "$ANON_REQS_DIRECT"

log "=== catalogue : aucun mode supprimé physiquement, jamais ==="
CATALOG_HAS_NO_DELETE=$(grep -c "delete from public.sale_mode_catalog\|drop.*sale_mode_catalog" "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" || true)
assert_eq "aucune instruction DELETE/DROP sur le catalogue dans la migration forward" "0" "$CATALOG_HAS_NO_DELETE"

log "=== L2A-01 : éligibilité établissement (is_active=true AND status='active', protection Lot D restaurée) ==="
RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'table', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, 5, '{}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "établissement actif -> accepté" "0" "$RC"
psql -d "$DB" -c "update restaurants set status='onboarding' where slug='illico-presto';" >/dev/null
RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'table', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, 5, '{}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "établissement onboarding -> refusé" "1" "$RC"
psql -d "$DB" -c "update restaurants set status='suspended' where slug='illico-presto';" >/dev/null
RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'table', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, 5, '{}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "établissement suspendu -> refusé" "1" "$RC"
psql -d "$DB" -c "update restaurants set status='active', is_active=false where slug='illico-presto';" >/dev/null
RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'table', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, 5, '{}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "établissement is_active=false -> refusé" "1" "$RC"
psql -d "$DB" -c "update restaurants set is_active=true where slug='illico-presto';" >/dev/null

log "=== L2A-01 : longueur de note (protection V65 restaurée, rejet explicite, jamais de troncature silencieuse) ==="
NOTE500=$(python3 -c "print('a'*500)")
NOTE501=$(python3 -c "print('a'*501)")
RC=$(psql -d "$DB" -c "select order_number from public.create_order('illico-presto', 'table', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, 6, '{}'::jsonb, '$NOTE500', 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "note de 500 caractères acceptée" "0" "$RC"
ERR_501=$(psql -d "$DB" -c "select order_number from public.create_order('illico-presto', 'table', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, 6, '{}'::jsonb, '$NOTE501', 'fr');" 2>&1 | grep -c "SCANYM_ORDER_NOTE_TOO_LONG" || true)
assert_eq "note de 501 caractères refusée avec SCANYM_ORDER_NOTE_TOO_LONG (pas une troncature silencieuse)" "1" "$ERR_501"

log "=== L2A-02 : room_number VALIDÉ ET RÉELLEMENT PERSISTÉ (pas seulement validé) ==="
psql -d "$DB" -c "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order) select id, 'room_service', true, 4 from restaurants where slug='illico-presto' on conflict do nothing;" >/dev/null
psql -d "$DB" -c "select public.create_order('illico-presto', 'room_service', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"X\",\"room_number\":\"305\"}'::jsonb, null, 'fr');" >/dev/null
PERSISTED_ROOM=$(psql -X -A -t -d "$DB" -c "select room_number from orders where service_mode='room_service' order by created_at desc limit 1;")
assert_eq "room_number '305' réellement récupérable après create_order (pas seulement validé)" "305" "$PERSISTED_ROOM"

log "=== L2A1-01 : contrat tenant strictement respecté -- membre A ne lit JAMAIS B, même actif ==="
MEMBER_A_ID="11111111-1111-1111-1111-111111111111"
psql -d "$DB" -c "insert into auth.users (id, email) values ('$MEMBER_A_ID', 'member-a@test.com') on conflict do nothing;" >/dev/null
psql -d "$DB" -c "insert into restaurant_users (user_id, restaurant_id, role) select '$MEMBER_A_ID', id, 'owner' from restaurants where slug='illico-presto' on conflict do nothing;" >/dev/null
psql -d "$DB" -c "update restaurants set status='onboarding' where slug='illico-presto';" >/dev/null
MEMBER_A_READS_A=$(psql -X -A -t -d "$DB" -c "set role authenticated; set local test.uid='$MEMBER_A_ID'; select count(*) from restaurant_sale_modes where restaurant_id=(select id from restaurants where slug='illico-presto');" | tail -1)
assert_eq "membre A peut lire A même en onboarding (appartenance réelle)" "4" "$MEMBER_A_READS_A"
psql -d "$DB" -c "update restaurants set status='active' where slug='illico-presto';" >/dev/null

MEMBER_B_ID="33333333-3333-3333-3333-333333333333"
psql -d "$DB" -c "insert into auth.users (id, email) values ('$MEMBER_B_ID', 'member-b@test.com') on conflict do nothing;" >/dev/null
psql -d "$DB" -c "insert into restaurant_users (user_id, restaurant_id, role) select '$MEMBER_B_ID', id, 'owner' from restaurants where slug='sanaa-cookies' on conflict do nothing;" >/dev/null

MEMBER_A_READS_B=$(psql -X -A -t -d "$DB" -c "set role authenticated; set local test.uid='$MEMBER_A_ID'; select count(*) from restaurant_sale_modes where restaurant_id=(select id from restaurants where slug='sanaa-cookies');" | tail -1)
assert_eq "membre A lisant B (actif) -> ZÉRO ligne, jamais un accès cross-tenant (corrige L2A1-01)" "0" "$MEMBER_A_READS_B"
MEMBER_B_READS_B=$(psql -X -A -t -d "$DB" -c "set role authenticated; set local test.uid='$MEMBER_B_ID'; select count(*) from restaurant_sale_modes where restaurant_id=(select id from restaurants where slug='sanaa-cookies');" | tail -1)
assert_eq "membre B peut lire B (appartenance réelle)" "2" "$MEMBER_B_READS_B"
MEMBER_B_READS_A=$(psql -X -A -t -d "$DB" -c "set role authenticated; set local test.uid='$MEMBER_B_ID'; select count(*) from restaurant_sale_modes where restaurant_id=(select id from restaurants where slug='illico-presto');" | tail -1)
assert_eq "membre B lisant A -> ZÉRO ligne (symétrique)" "0" "$MEMBER_B_READS_A"

UNAFFILIATED_ID="22222222-2222-2222-2222-222222222222"
psql -d "$DB" -c "insert into auth.users (id, email) values ('$UNAFFILIATED_ID', 'unaffiliated@test.com') on conflict do nothing;" >/dev/null
UNAFFILIATED_READS_A=$(psql -X -A -t -d "$DB" -c "set role authenticated; set local test.uid='$UNAFFILIATED_ID'; select count(*) from restaurant_sale_modes where restaurant_id=(select id from restaurants where slug='illico-presto');" | tail -1)
assert_eq "utilisateur authentifié SANS appartenance -> ne peut lire aucun établissement (A)" "0" "$UNAFFILIATED_READS_A"
UNAFFILIATED_READS_B=$(psql -X -A -t -d "$DB" -c "set role authenticated; set local test.uid='$UNAFFILIATED_ID'; select count(*) from restaurant_sale_modes where restaurant_id=(select id from restaurants where slug='sanaa-cookies');" | tail -1)
assert_eq "utilisateur authentifié SANS appartenance -> ne peut lire aucun établissement (B)" "0" "$UNAFFILIATED_READS_B"

log "=== L2A1-01 : projection publique minimale (get_restaurant_public_sale_modes) -- jamais un accès direct à la table ==="
ILLICO_ID=$(psql -X -A -t -d "$DB" -c "select id from restaurants where slug='illico-presto';")
PUB_ACTIVE=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_sale_modes('$ILLICO_ID');")
assert_eq "anon + établissement actif -> projection publique retourne des données" "4" "$PUB_ACTIVE"
psql -d "$DB" -c "update restaurants set status='onboarding' where slug='illico-presto';" >/dev/null
PUB_ONBOARDING=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_sale_modes('$ILLICO_ID');")
assert_eq "anon + onboarding -> projection publique vide" "0" "$PUB_ONBOARDING"
psql -d "$DB" -c "update restaurants set status='suspended' where slug='illico-presto';" >/dev/null
PUB_SUSPENDED=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_sale_modes('$ILLICO_ID');")
assert_eq "anon + suspendu -> projection publique vide" "0" "$PUB_SUSPENDED"
psql -d "$DB" -c "update restaurants set status='active', is_active=false where slug='illico-presto';" >/dev/null
PUB_INACTIVE=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_sale_modes('$ILLICO_ID');")
assert_eq "anon + inactif -> projection publique vide" "0" "$PUB_INACTIVE"
psql -d "$DB" -c "update restaurants set is_active=true, status='active' where slug='illico-presto';" >/dev/null

log "=== L2A1-01 : projection publique n'expose JAMAIS provider ni config JSONB interne ==="
PROJECTION_HAS_NO_PROVIDER=$(grep -A 12 "create function public.get_restaurant_public_sale_modes" "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" | grep -c "provider\|config " || true)
assert_eq "la projection publique n'expose ni provider ni config JSONB brut" "0" "$PROJECTION_HAS_NO_PROVIDER"

log "=== L2A2-01 (contre-audit Work, 3e tour) : le helper interne est désormais TOTALEMENT inaccessible directement -- anon, membre, non-affilié, tous refusés ==="
BYPASS_ANON=$(PGOPTIONS='-c role=anon' psql -d "$DB" -c "select * from public.effective_sale_mode_field_requirements('$ILLICO_ID', 'pickup');" 2>&1 | grep -c "permission denied" || true)
assert_eq "anon ne peut pas appeler directement effective_sale_mode_field_requirements" "1" "$BYPASS_ANON"

MEMBER_A_ID2="44444444-4444-4444-4444-444444444444"
psql -d "$DB" -c "insert into auth.users (id, email) values ('$MEMBER_A_ID2', 'member-a2@test.com') on conflict do nothing;" >/dev/null
psql -d "$DB" -c "insert into restaurant_users (user_id, restaurant_id, role) select '$MEMBER_A_ID2', id, 'owner' from restaurants where slug='illico-presto' on conflict do nothing;" >/dev/null
BYPASS_MEMBER_A_FOR_A=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$MEMBER_A_ID2'; select * from public.effective_sale_mode_field_requirements('$ILLICO_ID', 'pickup');" 2>&1 | grep -c "permission denied" || true)
assert_eq "membre A appelant le helper pour SON PROPRE établissement A -> refusé quand même (aucune exception)" "1" "$BYPASS_MEMBER_A_FOR_A"

SANAA_ID=$(psql -X -A -t -d "$DB" -c "select id from restaurants where slug='sanaa-cookies';")
BYPASS_MEMBER_A_FOR_B=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$MEMBER_A_ID2'; select * from public.effective_sale_mode_field_requirements('$SANAA_ID', 'pickup');" 2>&1 | grep -c "permission denied" || true)
assert_eq "membre A appelant le helper pour B -> refusé" "1" "$BYPASS_MEMBER_A_FOR_B"

MEMBER_B_ID2="55555555-5555-5555-5555-555555555555"
psql -d "$DB" -c "insert into auth.users (id, email) values ('$MEMBER_B_ID2', 'member-b2@test.com') on conflict do nothing;" >/dev/null
psql -d "$DB" -c "insert into restaurant_users (user_id, restaurant_id, role) select '$MEMBER_B_ID2', id, 'owner' from restaurants where slug='sanaa-cookies' on conflict do nothing;" >/dev/null
BYPASS_MEMBER_B_FOR_A=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$MEMBER_B_ID2'; select * from public.effective_sale_mode_field_requirements('$ILLICO_ID', 'pickup');" 2>&1 | grep -c "permission denied" || true)
assert_eq "membre B appelant le helper pour A -> refusé" "1" "$BYPASS_MEMBER_B_FOR_A"

UNAFFILIATED_ID2="66666666-6666-6666-6666-666666666666"
psql -d "$DB" -c "insert into auth.users (id, email) values ('$UNAFFILIATED_ID2', 'unaffiliated2@test.com') on conflict do nothing;" >/dev/null
BYPASS_UNAFFILIATED=$(psql -d "$DB" -c "set role authenticated; set local test.uid='$UNAFFILIATED_ID2'; select * from public.effective_sale_mode_field_requirements('$ILLICO_ID', 'pickup');" 2>&1 | grep -c "permission denied" || true)
assert_eq "utilisateur authentifié non affilié appelant le helper -> refusé" "1" "$BYPASS_UNAFFILIATED"

log "=== L2A2-01 : les flux contrôlés continuent de fonctionner malgré le retrait total du GRANT ==="
RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'pickup', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Karim\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "create_order fonctionne toujours (appel interne SECURITY DEFINER autorisé malgré le retrait du GRANT)" "0" "$RC"
PUB_STILL_WORKS=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_field_requirements('$ILLICO_ID', 'pickup');")
assert_eq "la projection publique fonctionne toujours (appel interne autorisé)" "3" "$PUB_STILL_WORKS"

log "=== L2A2-02 (contre-audit Work, 3e tour) : la projection publique vérifie désormais que le mode est réellement activé pour l'établissement ==="
PUB_ENABLED=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_field_requirements('$ILLICO_ID', 'pickup');")
assert_eq "actif + mode activé -> retourne les règles" "3" "$PUB_ENABLED"
psql -d "$DB" -c "update restaurant_sale_modes set enabled=false where restaurant_id='$ILLICO_ID' and mode_code='pickup';" >/dev/null
PUB_DISABLED=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_field_requirements('$ILLICO_ID', 'pickup');")
assert_eq "actif + mode DÉSACTIVÉ -> aucun résultat (ne doit plus exposer les anciennes règles)" "0" "$PUB_DISABLED"
psql -d "$DB" -c "update restaurant_sale_modes set enabled=true where restaurant_id='$ILLICO_ID' and mode_code='pickup';" >/dev/null
PUB_ABSENT=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_field_requirements('$ILLICO_ID', 'delivery');")
assert_eq "actif + mode ABSENT de restaurant_sale_modes (jamais configuré) -> aucun résultat" "0" "$PUB_ABSENT"
psql -d "$DB" -c "update restaurants set status='onboarding' where slug='illico-presto';" >/dev/null
PUB_ONBOARDING2=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_field_requirements('$ILLICO_ID', 'pickup');")
assert_eq "onboarding + mode activé -> aucun résultat" "0" "$PUB_ONBOARDING2"
psql -d "$DB" -c "update restaurants set status='suspended' where slug='illico-presto';" >/dev/null
PUB_SUSPENDED2=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_field_requirements('$ILLICO_ID', 'pickup');")
assert_eq "suspendu + mode activé -> aucun résultat" "0" "$PUB_SUSPENDED2"
psql -d "$DB" -c "update restaurants set status='active', is_active=false where slug='illico-presto';" >/dev/null
PUB_INACTIVE2=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_field_requirements('$ILLICO_ID', 'pickup');")
assert_eq "inactif + mode activé -> aucun résultat" "0" "$PUB_INACTIVE2"
psql -d "$DB" -c "update restaurants set is_active=true, status='active' where slug='illico-presto';" >/dev/null

log "=== L2A1-02 : contrainte d'intégrité one_of <-> one_of_group (8 scénarios exacts) ==="
RC=$(psql -d "$DB" -c "insert into sale_mode_field_requirements (mode_code, field, requirement, one_of_group) values ('table', 'l2a1_t1', 'one_of', null);" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "one_of + groupe NULL refusé" "1" "$RC"
RC=$(psql -d "$DB" -c "insert into sale_mode_field_requirements (mode_code, field, requirement, one_of_group) values ('table', 'l2a1_t2', 'one_of', '');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "one_of + groupe vide refusé" "1" "$RC"
RC=$(psql -d "$DB" -c "insert into sale_mode_field_requirements (mode_code, field, requirement, one_of_group) values ('table', 'l2a1_t3', 'one_of', '   ');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "one_of + groupe uniquement espaces refusé" "1" "$RC"
RC=$(psql -d "$DB" -c "insert into sale_mode_field_requirements (mode_code, field, requirement, one_of_group) values ('table', 'l2a1_t4', 'required', 'x');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "required + groupe non-null refusé" "1" "$RC"
RC=$(psql -d "$DB" -c "insert into sale_mode_field_requirements (mode_code, field, requirement, one_of_group) values ('table', 'l2a1_t5', 'optional', 'x');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "optional + groupe non-null refusé" "1" "$RC"
RC=$(psql -d "$DB" -c "insert into sale_mode_field_requirements (mode_code, field, requirement, one_of_group) values ('table', 'l2a1_t6', 'one_of', 'grp_valid');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "one_of valide accepté" "0" "$RC"
RC=$(psql -d "$DB" -c "insert into sale_mode_field_requirements (mode_code, field, requirement) values ('table', 'l2a1_t7', 'required');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "required valide accepté" "0" "$RC"
RC=$(psql -d "$DB" -c "insert into sale_mode_field_requirements (mode_code, field, requirement) values ('table', 'l2a1_t8', 'optional');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "optional valide accepté" "0" "$RC"
psql -d "$DB" -c "delete from sale_mode_field_requirements where field like 'l2a1_t%';" >/dev/null

log "=== L2A-04 : résolveur générique -- groupe one_of avec un nom DIFFÉRENT de 'contact', jamais codé en dur ==="
psql -d "$DB" -c "insert into sale_mode_field_requirements (mode_code, field, requirement, one_of_group, display_order) values ('room_service', 'phone', 'one_of', 'reachability', 5) on conflict do nothing;" >/dev/null
RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'room_service', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"X\",\"room_number\":\"401\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "groupe one_of 'reachability' (jamais vu dans le code) : room+phone accepté" "0" "$RC"
RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'room_service', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"X\",\"room_number\":\"402\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "groupe one_of 'reachability' : room seul sans phone/email refusé" "1" "$RC"

log "=== L2A-05 : GRANT SELECT explicite sur order_delivery_address (RLS seule insuffisante) ==="
GRANT_CHECK=$(psql -X -A -t -d "$DB" -c "select count(*) from information_schema.role_table_grants where table_name='order_delivery_address' and grantee='authenticated' and privilege_type='SELECT';")
assert_eq "GRANT SELECT explicite présent pour authenticated" "1" "$GRANT_CHECK"
GRANT_ANON_ABSENT=$(psql -X -A -t -d "$DB" -c "select count(*) from information_schema.role_table_grants where table_name='order_delivery_address' and grantee='anon';")
assert_eq "aucun GRANT pour anon (adresse jamais publique)" "0" "$GRANT_ANON_ABSENT"


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

log "=== ROLLBACK : refus explicite si commande incompatible, puis succès + réapplication sur environnement propre ==="
DB_RB="scanym_v82_rb_$$"
build_baseline "$DB_RB"
psql -d "$DB_RB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
pass "rollback: LOT 2A appliquée sur environnement dédié (3 établissements réels + défaut)"

psql -d "$DB_RB" -c "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order) select id, 'click_collect', true, 3 from restaurants where slug='illico-presto';" >/dev/null
RB_ITEM=$(psql -X -A -t -d "$DB_RB" -c "select mi.id from menu_items mi join menu_categories mc on mc.id=mi.category_id join restaurants r on r.id=mc.restaurant_id where r.slug='illico-presto' and mi.is_available and mc.is_active limit 1;")
psql -d "$DB_RB" -c "select public.create_order('illico-presto', 'click_collect', '[{\"menu_item_id\":\"$RB_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"X\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr');" >/dev/null

RC=$(psql -d "$DB_RB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-rollback.sql" >/dev/null 2>/tmp/l2a_rb_err_$$.txt && echo "0" || echo "1")
assert_eq "rollback refusé -- commande click_collect existante incompatible" "1" "$RC"
BLOCKED_REPORT=$(grep -c "SCANYM_ROLLBACK_BLOCKED" /tmp/l2a_rb_err_$$.txt || true)
assert_eq "rapport de blocage explicite émis" "1" "$BLOCKED_REPORT"
rm -f "/tmp/l2a_rb_err_$$.txt"

psql -d "$DB_RB" -c "delete from orders where restaurant_id=(select id from restaurants where slug='illico-presto') and service_mode='click_collect';" >/dev/null
psql -d "$DB_RB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-rollback.sql" >/dev/null
pass "rollback: réussi après retrait de la commande bloquante"
CONSTRAINT_RESTORED=$(psql -X -A -t -d "$DB_RB" -c "select pg_get_constraintdef(oid) from pg_constraint where conname='orders_service_mode_check';")
assert_eq "rollback: contrainte historique restaurée à l'identique" "CHECK ((service_mode = ANY (ARRAY['table'::text, 'pickup'::text, 'delivery'::text])))" "$CONSTRAINT_RESTORED"
TABLES_GONE=$(psql -X -A -t -d "$DB_RB" -c "select count(*) from pg_tables where tablename in ('sale_mode_catalog','restaurant_sale_modes','sale_mode_field_requirements','restaurant_sale_mode_field_requirements','order_delivery_address');")
assert_eq "rollback: les 5 tables LOT 2A n'existent plus" "0" "$TABLES_GONE"
psql -d "$DB_RB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
pass "rollback: réapplication propre réussie après annulation"

log "=== L2A-06 : préflight rollback bloque AUSSI une commande incompatible PURGÉE (pas d'échappement possible pour orders_service_mode_check) ==="
psql -d "$DB_RB" -c "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order) select id, 'click_collect', true, 3 from restaurants where slug='illico-presto';" >/dev/null
RB_ITEM2=$(psql -X -A -t -d "$DB_RB" -c "select mi.id from menu_items mi join menu_categories mc on mc.id=mi.category_id join restaurants r on r.id=mc.restaurant_id where r.slug='illico-presto' and mi.is_available and mc.is_active limit 1;")
psql -d "$DB_RB" -c "select public.create_order('illico-presto', 'click_collect', '[{\"menu_item_id\":\"$RB_ITEM2\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"X\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr');" >/dev/null
psql -d "$DB_RB" -c "update orders set personal_data_purged=true, customer_name=null, customer_phone=null, customer_email=null where service_mode='click_collect';" >/dev/null

RC=$(psql -d "$DB_RB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-rollback.sql" >/dev/null 2>/tmp/l2a_rb_purged_err_$$.txt && echo "0" || echo "1")
assert_eq "rollback refusé -- commande click_collect PURGÉE incompatible (L2A-06)" "1" "$RC"
PURGED_MENTIONED=$(grep -c "données personnelles purgées" /tmp/l2a_rb_purged_err_$$.txt || true)
assert_eq "le rapport de blocage identifie explicitement la commande comme purgée" "1" "$PURGED_MENTIONED"
rm -f "/tmp/l2a_rb_purged_err_$$.txt"

psql -d "$DB_RB" -c "delete from orders where restaurant_id=(select id from restaurants where slug='illico-presto') and service_mode='click_collect';" >/dev/null
psql -d "$DB_RB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-rollback.sql" >/dev/null
pass "rollback: réussi après retrait de la commande purgée bloquante (aucune mutation partielle lors du refus précédent)"

psql -c "drop database if exists \"$DB_RB\";" >/dev/null 2>&1 || true

log "=== RÉSULTAT FINAL : $PASS_COUNT réussis, $FAIL_COUNT échoués ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "DES VÉRIFICATIONS LOT 2A ONT ÉCHOUÉ"
  exit 1
fi
echo "TOUTES LES VÉRIFICATIONS LOT 2A ONT RÉUSSI"
