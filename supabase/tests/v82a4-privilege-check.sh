#!/usr/bin/env bash
# ============================================================
# Scanym LOT 2A.4 — Harnais reproductible : durcissement des
# privilèges (SEC-2A3-01). Vérifie les privilèges EFFECTIFS
# (has_table_privilege), pas seulement information_schema, sur les 5
# tables créées par LOT 2A, après simulation du finding Production
# réel (GRANT ALL artificiel, puisqu'un CREATE TABLE local ordinaire
# ne reproduit pas le mécanisme de privilèges par défaut suspecté côté
# plateforme Supabase).
#
# Baseline : LOT 1B.2 (vrai main) + LOT 2A/2A.1/2A.2/2A.3 appliquées.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/v82a4-privilege-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DB="scanym_v82a4_priv_$$"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
FAIL_LOG="/tmp/scanym-lot2a4-fails-$$.log"
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
  psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null 2>&1
}

TABLES="sale_mode_catalog restaurant_sale_modes sale_mode_field_requirements restaurant_sale_mode_field_requirements order_delivery_address"
ROLES="public anon authenticated"

check_no_excessive_privileges() {
  local db="$1" label="$2"
  for t in $TABLES; do
    for r in $ROLES; do
      for p in TRUNCATE REFERENCES TRIGGER INSERT UPDATE DELETE; do
        v=$(psql -X -A -t -d "$db" -c "select has_table_privilege('$r', 'public.$t', '$p');")
        assert_eq "$label: $t / $r / $p = false" "f" "$v"
      done
    done
  done
}

log "=== Construction de la baseline réelle (LOT 1B.2 + LOT 2A.3 installé) ==="
build_baseline "$DB"
pass "chaîne réelle appliquée jusqu'à LOT 2A.3 (5 tables créées, confirmées présentes)"

log "=== SIMULATION du finding Production réel (SEC-2A3-01) -- GRANT ALL artificiel ==="
for t in $TABLES; do
  psql -d "$DB" -c "grant all on public.$t to public, anon, authenticated;" >/dev/null
done
BEFORE_TRUNC=$(psql -X -A -t -d "$DB" -c "select has_table_privilege('anon', 'public.restaurant_sale_modes', 'TRUNCATE');")
assert_eq "précondition : le problème simulé est bien présent avant correctif" "t" "$BEFORE_TRUNC"

log "=== Application de migration-v83-lot2a4-privilege-hardening.sql ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
pass "migration LOT 2A.4 appliquée sans erreur"

log "=== Audit systématique des privilèges EFFECTIFS (has_table_privilege, pas information_schema) ==="
check_no_excessive_privileges "$DB" "L2A.4"

log "=== Confirmation des privilèges SELECT minimaux réellement nécessaires, préservés ==="
assert_eq "anon peut lire sale_mode_catalog (référence globale)" "t" "$(psql -X -A -t -d "$DB" -c "select has_table_privilege('anon', 'public.sale_mode_catalog', 'SELECT');")"
assert_eq "authenticated peut lire sale_mode_catalog" "t" "$(psql -X -A -t -d "$DB" -c "select has_table_privilege('authenticated', 'public.sale_mode_catalog', 'SELECT');")"
assert_eq "anon peut lire sale_mode_field_requirements (référence globale)" "t" "$(psql -X -A -t -d "$DB" -c "select has_table_privilege('anon', 'public.sale_mode_field_requirements', 'SELECT');")"
assert_eq "authenticated peut lire restaurant_sale_modes (Dashboard, filtré par RLS)" "t" "$(psql -X -A -t -d "$DB" -c "select has_table_privilege('authenticated', 'public.restaurant_sale_modes', 'SELECT');")"
assert_eq "anon NE PEUT PAS lire restaurant_sale_modes (table tenant privée)" "f" "$(psql -X -A -t -d "$DB" -c "select has_table_privilege('anon', 'public.restaurant_sale_modes', 'SELECT');")"
assert_eq "authenticated peut lire order_delivery_address (Dashboard staff, filtré par RLS)" "t" "$(psql -X -A -t -d "$DB" -c "select has_table_privilege('authenticated', 'public.order_delivery_address', 'SELECT');")"
assert_eq "anon NE PEUT PAS lire order_delivery_address (jamais publique)" "f" "$(psql -X -A -t -d "$DB" -c "select has_table_privilege('anon', 'public.order_delivery_address', 'SELECT');")"

log "=== Non-régression fonctionnelle complète après durcissement ==="
ILLICO_ITEM=$(psql -X -A -t -d "$DB" -c "select mi.id from menu_items mi join menu_categories mc on mc.id=mi.category_id join restaurants r on r.id=mc.restaurant_id where r.slug='illico-presto' and mi.is_available and mc.is_active limit 1;")
ILLICO_ID=$(psql -X -A -t -d "$DB" -c "select id from restaurants where slug='illico-presto';")

RC=$(psql -d "$DB" -c "select public.create_order('illico-presto', 'pickup', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Karim\"}'::jsonb, null, 'fr');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "create_order fonctionne toujours après durcissement" "0" "$RC"

PUB_WORKS=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_sale_modes('$ILLICO_ID');")
assert_eq "projection publique get_restaurant_public_sale_modes fonctionne toujours" "2" "$PUB_WORKS"

PUB_FIELDS_WORKS=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select count(*) from public.get_restaurant_public_field_requirements('$ILLICO_ID', 'pickup');")
assert_eq "projection publique get_restaurant_public_field_requirements fonctionne toujours" "3" "$PUB_FIELDS_WORKS"

HELPER_DENIED=$(PGOPTIONS='-c role=anon' psql -d "$DB" -c "select * from public.effective_sale_mode_field_requirements('$ILLICO_ID', 'pickup');" 2>&1 | grep -c "permission denied" || true)
assert_eq "helper interne toujours totalement inaccessible (L2A2-01 préservé)" "1" "$HELPER_DENIED"

RLS_DENIED=$(PGOPTIONS='-c role=anon' psql -d "$DB" -c "select count(*) from restaurant_sale_modes;" 2>&1 | grep -c "permission denied" || true)
assert_eq "anon ne peut toujours pas lire restaurant_sale_modes directement (RLS tenant préservée)" "1" "$RLS_DENIED"

MEMBER_ID="77777777-7777-7777-7777-777777777777"
psql -d "$DB" -c "insert into auth.users (id, email) values ('$MEMBER_ID', 'member@test.com') on conflict do nothing;" >/dev/null
psql -d "$DB" -c "insert into restaurant_users (user_id, restaurant_id, role) select '$MEMBER_ID', id, 'owner' from restaurants where slug='illico-presto' on conflict do nothing;" >/dev/null
SANAA_ID=$(psql -X -A -t -d "$DB" -c "select id from restaurants where slug='sanaa-cookies';")
MEMBER_READS_OTHER=$(psql -X -A -t -d "$DB" -c "set role authenticated; set local test.uid='$MEMBER_ID'; select count(*) from restaurant_sale_modes where restaurant_id='$SANAA_ID';" | tail -1)
assert_eq "isolation tenant toujours respectée après durcissement (membre A ne lit pas B)" "0" "$MEMBER_READS_OTHER"

psql -d "$DB" -c "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order) select id, 'room_service', true, 4 from restaurants where slug='illico-presto' on conflict do nothing;" >/dev/null
psql -d "$DB" -c "select public.create_order('illico-presto', 'room_service', '[{\"menu_item_id\":\"$ILLICO_ITEM\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"X\",\"room_number\":\"305\"}'::jsonb, null, 'fr');" >/dev/null
PERSISTED_ROOM=$(psql -X -A -t -d "$DB" -c "select room_number from orders where service_mode='room_service' order by created_at desc limit 1;")
assert_eq "room_number toujours persisté correctement (L2A-02 préservé)" "305" "$PERSISTED_ROOM"

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

log "=== Réapplication idempotente : rejouer LOT 2A.4 sur un état déjà corrigé ne doit provoquer aucune erreur ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
pass "réapplication idempotente de LOT 2A.4 réussie sans erreur"
check_no_excessive_privileges "$DB" "L2A.4 (après réapplication)"

log "=== RÉSULTAT FINAL : $PASS_COUNT réussis, $FAIL_COUNT échoués ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "DES VÉRIFICATIONS LOT 2A.4 ONT ÉCHOUÉ"
  exit 1
fi
echo "TOUTES LES VÉRIFICATIONS LOT 2A.4 ONT RÉUSSI"
